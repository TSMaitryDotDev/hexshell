'use strict';

/**
 * Hexshell audio module.
 *
 * Two responsibilities:
 *   1. Play the startup chime exactly once (per OS launch).
 *   2. Expose a low-latency `click()` API that the line editor in
 *      renderer.js triggers on every keystroke.
 *
 * Why two different audio paths:
 *   - Startup chime is a one-shot, latency doesn't matter, and we don't
 *     want WebAudio plumbing for it. HTMLAudioElement is fine.
 *   - Key clicks fire dozens of times per second. HTMLAudioElement would
 *     decode the WAV on every play (~50ms latency on first hit) and churn
 *     GC. We use WebAudio: decode once into an AudioBuffer, then schedule
 *     fresh BufferSourceNodes per keypress. End-to-end latency ~3–5ms.
 *
 * Public API (attached to window so renderer.js can use it):
 *   window.hexAudio.click()
 *
 * The module degrades silently if the OS has no audio device or the
 * WebAudio context fails to start. The shell itself never depends on
 * audio working.
 */

(function () {
  // Re-injection guard for the chime. We deliberately do NOT guard the
  // keysound: every reload should still produce clicks.
  let chimePlayed = false;
  try {
    chimePlayed = sessionStorage.getItem('hexshell.startupChimePlayed') === '1';
  } catch (_) {}

  const STARTUP_SRC = '../audio/startup-v1.wav';
  const KEY_SRC     = '../audio/keysound.wav';
  const ERR_SRC     = '../audio/cmd-error.wav';
  const PROC_SRC    = '../audio/process.wav';
  const MENU_SRC    = '../audio/menuOpen.wav';
  const UICLICK_SRC = '../audio/click.wav';

  // -------------------------------------------------------------------------
  // Startup chime
  // -------------------------------------------------------------------------
  // Two-path strategy:
  //   1. WebAudio (preferred): instant dispatch, no decode latency. Works
  //      once initAudio() finishes the parallel decode (~50ms after page
  //      load on Linux).
  //   2. HTMLAudioElement (fallback): if the renderer fires playStartup()
  //      before initAudio() resolves (rare; would only happen on a very
  //      cold start), we fall back to the legacy path so the chime still
  //      plays. ~30–80ms decode lag, but better than silence.
  //
  // Either way, we only fire once per session, gated by sessionStorage so
  // reloads (Ctrl+Shift+R) don't re-play.
  function playStartup() {
    if (chimePlayed) return;
    chimePlayed = true;
    try { sessionStorage.setItem('hexshell.startupChimePlayed', '1'); } catch (_) {}

    // Resume context if suspended (Chromium autoplay policy edge case).
    if (ctx && ctx.state === 'suspended') {
      try { ctx.resume(); } catch (_) {}
    }

    // Fast path: WebAudio with the pre-decoded buffer.
    if (ctx && startupBuffer && startupGain) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = startupBuffer;
        src.connect(startupGain);
        src.start(0);
        src.onended = () => { try { src.disconnect(); } catch (_) {} };
        return;
      } catch (_) { /* fall through to HTMLAudioElement */ }
    }

    // Slow path: HTMLAudioElement. Used when initAudio hasn't decoded
    // the buffer yet, or WebAudio failed to initialise entirely.
    const audio = new Audio(STARTUP_SRC);
    audio.preload = 'auto';
    audio.volume = 0.6 * masterScale;
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[hexshell] startup chime skipped:', err && err.message);
        }
      });
    }
    audio.addEventListener('ended', () => {
      try { audio.src = ''; } catch (_) {}
    }, { once: true });
  }

  // -------------------------------------------------------------------------
  // Keysound (WebAudio, low-latency)
  // -------------------------------------------------------------------------
  // Tuning knobs. These were picked to feel like a softly tactile keyboard:
  //   - VOLUME      : a hair quieter than the chime so it doesn't dominate
  //   - PITCH_RANGE : ±5% playbackRate variation per key, for organic feel
  //   - MIN_GAP_MS  : skip retriggers within this window. Prevents the
  //                   "wall of sound" when a key is auto-repeating, and
  //                   protects against bracketed-paste fragments. 12ms is
  //                   ~83Hz max click rate, well above natural typing.
  //   - MAX_VOICES  : hard cap on simultaneous nodes. Realistic typing
  //                   never reaches this; it's a guard against runaway
  //                   sources that could choke the audio thread.
  const KEY = {
    VOLUME:      0.45,
    PITCH_RANGE: 0.05,
    MIN_GAP_MS:  12,
    MAX_VOICES:  16
  };

  // Error chime is a one-shot UI cue, so the tuning is different:
  //   - No pitch jitter — errors should sound consistent, recognizable.
  //   - Higher MIN_GAP so a chain of failing commands doesn't stutter.
  //   - Volume sits a bit above keyclicks so it actually grabs attention.
  const ERR = {
    VOLUME:      0.7,
    MIN_GAP_MS:  120
  };

  // Process loop is ambient — it runs the entire time a long-running
  // package/download command is alive. We:
  //   - keep it relatively quiet so the user can still hear the program
  //     they're running (npm output, git progress, etc.)
  //   - apply short fade-in / fade-out ramps to avoid clicks at start/stop
  //     since the sample isn't guaranteed to be zero-crossing at edges.
  const PROC = {
    VOLUME:    0.25,
    FADE_IN:   0.08,   // seconds
    FADE_OUT:  0.12    // seconds
  };

  // Per-kind enable flags. Settings flips these at runtime; defaults are
  // "everything on" because audio is the whole vibe of the app.
  const enabled = {
    click: true, error: true, process: true,
    menu: true, ui: true,
  };
  // Master multiplier in [0..1]; multiplied into each kind's gain so the
  // single slider in Settings can attenuate everything together.
  let masterScale = 1.0;

  /** @type {AudioContext | null} */
  let ctx = null;
  /** @type {AudioBuffer | null} */
  let buffer = null;       // keysound
  /** @type {AudioBuffer | null} */
  let errBuffer = null;    // command-error
  /** @type {AudioBuffer | null} */
  let procBuffer = null;   // process loop
  /** @type {AudioBuffer | null} */
  let startupBuffer = null; // startup chime (low-latency WebAudio path)
  /** @type {AudioBuffer | null} */
  let menuBuffer = null;    // menu/modal/splash open chime
  /** @type {AudioBuffer | null} */
  let uiClickBuffer = null; // generic UI click (menu items, settings buttons)
  /** @type {GainNode | null} */
  let masterGain = null;   // for keysound
  /** @type {GainNode | null} */
  let errGain = null;      // for error chime
  /** @type {GainNode | null} */
  let procGain = null;     // for process loop
  /** @type {GainNode | null} */
  let startupGain = null;  // for startup chime
  /** @type {GainNode | null} */
  let menuGain = null;     // for menu open chime
  /** @type {GainNode | null} */
  let uiClickGain = null;  // for UI click
  /** @type {AudioBufferSourceNode | null} */
  let procSource = null;   // currently looping source, if any
  let lastClickAt = 0;
  let lastErrorAt = 0;
  let lastMenuAt = 0;
  let lastUiClickAt = 0;
  let liveVoices = 0;
  let initPromise = null;
  let warnedNotReady = false;

  /**
   * Lazily create the AudioContext and decode the WAVs once. Returns a
   * promise resolved when both buffers are ready (or as many as could be
   * decoded — a partial failure won't block the rest from working).
   */
  function initAudio() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return false;
        ctx = new Ctx({ latencyHint: 'interactive' });

        // The autoplay policy switch in main.js usually leaves the context
        // in 'running' state, but resume() is cheap and idempotent.
        if (ctx.state === 'suspended') {
          try { await ctx.resume(); } catch (_) {}
        }

        masterGain = ctx.createGain();
        masterGain.gain.value = KEY.VOLUME * masterScale;
        masterGain.connect(ctx.destination);

        errGain = ctx.createGain();
        errGain.gain.value = ERR.VOLUME * masterScale;
        errGain.connect(ctx.destination);

        // Process loop starts at gain=0 and ramps in/out so the user never
        // hears a hard click at the boundaries.
        procGain = ctx.createGain();
        procGain.gain.value = 0;
        procGain.connect(ctx.destination);

        // Startup chime path. Lives on its own gain so masterScale can
        // affect it without coupling to keysound's volume.
        startupGain = ctx.createGain();
        startupGain.gain.value = 0.6 * masterScale;
        startupGain.connect(ctx.destination);

        // Menu/modal open chime. Slightly quieter than the startup chime
        // because it fires every time a menu opens — we want it noticeable
        // without being aggressive.
        menuGain = ctx.createGain();
        menuGain.gain.value = 0.45 * masterScale;
        menuGain.connect(ctx.destination);

        // UI click. Quieter still — fires on every menu item / settings
        // button. Same intent as the keysound but for cursor-driven UI.
        uiClickGain = ctx.createGain();
        uiClickGain.gain.value = 0.40 * masterScale;
        uiClickGain.connect(ctx.destination);

        // Decode all six in parallel. Promise.allSettled so a missing
        // sample never silences the rest of the mixer.
        const [
          keyBuf, errBuf, procBuf, startBuf, menuBuf, uiBuf
        ] = await Promise.allSettled([
          decode(KEY_SRC),
          decode(ERR_SRC),
          decode(PROC_SRC),
          decode(STARTUP_SRC),
          decode(MENU_SRC),
          decode(UICLICK_SRC)
        ]);
        if (keyBuf.status === 'fulfilled')  buffer     = keyBuf.value;
        else if (typeof console !== 'undefined') {
          console.warn('[hexshell] keysound decode failed:', keyBuf.reason && keyBuf.reason.message);
        }
        if (errBuf.status === 'fulfilled')  errBuffer  = errBuf.value;
        else if (typeof console !== 'undefined') {
          console.warn('[hexshell] error chime decode failed:', errBuf.reason && errBuf.reason.message);
        }
        if (procBuf.status === 'fulfilled') procBuffer = procBuf.value;
        else if (typeof console !== 'undefined') {
          console.warn('[hexshell] process loop decode failed:', procBuf.reason && procBuf.reason.message);
        }
        if (startBuf.status === 'fulfilled') startupBuffer = startBuf.value;
        else if (typeof console !== 'undefined') {
          console.warn('[hexshell] startup chime decode failed:', startBuf.reason && startBuf.reason.message);
        }
        if (menuBuf.status === 'fulfilled') menuBuffer = menuBuf.value;
        else if (typeof console !== 'undefined') {
          console.warn('[hexshell] menu chime decode failed:', menuBuf.reason && menuBuf.reason.message);
        }
        if (uiBuf.status === 'fulfilled') uiClickBuffer = uiBuf.value;
        else if (typeof console !== 'undefined') {
          console.warn('[hexshell] ui click decode failed:', uiBuf.reason && uiBuf.reason.message);
        }
        return true;
      } catch (err) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[hexshell] audio disabled:', err && err.message);
        }
        return false;
      }
    })();
    return initPromise;
  }

  async function decode(src) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetch ${src} -> ${res.status}`);
    const ab = await res.arrayBuffer();
    return ctx.decodeAudioData(ab);
  }

  /**
   * Trigger one click sound. Synchronous from the caller's perspective —
   * we never await the init promise here. If the buffer isn't ready yet
   * (very first keystroke after launch) we just drop the click; users
   * won't notice.
   */
  function click() {
    if (!enabled.click) return;
    // Throttle.
    const now = performance.now();
    if (now - lastClickAt < KEY.MIN_GAP_MS) return;
    lastClickAt = now;

    // First-keystroke fallback: some Linux/Chromium builds keep the
    // AudioContext suspended until any user gesture, even with the
    // autoplay-policy switch. We resume on the first call; .resume() is
    // a no-op if already running.
    if (ctx && ctx.state === 'suspended') {
      try { ctx.resume(); } catch (_) {}
    }

    if (!ctx || !buffer || !masterGain) {
      // Buffer not decoded yet. Warn ONCE so the cause is visible if the
      // file is missing or the decode threw, but don't spam the console.
      if (!warnedNotReady) {
        warnedNotReady = true;
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[hexshell] keysound: buffer not ready, dropping click');
        }
      }
      return;
    }
    if (liveVoices >= KEY.MAX_VOICES) return;

    try {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      // ±PITCH_RANGE around 1.0 for a natural mechanical-keyboard feel.
      const jitter = 1 + (Math.random() * 2 - 1) * KEY.PITCH_RANGE;
      src.playbackRate.value = jitter;
      src.connect(masterGain);
      src.start(0);
      liveVoices++;
      src.onended = () => {
        liveVoices = Math.max(0, liveVoices - 1);
        try { src.disconnect(); } catch (_) {}
      };
    } catch (_) {
      // AudioContext can throw if the device is being torn down. Swallow.
    }
  }

  /** Master volume slider in Settings; multiplied into every kind's gain. */
  function setMasterVolume(v) {
    const clamped = Math.max(0, Math.min(1, Number(v) || 0));
    masterScale = clamped;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (masterGain)  masterGain.gain.setTargetAtTime(KEY.VOLUME * masterScale, t, 0.01);
    if (errGain)     errGain.gain.setTargetAtTime(ERR.VOLUME * masterScale, t, 0.01);
    if (startupGain) startupGain.gain.setTargetAtTime(0.6 * masterScale, t, 0.01);
    if (menuGain)    menuGain.gain.setTargetAtTime(0.45 * masterScale, t, 0.01);
    if (uiClickGain) uiClickGain.gain.setTargetAtTime(0.40 * masterScale, t, 0.01);
    // procGain is dynamic; we let processStart/Stop handle ramps and pick
    // the new ceiling on the next start. If the loop is currently active
    // we DO update its target so the slider feels responsive.
    if (procGain && procSource) {
      procGain.gain.setTargetAtTime(PROC.VOLUME * masterScale, t, 0.05);
    }
  }

  /**
   * Toggle a sound kind. `kind` is one of:
   *   'click'   — keysound on every keystroke
   *   'error'   — chime when a command exits non-zero
   *   'process' — ambient loop during install/download
   *   'menu'    — chime when SYSTEM menu / Settings / Splash open
   *   'ui'      — generic click on menu items / settings buttons
   */
  function setEnabled(kind, on) {
    if (!(kind in enabled)) return;
    const wasOn = enabled[kind];
    enabled[kind] = !!on;
    // Side-effect: if the user disables 'process' while a loop is playing,
    // stop it immediately. The opposite (enabling) does NOT auto-start the
    // loop — that would surprise the user; the next install will pick it
    // up on its own.
    if (kind === 'process' && wasOn && !on) {
      processStop();
    }
  }

  /** Optional: legacy single-kind set. Now defers to master volume. */
  function setVolume(v) {
    setMasterVolume(v);
  }

  /**
   * Trigger the command-error chime. Throttled so a chain of failing
   * commands doesn't stutter. No pitch jitter — errors should sound
   * recognizable, not organic.
   */
  function error() {
    if (!enabled.error) return;
    const now = performance.now();
    if (now - lastErrorAt < ERR.MIN_GAP_MS) return;
    lastErrorAt = now;

    if (ctx && ctx.state === 'suspended') {
      try { ctx.resume(); } catch (_) {}
    }
    if (!ctx || !errBuffer || !errGain) return;

    try {
      const src = ctx.createBufferSource();
      src.buffer = errBuffer;
      src.connect(errGain);
      src.start(0);
      src.onended = () => {
        try { src.disconnect(); } catch (_) {}
      };
    } catch (_) {
      // AudioContext torn down; nothing to do.
    }
  }

  /**
   * Menu/modal/splash open chime. Throttled at 200 ms because two menus
   * sometimes open in close succession (e.g. SYSTEM → Settings) and we
   * don't want the audio to overlap into a smear.
   */
  function menu() {
    if (!enabled.menu) return;
    const now = performance.now();
    if (now - lastMenuAt < 200) return;
    lastMenuAt = now;

    if (ctx && ctx.state === 'suspended') {
      try { ctx.resume(); } catch (_) {}
    }
    if (!ctx || !menuBuffer || !menuGain) return;

    try {
      const src = ctx.createBufferSource();
      src.buffer = menuBuffer;
      src.connect(menuGain);
      src.start(0);
      src.onended = () => { try { src.disconnect(); } catch (_) {} };
    } catch (_) {}
  }

  /**
   * Generic UI click — fired when the user activates a menu item, a
   * settings choice button, the close button, etc. Distinct from the
   * keysound (which is per-keystroke). Throttled at 60 ms so a fast
   * double-click doesn't double-trigger.
   */
  function uiClick() {
    if (!enabled.ui) return;
    const now = performance.now();
    if (now - lastUiClickAt < 60) return;
    lastUiClickAt = now;

    if (ctx && ctx.state === 'suspended') {
      try { ctx.resume(); } catch (_) {}
    }
    if (!ctx || !uiClickBuffer || !uiClickGain) return;

    try {
      const src = ctx.createBufferSource();
      src.buffer = uiClickBuffer;
      src.connect(uiClickGain);
      src.start(0);
      src.onended = () => { try { src.disconnect(); } catch (_) {} };
    } catch (_) {}
  }

  /**
   * Start the looping process sound. Idempotent: calling it while already
   * playing is a no-op (so back-to-back package commands don't stack).
   * Fades in over PROC.FADE_IN seconds to avoid a click at start.
   */
  function processStart() {
    if (!enabled.process) return;
    if (ctx && ctx.state === 'suspended') {
      try { ctx.resume(); } catch (_) {}
    }
    if (!ctx || !procBuffer || !procGain) return;
    if (procSource) return; // already running

    try {
      const src = ctx.createBufferSource();
      src.buffer = procBuffer;
      src.loop = true;
      // Loop boundaries default to the full buffer; if the WAV has silence
      // padding you can tighten them here. We leave defaults for honesty.
      src.connect(procGain);

      // Fade in: anchor current gain at "now", ramp to PROC.VOLUME * scale.
      const t = ctx.currentTime;
      procGain.gain.cancelScheduledValues(t);
      procGain.gain.setValueAtTime(procGain.gain.value, t);
      procGain.gain.linearRampToValueAtTime(PROC.VOLUME * masterScale, t + PROC.FADE_IN);

      src.start(0);
      procSource = src;
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[hexshell] processStart failed:', err && err.message);
      }
    }
  }

  /**
   * Stop the looping process sound, fading out over PROC.FADE_OUT seconds.
   * The actual BufferSource is stopped after the fade so we don't cut off
   * mid-amplitude (which causes a pop). Idempotent: safe to call when no
   * loop is running.
   */
  function processStop() {
    if (!ctx || !procGain) return;
    const src = procSource;
    if (!src) {
      // Nothing playing — but still cancel any pending fade-in just in case.
      try {
        const t = ctx.currentTime;
        procGain.gain.cancelScheduledValues(t);
        procGain.gain.setValueAtTime(0, t);
      } catch (_) {}
      return;
    }
    procSource = null;

    try {
      const t = ctx.currentTime;
      procGain.gain.cancelScheduledValues(t);
      procGain.gain.setValueAtTime(procGain.gain.value, t);
      procGain.gain.linearRampToValueAtTime(0, t + PROC.FADE_OUT);
      // Stop the source AFTER the fade completes so we don't get a pop.
      src.stop(t + PROC.FADE_OUT + 0.01);
      src.onended = () => {
        try { src.disconnect(); } catch (_) {}
      };
    } catch (_) {
      try { src.stop(); src.disconnect(); } catch (_) {}
    }
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  function boot() {
    // Kick off audio init in the background. It usually finishes in
    // under 50ms on Linux for these small WAVs. We DO NOT play the
    // startup chime here — renderer.js triggers it synchronously with
    // the CRT power-on animation so the audio and visuals are aligned.
    initAudio();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // Expose the API. Frozen so renderer.js can't accidentally clobber it.
  window.hexAudio = Object.freeze({
    click,                // keysound — per-keystroke
    error,                // command-error chime
    processStart,         // ambient install/download loop start
    processStop,          // ambient install/download loop stop
    playStartup,          // boot chime, synced with CRT power-on
    menu,                 // chime when SYSTEM menu / Settings / Splash open
    uiClick,              // generic click on menu items / settings buttons
    setVolume,            // alias for setMasterVolume; kept for back-compat
    setMasterVolume,
    setEnabled
  });
})();
