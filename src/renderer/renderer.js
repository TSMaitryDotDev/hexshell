'use strict';

/* global Terminal, FitAddon, WebLinksAddon */

/**
 * Renderer entry point.
 *
 * Responsibilities:
 *   - boot xterm.js and addons
 *   - wire xterm <-> preload bridge (window.hexshell)
 *   - manage resize via ResizeObserver, coalesced with rAF
 *   - clean up listeners on unload to avoid leaks across reloads
 *
 * Notes:
 *   - We never touch ipcRenderer directly; the preload exposes a tiny API.
 *   - We avoid mutating xterm internals; FitAddon owns sizing.
 */

(function bootHexshell() {
  // --------------------------------------------------------------------------
  // Retro CRT boot animation.
  //
  // Two paths:
  //   - "staged": the OS splash will auto-open. We hide the terminal/HUD
  //     so the splash plays its CRT-on alone. revealTerminal() runs the
  //     terminal's own CRT-on after the splash dismisses.
  //   - "direct": no splash to show (user disabled it, or we're in a
  //     reload). The terminal plays CRT-on immediately.
  //
  // The decision mirrors the splash gate below so the two stay in sync:
  //   stage iff splash.skipBoot pref is false AND we haven't shown a
  //   splash in this session yet.
  // --------------------------------------------------------------------------
  const SPLASH_SESSION_KEY = 'hexshell.splashShown';
  function shouldStageBoot() {
    try {
      const raw = localStorage.getItem('hexshell.prefs');
      const skip = raw && JSON.parse(raw)['splash.skipBoot'] === true;
      if (skip) return false;
      if (sessionStorage.getItem(SPLASH_SESSION_KEY)) return false;
      return true;
    } catch (_) { return false; }
  }

  const staged = shouldStageBoot();

  /**
   * Trigger the startup chime, once. Audio dispatch can run a few ms
   * before the renderer paints, but xterm.js compositor scheduling means
   * the user actually perceives them as simultaneous — exactly what we
   * want. Declared BEFORE the boot branch below because both arms call
   * it; `let` bindings respect their declaration order (TDZ), so a
   * `playStartupChime()` higher up would crash the whole IIFE.
   */
  let chimeFired = false;
  function playStartupChime() {
    if (chimeFired) return;
    chimeFired = true;
    if (window.hexAudio && typeof window.hexAudio.playStartup === 'function') {
      window.hexAudio.playStartup();
    }
  }

  if (staged) {
    document.body.classList.add('crt-staged');
    // Chime fires when the splash opens (it owns the first visual). See
    // the splash open call further down — we trigger via hexAudio there.
  } else {
    document.body.classList.add('crt-boot');
    // Direct boot: terminal CRT-on is the first visible animation.
    // Fire the chime synchronously with it. We call playStartup BEFORE
    // attaching the animationend listener so audio dispatch and the
    // animation start in the same task tick.
    playStartupChime();
    document.body.addEventListener('animationend', function onBoot(e) {
      if (e.animationName !== 'hex-crt-on') return;
      document.body.classList.remove('crt-boot');
      document.body.removeEventListener('animationend', onBoot);
    });
  }

  /**
   * Reveal the terminal/HUD with a CRT-on animation. Called by system.js
   * after the splash finishes its CRT-off. Idempotent; only runs the
   * first time it's invoked.
   */
  let revealed = !staged;
  function revealTerminal() {
    if (revealed) return;
    revealed = true;
    document.body.classList.remove('crt-staged');
    document.body.classList.add('crt-revealing');
    // Strip the class once any of the children's CRT-on finishes so
    // subsequent CSS interactions aren't fighting a stale animation.
    let firstSeen = false;
    document.body.addEventListener('animationend', function onReveal(e) {
      if (e.animationName !== 'hex-crt-on') return;
      // Multiple children fire animationend — only act on the first.
      if (firstSeen) return;
      firstSeen = true;
      document.body.classList.remove('crt-revealing');
      document.body.removeEventListener('animationend', onReveal);
    });
  }
  const api = window.hexshell;
  if (!api) {
    document.body.innerHTML =
      '<pre style="color:#ff5577;padding:2rem;font-family:monospace">' +
      'FATAL: preload bridge missing. Refusing to start.</pre>';
    return;
  }

  // -------------------------------------------------------------------------
  // Theme
  // -------------------------------------------------------------------------
  // The phosphor-green palette. Sourced from the same CSS variables we use
  // in styles/terminal.css so keeping them in sync stays one-line work.
  const theme = {
    background: '#000a06',
    foreground: '#a8ffb0',
    cursor:     '#7cffb2',
    cursorAccent: '#001b10',
    selectionBackground: 'rgba(124, 255, 178, 0.25)',

    // ANSI - tuned to look "right" against the green phosphor BG.
    black:        '#0a1410',
    red:          '#ff5577',
    green:        '#7cffb2',
    yellow:       '#f2ff7a',
    blue:         '#7ad7ff',
    magenta:      '#d59cff',
    cyan:         '#7afff0',
    white:        '#dffff0',
    brightBlack:  '#3a4a44',
    brightRed:    '#ff8aa1',
    brightGreen:  '#aaffd0',
    brightYellow: '#ffffb0',
    brightBlue:   '#aee2ff',
    brightMagenta:'#e7c2ff',
    brightCyan:   '#bdfff8',
    brightWhite:  '#ffffff'
  };

  // -------------------------------------------------------------------------
  // Terminal init
  // -------------------------------------------------------------------------
  // MesloLGL is the primary face. The fallbacks only matter if @font-face
  // ever fails to load — we still await document.fonts.ready below before
  // the first fit, so users will never see fallback metrics in practice.
  //
  // Sizing notes:
  //   xterm.js has no per-glyph scaling, so Nerd Font icon size is
  //   bound to fontSize. 15px is the sweet spot on modern Linux laptops:
  //   the cod-/dev-/md- glyphs render at full silhouette without going
  //   into "blocky" territory. lineHeight 1.25 gives icons that have a
  //   tiny descender (folder, disk) some breathing room without spacing
  //   text out unnaturally.
  const term = new Terminal({
    fontFamily: '"MesloLGL", "MesloLGS NF", "DejaVu Sans Mono", monospace',
    fontSize: 15,
    lineHeight: 1.25,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: 'block',
    cursorWidth: 2,
    scrollback: 5000,
    allowProposedApi: true,
    allowTransparency: true,
    convertEol: false,
    macOptionIsMeta: true,
    rightClickSelectsWord: true,
    smoothScrollDuration: 0, // hard-cut, predictable
    drawBoldTextInBrightColors: true,
    fastScrollModifier: 'shift',
    theme
  });

  const fit = new FitAddon.FitAddon();
  const links = new WebLinksAddon.WebLinksAddon((event, uri) => {
    // We can't shell out from the renderer; ask main via a navigation hint.
    // Simplest path: trigger the OS browser through window.open which the
    // main process intercepts and forwards via shell.openExternal().
    if (event.button === 0) window.open(uri, '_blank', 'noopener,noreferrer');
  });
  term.loadAddon(fit);
  term.loadAddon(links);

  const mount = document.getElementById('terminal');
  term.open(mount);

  // First fit must happen AFTER our webfont is fully loaded, otherwise
  // xterm.js measures the cell with the system fallback and the grid
  // visibly jumps when MesloLGL swaps in. We also wrap the measurement in
  // requestAnimationFrame so layout has settled.
  bootTerminal();

  async function bootTerminal() {
    try {
      // Wait for fonts, but cap the wait. `document.fonts.ready` is
      // supposed to resolve when every declared face has loaded or
      // failed. In practice some Chromium versions hang it indefinitely
      // if a single @font-face uses an unknown format string — and a
      // hanging boot leaves "LINK: ESTABLISHING" stuck forever.
      //
      // 500 ms is generous enough for any local-file font (Meslo + Orbitron
      // total ~10 MB and read off SSD in <50 ms) and short enough that a
      // misconfigured face never blocks the user. If the race times out,
      // the terminal still boots — xterm just measures with whatever face
      // happens to be loaded so far.
      if (document.fonts && document.fonts.ready) {
        await Promise.race([
          document.fonts.ready,
          new Promise((res) => setTimeout(res, 500))
        ]);
        try {
          await Promise.race([
            document.fonts.load('15px "MesloLGL"'),
            new Promise((res) => setTimeout(res, 250))
          ]);
        } catch (_) {}
      }
    } catch (_) { /* fall through to fit anyway */ }

    requestAnimationFrame(() => {
      safeFit();
      const dims = currentDims();
      if (dims) {
        api.spawn(dims);
        setStatus('LINK: ACTIVE', 'ok');
        setShellLabel();
      } else {
        setStatus('LINK: NO PTY DIMS', 'err');
      }
      term.focus();

      // Open the OS splash on first boot of the session. If we staged
      // the boot (terminal hidden behind splash), open with `boot:true`
      // so the splash plays its CRT-on against a black backdrop and
      // calls revealTerminal() when dismissed.
      try {
        if (staged) {
          sessionStorage.setItem(SPLASH_SESSION_KEY, '1');
          // Fire the chime right as the splash opens — its CRT-on
          // animation is what the user is about to see, so we sync
          // audio to that moment instead of the terminal reveal.
          playStartupChime();
          if (window.hexSplash && typeof window.hexSplash.open === 'function') {
            window.hexSplash.open({ boot: true });
          } else {
            // No splash module — fall through and reveal directly.
            revealTerminal();
          }
        }
      } catch (_) {
        if (staged) revealTerminal();
      }
    });
  }

  // -------------------------------------------------------------------------
  // PTY <-> xterm wiring
  // -------------------------------------------------------------------------

  // PTY -> xterm
  const offData = api.onData((chunk) => {
    term.write(chunk);
  });

  // xterm -> PTY (keystrokes & paste)
  const dataDisposable = term.onData((data) => {
    api.write(data);
  });

  // Keysound.
  // We listen on `keydown` at the window in capture phase rather than
  // term.onKey because:
  //   - keydown fires for EVERY real keypress, including ones xterm
  //     consumes for its own bindings (Ctrl+Shift+R, etc.).
  //   - it fires before xterm's data pipeline, so the click is in sync
  //     with the finger, not with the resulting PTY byte.
  //   - paste does not fire keydown, so we still get one click per key
  //     and zero clicks on Cmd/Ctrl+V text dumps.
  // We skip modifier-only events (Shift, Control, Alt, Meta on their own)
  // because users don't think of those as keystrokes.
  function onKeySound(e) {
    if (e.isComposing) return; // IME composition; the final key fires too
    const k = e.key;
    if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' ||
        k === 'CapsLock' || k === 'NumLock' || k === 'ScrollLock') {
      return;
    }
    if (window.hexAudio && typeof window.hexAudio.click === 'function') {
      window.hexAudio.click();
    }
  }
  window.addEventListener('keydown', onKeySound, true);

  // Exit notice
  const offExit = api.onExit(() => {
    setStatus('LINK: TERMINATED', 'err');
  });

  // Shell-driven UI sounds (command not found / non-zero exit / long-running
  // package commands). Main fires this; we just translate to audio calls.
  // The shell already suppresses the error bell for user-cancelled commands.
  const offBell = api.onBell(({ kind }) => {
    if (!window.hexAudio) return;
    switch (kind) {
      case 'error':
        if (typeof window.hexAudio.error === 'function') window.hexAudio.error();
        break;
      case 'process-start':
        if (typeof window.hexAudio.processStart === 'function') window.hexAudio.processStart();
        break;
      case 'process-stop':
        if (typeof window.hexAudio.processStop === 'function') window.hexAudio.processStop();
        break;
    }
  });

  // -------------------------------------------------------------------------
  // Resize handling
  // -------------------------------------------------------------------------
  // We coalesce ResizeObserver bursts with requestAnimationFrame and only
  // fire IPC when the *cell* dimensions actually change. xterm itself can
  // trigger many redundant resize attempts otherwise.

  let rafPending = false;
  let lastCols = 0;
  let lastRows = 0;

  function safeFit() {
    try { fit.fit(); } catch (_) { /* element not visible yet */ }
  }

  function currentDims() {
    // proposeDimensions is cheaper than fit() and tells us what the next
    // resize WOULD do. We use it to decide whether to send IPC.
    let proposed;
    try { proposed = fit.proposeDimensions(); } catch (_) { proposed = null; }
    if (!proposed) return null;
    const cols = Math.max(1, Math.floor(proposed.cols));
    const rows = Math.max(1, Math.floor(proposed.rows));
    return { cols, rows };
  }

  function scheduleResize() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      safeFit();
      const dims = currentDims();
      if (!dims) return;
      if (dims.cols === lastCols && dims.rows === lastRows) return;
      lastCols = dims.cols;
      lastRows = dims.rows;
      api.resize(dims);
    });
  }

  const ro = new ResizeObserver(scheduleResize);
  ro.observe(mount);

  // Window-level resize covers fullscreen toggles and external scale changes
  // that don't always retrigger the ResizeObserver in time.
  window.addEventListener('resize', scheduleResize, { passive: true });

  // -------------------------------------------------------------------------
  // Keyboard shortcuts (renderer-side, redundant with main globalShortcut)
  // -------------------------------------------------------------------------
  // Why duplicate? globalShortcut takes effect even when Hexshell isn't
  // focused, which can be surprising. The renderer-level handler is the
  // user-friendly "while I'm using the terminal" path and feels instant.
  // We attach it as a *capture* listener so it wins over xterm.

  /**
   * Play the CRT shutdown animation, THEN tell main to actually close
   * the window. We wait for the animationend event so users see the
   * full collapse-to-dot effect before the window goes away. If anything
   * blocks the animation (browser tab paused, prefs etc.) we hard-fall
   * to api.quit() after a 1.2s safety timeout so the app never hangs.
   *
   * Idempotent: rapid double-presses won't stack the animation or fire
   * api.quit() twice.
   */
  let shutdownInFlight = false;
  function shutdownWithCrt() {
    if (shutdownInFlight) return;
    shutdownInFlight = true;
    document.body.classList.add('crt-shutdown');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { api.quit(); } catch (_) {}
    };
    document.body.addEventListener('animationend', function onOff(e) {
      if (e.animationName !== 'hex-crt-off' &&
          e.animationName !== 'hex-crt-fade-out') return;
      document.body.removeEventListener('animationend', onOff);
      finish();
    });
    // Safety net: if for any reason animationend never fires, still quit.
    setTimeout(finish, 1200);
  }

  function onKey(e) {
    const ctrlShift = (e.ctrlKey || e.metaKey) && e.shiftKey;
    if (e.key === 'F11') {
      e.preventDefault();
      api.toggleFullscreen();
      return;
    }
    if (ctrlShift && (e.key === 'Q' || e.key === 'q')) {
      e.preventDefault();
      shutdownWithCrt();
      return;
    }
    if (ctrlShift && (e.key === 'R' || e.key === 'r')) {
      e.preventDefault();
      api.reload();
      return;
    }
    if (ctrlShift && (e.key === 'S' || e.key === 's')) {
      e.preventDefault();
      // Renderer-side path. The same shortcut is also registered globally
      // in main.js so it works when Hexshell isn't focused; this path is
      // the fast one when the user is already in the window.
      api.screenshot().then((res) => flashScreenshotResult(res));
      return;
    }
    // Ctrl+Shift+C — copy selection. Plain Ctrl+C is SIGINT and MUST
    // remain untouched.
    if (ctrlShift && (e.key === 'C' || e.key === 'c')) {
      // Only consume the event when there's actually something to copy;
      // otherwise let xterm see the keystroke (some users expect a no-op
      // to fall through to the shell's input layer).
      if (term.hasSelection()) {
        e.preventDefault();
        copySelection();
      }
      return;
    }
    // Ctrl+Shift+V — paste from CLIPBOARD.
    if (ctrlShift && (e.key === 'V' || e.key === 'v')) {
      e.preventDefault();
      pasteClipboard();
      return;
    }
  }
  window.addEventListener('keydown', onKey, true);

  // Subscribe to screenshot results pushed when the GLOBAL shortcut path
  // fires a capture (main → renderer). Same flash either way.
  const offShot = (typeof api.onScreenshot === 'function')
    ? api.onScreenshot((res) => flashScreenshotResult(res))
    : (() => {});

  // Shutdown requests from main (global Ctrl+Shift+Q etc.). Routed
  // through the same animated path so every quit looks consistent.
  const offShutdownReq = (typeof api.onShutdownRequest === 'function')
    ? api.onShutdownRequest(() => shutdownWithCrt())
    : (() => {});

  // -------------------------------------------------------------------------
  // Selection → clipboard, mouse paste, keyboard copy/paste.
  // -------------------------------------------------------------------------
  // Goal: make Hexshell behave like a real Linux terminal.
  //   1. Drag text with the mouse → write to PRIMARY (X11/Wayland)
  //      automatically, just like xterm/urxvt. The regular CLIPBOARD is
  //      NOT touched on every drag — only on explicit copy.
  //   2. Middle-click → paste from PRIMARY into the shell.
  //   3. Right-click → copy current selection if any (to PRIMARY +
  //      CLIPBOARD) else paste from CLIPBOARD.
  //   4. Ctrl+Shift+C / Ctrl+Shift+V — keyboard fallbacks (terminal
  //      convention; plain Ctrl+C remains SIGINT, do NOT intercept).

  // Auto-write PRIMARY on selection. xterm fires onSelectionChange a lot
  // during a drag; we debounce until the user pauses so we hit the IPC
  // once per finished selection rather than per pixel.
  let selectionDebounce = null;
  const onSelDisposable = term.onSelectionChange(() => {
    if (selectionDebounce) clearTimeout(selectionDebounce);
    selectionDebounce = setTimeout(() => {
      const sel = term.getSelection();
      if (sel && sel.length > 0) api.primaryWrite(sel);
    }, 80);
  });

  /** Copy selection to BOTH clipboards. Returns true if it actually ran. */
  async function copySelection() {
    const sel = term.getSelection();
    if (!sel) return false;
    try { await navigator.clipboard.writeText(sel); }
    catch (_) { /* CSP / permissions: best effort */ }
    api.primaryWrite(sel);
    return true;
  }

  async function pasteClipboard() {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch (_) {}
    if (text) api.write(text);
  }

  async function pastePrimary() {
    let text = '';
    try { text = await api.primaryRead(); } catch (_) {}
    if (text) api.write(text);
  }

  // Mouse handlers — capture phase so we run before xterm's own.
  function onMouseDown(e) {
    if (!mount.contains(e.target)) return;
    if (e.button === 1) {           // middle click → paste PRIMARY
      e.preventDefault();
      pastePrimary();
    }
  }
  function onContextMenu(e) {
    if (!mount.contains(e.target)) return;
    e.preventDefault();
    if (term.hasSelection()) {
      copySelection().then(() => {
        try { term.clearSelection(); } catch (_) {}
      });
    } else {
      pasteClipboard();
    }
  }
  mount.addEventListener('mousedown',   onMouseDown,   true);
  mount.addEventListener('contextmenu', onContextMenu, true);

  // -------------------------------------------------------------------------
  // Cursor shape API for Settings.
  // -------------------------------------------------------------------------
  // Maps directly to xterm's native cursorStyle. We considered a custom
  // "hyphen" shape but xterm's runtime stylesheet fights every CSS
  // override path; sticking to the three shapes xterm draws natively
  // keeps the cursor reliable across reloads, blink states, and focus
  // changes.
  function applyCursorShape(shape) {
    if (!term) return;
    if (shape !== 'block' && shape !== 'bar' && shape !== 'underline') return;
    try { term.options.cursorStyle = shape; } catch (_) {}
    if (mount) {
      mount.classList.toggle('hex-cursor-block',     shape === 'block');
      mount.classList.toggle('hex-cursor-bar',       shape === 'bar');
      mount.classList.toggle('hex-cursor-underline', shape === 'underline');
    }
  }
  window.hexTerminal = Object.freeze({
    setCursorStyle: applyCursorShape,
    shutdownWithCrt,
    revealTerminal
  });

  // Honor a saved cursor preference at boot. system.js owns the prefs file
  // (`hexshell.prefs` in localStorage); we just read the one key we care
  // about. If anything goes wrong we fall back to xterm's default block.
  try {
    const raw = localStorage.getItem('hexshell.prefs');
    if (raw) {
      const saved = JSON.parse(raw);
      let shape = saved && saved['display.cursor'];
      // Migrate: anyone still on the deprecated 'hyphen' value falls
      // back to underline (closest visual relative).
      if (shape === 'hyphen') shape = 'underline';
      if (typeof shape === 'string') applyCursorShape(shape);
    }
  } catch (_) { /* no localStorage / parse error: keep default */ }

  // -------------------------------------------------------------------------
  // HUD helpers
  // -------------------------------------------------------------------------
  function setStatus(text, kind) {
    const el = document.getElementById('hud-status');
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind || '';
  }
  function setShellLabel() {
    const el = document.getElementById('hud-shell');
    if (el) el.textContent = 'SHELL: hexsh';
  }

  // ──────────────────────────────────────────────────────────────────────
  // Version label + HUD clock
  // ──────────────────────────────────────────────────────────────────────
  // Version is read once from the preload bridge and dropped into the
  // titlebar. The clock ticks once per second on a setInterval; we align
  // the first tick to the next wall-clock second so seconds advance in
  // sync with the OS clock instead of drifting by up to 1s.
  (function installVersion() {
    const el = document.getElementById('hud-version');
    if (!el) return;
    const v = (api && typeof api.version === 'string') ? api.version : '0.0.0';
    el.textContent = `v${v}`;
  })();

  const clockEl = document.getElementById('hud-clock');
  let clockTimeout = null;
  let clockInterval = null;

  /** Render current time as HH:MM:SS in 24-hour. */
  function tickClock() {
    if (!clockEl) return;
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    clockEl.textContent = `${hh}:${mm}:${ss}`;
  }

  function startClock() {
    tickClock();
    // Align first interval to the start of the next second.
    const now = Date.now();
    const delay = 1000 - (now % 1000);
    clockTimeout = setTimeout(() => {
      tickClock();
      clockInterval = setInterval(tickClock, 1000);
    }, delay);
  }
  function stopClock() {
    if (clockTimeout)  { clearTimeout(clockTimeout);  clockTimeout = null; }
    if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }
  }
  startClock();

  /**
   * Flash a transient HUD notice when a screenshot is taken or fails.
   * Implemented as a short-lived element appended to <body>; CSS handles
   * the fade. We avoid building a generic toast system here — there's
   * exactly one user of this so far.
   */
  function flashScreenshotResult(res) {
    const el = document.createElement('div');
    el.className = 'hud-toast';
    if (res && res.ok) {
      el.classList.add('hud-toast--ok');
      el.textContent = res.file
        ? `📷 SCREENSHOT · ${res.tool} · ${res.file}`
        : `📷 SCREENSHOT · ${res.tool}`;
    } else {
      el.classList.add('hud-toast--err');
      el.textContent = res && res.error
        ? `📷 SCREENSHOT FAILED · ${res.error}`
        : '📷 SCREENSHOT FAILED';
    }
    document.body.appendChild(el);
    // Remove after the CSS animation runs to completion (3.4s total).
    setTimeout(() => { try { el.remove(); } catch (_) {} }, 3500);
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------
  // Triggered on reload (Ctrl+Shift+R) and on tab/window close. Without this
  // we'd accumulate xterm/IPC listeners every reload and slowly leak memory.
  function cleanup() {
    try { ro.disconnect(); } catch (_) {}
    try { dataDisposable.dispose(); } catch (_) {}
    try { offData(); } catch (_) {}
    try { offExit(); } catch (_) {}
    try { offBell(); } catch (_) {}
    try { offShot(); } catch (_) {}
    try { offShutdownReq(); } catch (_) {}
    try { stopClock(); } catch (_) {}
    try { onSelDisposable.dispose(); } catch (_) {}
    try { mount.removeEventListener('mousedown',   onMouseDown,   true); } catch (_) {}
    try { mount.removeEventListener('contextmenu', onContextMenu, true); } catch (_) {}
    try { if (selectionDebounce) clearTimeout(selectionDebounce); } catch (_) {}
    try { window.removeEventListener('keydown', onKey, true); } catch (_) {}
    try { window.removeEventListener('keydown', onKeySound, true); } catch (_) {}
    try { window.removeEventListener('resize', scheduleResize); } catch (_) {}
    try { term.dispose(); } catch (_) {}
    try { api.kill(); } catch (_) {}
  }
  window.addEventListener('beforeunload', cleanup);

  // Expose for debugging only when --enable-logging is on. Avoids polluting
  // the global namespace in shipped builds.
  if (location.search.includes('debug')) {
    // eslint-disable-next-line no-underscore-dangle
    window.__hexshell_term = term;
  }
})();
