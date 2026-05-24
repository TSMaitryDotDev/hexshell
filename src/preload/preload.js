'use strict';

/**
 * Preload bridge.
 *
 * This is the only file that touches both Electron internals and the
 * renderer's window object. It exposes a tightly-scoped, validated API as
 * `window.hexshell`. The renderer never sees `ipcRenderer`, `require`, or
 * any Node primitives, which is the whole point of contextIsolation.
 *
 * Design rules:
 *   - Every outgoing call validates its arguments. Garbage in, no IPC out.
 *   - Every incoming subscription returns an `unsubscribe` function so the
 *     renderer can deterministically clean up listeners (no memory leaks).
 *   - We expose *functions*, not the channel strings, so the renderer can
 *     never invent new channels.
 */

const { contextBridge, ipcRenderer } = require('electron');
const Channels = require('../ipc/channels');

// Read the version once at preload time so the renderer can show it
// without an IPC round-trip. Falls back gracefully if anything goes
// wrong (asar layout shift, packaging weirdness).
let APP_VERSION = '0.0.0';
try { APP_VERSION = require('../../package.json').version || APP_VERSION; }
catch (_) { /* keep fallback */ }

// Internal helper: subscribe to a channel and return an unsubscribe handle.
function on(channel, listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }
  // Strip the IpcRendererEvent before handing data to the renderer; the event
  // object leaks references that have no business in renderer code.
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = Object.freeze({
  /** App version, read once from package.json at preload time. */
  version: APP_VERSION,

  /**
   * Spawn the PTY. Call this once after FitAddon has computed real cols/rows.
   * Subsequent calls are no-ops on the main side.
   * @param {{cols:number, rows:number}} dims
   */
  spawn(dims) {
    if (!dims || typeof dims !== 'object') return;
    const cols = Number(dims.cols);
    const rows = Number(dims.rows);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    ipcRenderer.send(Channels.TERM_SPAWN, { cols, rows });
  },

  /**
   * Send keystrokes / pasted text to the shell.
   * @param {string} data
   */
  write(data) {
    if (typeof data !== 'string' || data.length === 0) return;
    ipcRenderer.send(Channels.TERM_WRITE, data);
  },

  /**
   * Resize the PTY.
   * @param {{cols:number, rows:number}} dims
   */
  resize(dims) {
    if (!dims || typeof dims !== 'object') return;
    const cols = Math.floor(Number(dims.cols));
    const rows = Math.floor(Number(dims.rows));
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    if (cols < 1 || rows < 1) return;
    ipcRenderer.send(Channels.TERM_RESIZE, { cols, rows });
  },

  /** Tell main to tear down the PTY (e.g. before reload). */
  kill() {
    ipcRenderer.send(Channels.TERM_KILL);
  },

  /**
   * Subscribe to PTY stdout/stderr.
   * @param {(chunk:string)=>void} listener
   * @returns {()=>void} unsubscribe
   */
  onData(listener) {
    return on(Channels.TERM_DATA, (payload) => {
      if (typeof payload === 'string') listener(payload);
    });
  },

  /**
   * Subscribe to PTY exit.
   * @param {(info:{exitCode:number, signal?:number})=>void} listener
   * @returns {()=>void} unsubscribe
   */
  onExit(listener) {
    return on(Channels.TERM_EXIT, (payload) => {
      if (payload && typeof payload === 'object') listener(payload);
    });
  },

  /**
   * Subscribe to "bell" events emitted by the shell. Used to play the
   * command-error chime and similar UI feedback. The renderer decides
   * what (if anything) to do for each kind.
   * @param {(info:{kind:string})=>void} listener
   * @returns {()=>void} unsubscribe
   */
  onBell(listener) {
    return on(Channels.TERM_BELL, (payload) => {
      if (payload && typeof payload === 'object') listener(payload);
    });
  },

  // Window controls (mostly used by renderer-side keybindings as backup).
  quit()           { ipcRenderer.send(Channels.WIN_QUIT); },
  reload()         { ipcRenderer.send(Channels.WIN_RELOAD); },
  toggleFullscreen() { ipcRenderer.send(Channels.WIN_TOGGLE_FULL); },
  minimize()       { ipcRenderer.send(Channels.WIN_MINIMIZE); },
  close()          { ipcRenderer.send(Channels.WIN_CLOSE); },

  /**
   * Take a screenshot via the system screenshot tool.
   * Returns a promise resolving to {ok, tool?, file?, error?}.
   */
  screenshot() {
    return ipcRenderer.invoke(Channels.WIN_SCREENSHOT);
  },

  /**
   * Pull the structured system info (same data the `sys` builtin gathers).
   * Returns a promise resolving to the sysinfo object.
   */
  sysinfo() {
    return ipcRenderer.invoke(Channels.WIN_SYSINFO);
  },

  /**
   * Linux PRIMARY selection helpers. PRIMARY is the buffer that holds
   * "currently selected text"; middle-click pastes from it. It's
   * independent of the regular CLIPBOARD (which Ctrl+C/V uses).
   *
   * primaryWrite() is fire-and-forget: validate input here, drop on
   * the floor in main if the OS doesn't support it.
   * primaryRead() returns a Promise<string>; empty string on failure.
   */
  primaryWrite(text) {
    if (typeof text !== 'string' || text.length === 0) return;
    ipcRenderer.send(Channels.WIN_PRIMARY, text);
  },
  primaryRead() {
    return ipcRenderer.invoke(Channels.WIN_PRIMARY_READ);
  },

  /**
   * Subscribe to screenshot results pushed from main (used when the
   * GLOBAL shortcut path triggers a capture, since that goes the other
   * direction).
   */
  onScreenshot(listener) {
    return on(Channels.WIN_SCREENSHOT, (payload) => {
      if (payload && typeof payload === 'object') listener(payload);
    });
  },

  /**
   * Subscribe to "please play the CRT shutdown then quit" requests
   * pushed from main (e.g. when the global Ctrl+Shift+Q shortcut fires
   * while Hexshell isn't focused).
   */
  onShutdownRequest(listener) {
    return on(Channels.WIN_REQUEST_SHUTDOWN, () => listener());
  }
});

contextBridge.exposeInMainWorld('hexshell', api);
