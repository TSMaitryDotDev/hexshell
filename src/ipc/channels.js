'use strict';

/**
 * Centralized IPC channel names.
 *
 * Keeping these in one module means the main process, preload bridge, and
 * renderer cannot drift apart over time. Every channel is namespaced
 * (`terminal:*`) and the set is frozen so accidental mutation throws.
 *
 * Direction in comments is from the renderer's point of view:
 *   →  renderer -> main  (ipcRenderer.send)
 *   ←  main -> renderer  (webContents.send)
 */
const Channels = Object.freeze({
  // → spawn the PTY once the renderer knows its real cols/rows
  TERM_SPAWN:   'terminal:spawn',
  // → user keystrokes / paste data from xterm
  TERM_WRITE:   'terminal:write',
  // ← PTY stdout/stderr stream coming back to xterm
  TERM_DATA:    'terminal:data',
  // → renderer-initiated resize
  TERM_RESIZE:  'terminal:resize',
  // ← PTY child exited (renderer can show a "session ended" notice)
  TERM_EXIT:    'terminal:exit',
  // → explicit kill request (e.g. before window close)
  TERM_KILL:    'terminal:kill',
  // ← UI-only event: shell asks the renderer to play a sound
  //   payload: { kind: 'error' | 'bell' | 'process-start' | 'process-stop' }
  TERM_BELL:    'terminal:bell',
  // → ask main for a structured sysinfo payload (used by the OS splash)
  WIN_SYSINFO:  'window:sysinfo',

  // window-control channels (renderer-driven shortcuts that need main work)
  WIN_QUIT:        'window:quit',
  WIN_RELOAD:      'window:reload',
  WIN_TOGGLE_FULL: 'window:toggle-fullscreen',
  WIN_MINIMIZE:    'window:minimize',
  WIN_CLOSE:       'window:close',
  // ← main asks the renderer to play the CRT shutdown animation; the
  //   renderer follows up with WIN_QUIT once the animation finishes.
  WIN_REQUEST_SHUTDOWN: 'window:request-shutdown',
  // → take a screenshot via the system's screenshot tool
  WIN_SCREENSHOT:  'window:screenshot',
  // → write text to the X11/Wayland PRIMARY selection (auto-copy on
  //   selection); separate from the regular clipboard so middle-click
  //   paste behaves like real terminals.
  WIN_PRIMARY:     'window:primary-write',
  // ↔ read text from the PRIMARY selection (used for middle-click paste).
  WIN_PRIMARY_READ:'window:primary-read'
});

module.exports = Channels;
