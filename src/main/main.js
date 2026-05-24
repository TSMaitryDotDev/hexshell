'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, shell, clipboard } = require('electron');
const path = require('path');
const Channels = require('../ipc/channels');
const { HexShell } = require('./shell/hexsh');
const { takeScreenshot } = require('./screenshot');

// ---------------------------------------------------------------------------
// Hardening flags
// ---------------------------------------------------------------------------

app.setName('Hexshell');

// Allow the renderer to play the startup chime without a user gesture.
// Chromium blocks autoplay by default; in Electron the standard escape
// hatch is this command-line switch. We do this BEFORE app.whenReady() so
// it takes effect for the first webContents we create.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {HexShell | null} */
let hexsh = null;
/** Last known terminal size from the renderer; used by Executor when spawning. */
let lastSize = { cols: 100, rows: 30 };

function createWindow() {
  mainWindow = new BrowserWindow({
    show: false,
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    title: 'Hexshell',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      enableRemoteModule: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => {
    disposeShell();
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// ---------------------------------------------------------------------------
// Shell <-> renderer wiring
// ---------------------------------------------------------------------------

function makeSender(win) {
  return (channel, payload) => {
    if (!win || win.isDestroyed()) return;
    if (!win.webContents || win.webContents.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };
}

function ensureShell() {
  if (hexsh) return hexsh;
  if (!mainWindow) return null;
  const send = makeSender(mainWindow);
  const emit = (data) => send(Channels.TERM_DATA, data);
  const getSize = () => ({ cols: lastSize.cols, rows: lastSize.rows });
  const bell = (kind) => send(Channels.TERM_BELL, { kind: String(kind || 'bell') });
  hexsh = new HexShell(emit, getSize, bell);
  hexsh.start();
  return hexsh;
}

function disposeShell() {
  if (hexsh) {
    try { hexsh.shutdown(); } catch (_) {}
    hexsh = null;
  }
}

function registerIpc() {
  // Renderer asks us to "spawn" once it knows real cols/rows. There is no
  // PTY to spawn anymore — we just record the size and start hexsh.
  ipcMain.on(Channels.TERM_SPAWN, (event, opts) => {
    if (!isFromMainWindow(event)) return;
    if (opts && Number.isFinite(opts.cols) && Number.isFinite(opts.rows)) {
      lastSize = { cols: opts.cols, rows: opts.rows };
    }
    ensureShell();
  });

  ipcMain.on(Channels.TERM_WRITE, (event, data) => {
    if (!isFromMainWindow(event)) return;
    if (typeof data !== 'string') return;
    if (!hexsh) return;
    hexsh.feed(data);
  });

  ipcMain.on(Channels.TERM_RESIZE, (event, dims) => {
    if (!isFromMainWindow(event)) return;
    if (!dims) return;
    const cols = Number(dims.cols);
    const rows = Number(dims.rows);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    lastSize = { cols, rows };
    if (hexsh) hexsh.resize(cols, rows);
  });

  ipcMain.on(Channels.TERM_KILL, (event) => {
    if (!isFromMainWindow(event)) return;
    disposeShell();
  });

  ipcMain.on(Channels.WIN_QUIT, (event) => {
    if (!isFromMainWindow(event)) return;
    app.quit();
  });

  ipcMain.on(Channels.WIN_RELOAD, (event) => {
    if (!isFromMainWindow(event)) return;
    if (mainWindow) {
      disposeShell();
      mainWindow.webContents.reloadIgnoringCache();
    }
  });

  ipcMain.on(Channels.WIN_TOGGLE_FULL, (event) => {
    if (!isFromMainWindow(event)) return;
    if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });

  ipcMain.on(Channels.WIN_MINIMIZE, (event) => {
    if (!isFromMainWindow(event)) return;
    if (!mainWindow) return;
    // Linux WMs refuse to minimize a fullscreen window. Drop fullscreen
    // first, then minimize. When the user restores from the taskbar we
    // leave the window in plain restored state — they can press F11 or
    // hit the maximize button to go fullscreen again.
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
    mainWindow.minimize();
  });

  ipcMain.on(Channels.WIN_CLOSE, (event) => {
    if (!isFromMainWindow(event)) return;
    if (!mainWindow) { app.quit(); return; }
    // Same path users get by hitting Ctrl+Shift+Q: emits 'before-quit',
    // which disposes the shell cleanly through our existing handler.
    mainWindow.close();
  });

  // Screenshot. We use ipcMain.handle so the renderer can await the result
  // and flash a status message (success path: tool name + saved file when
  // applicable; failure path: a hint to install one).
  ipcMain.handle(Channels.WIN_SCREENSHOT, (event) => {
    if (!isFromMainWindow(event)) return { ok: false, error: 'denied' };
    return takeScreenshot();
  });

  // Sysinfo: returns the same structured object the `sys` builtin uses,
  // so the OS splash overlay can render with real data.
  ipcMain.handle(Channels.WIN_SYSINFO, (event) => {
    if (!isFromMainWindow(event)) return null;
    if (!hexsh) return null;
    try {
      const sysinfo = require('./shell/sysinfo');
      // Lift the env reference off HexShell — same source of truth.
      // hexsh._env is the live Env instance (cwd, cols, rows, etc.).
      return sysinfo.gather(hexsh._env);
    } catch (_) { return null; }
  });

  // PRIMARY selection write — Linux's "select text → middle-click paste"
  // convention. `clipboard.writeText(text, 'selection')` writes to the
  // X11 PRIMARY / Wayland primary buffer, which is independent of the
  // regular CLIPBOARD that Ctrl+C/V uses. On platforms without the
  // selection clipboard (macOS, Windows) Electron silently no-ops.
  ipcMain.on(Channels.WIN_PRIMARY, (event, text) => {
    if (!isFromMainWindow(event)) return;
    if (typeof text !== 'string' || text.length === 0) return;
    try { clipboard.writeText(text, 'selection'); } catch (_) {}
  });

  // PRIMARY selection read — middle-click paste path. We return a string
  // so the renderer can immediately forward it to the shell.
  ipcMain.handle(Channels.WIN_PRIMARY_READ, (event) => {
    if (!isFromMainWindow(event)) return '';
    try { return clipboard.readText('selection') || ''; }
    catch (_) { return ''; }
  });
}

function isFromMainWindow(event) {
  return mainWindow && event.sender === mainWindow.webContents;
}

// ---------------------------------------------------------------------------
// Global shortcuts
// ---------------------------------------------------------------------------

function registerShortcuts() {
  globalShortcut.register('F11', () => {
    if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    // Ask the renderer to play the CRT shutdown animation, which calls
    // back via WIN_QUIT once it's done. If there's no main window the
    // renderer can't run anything, so fall back to a direct quit.
    if (mainWindow && !mainWindow.isDestroyed()) {
      const send = makeSender(mainWindow);
      send(Channels.WIN_REQUEST_SHUTDOWN);
    } else {
      app.quit();
    }
  });
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    if (!mainWindow) return;
    disposeShell();
    mainWindow.webContents.reloadIgnoringCache();
  });
  // Screenshot. Same pattern as the renderer-side keybinding: triggers
  // the system screenshot tool through our detection module.
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    if (!mainWindow) return;
    const result = takeScreenshot();
    // Echo the result to the renderer so the HUD can flash a notice.
    // Best-effort: if main can't reach renderer (rare), the user still
    // sees the screenshot tool's own UI/notification.
    const send = makeSender(mainWindow);
    send(Channels.WIN_SCREENSHOT, result);
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  registerShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  disposeShell();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
