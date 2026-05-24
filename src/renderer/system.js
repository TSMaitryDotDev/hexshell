'use strict';

/**
 * SYSTEM menu + Settings modal controller.
 *
 * This module owns:
 *   - the dropdown menu attached to the [ SYSTEM ] button
 *   - the Settings modal (audio toggles + master volume)
 *   - persistence of preferences in localStorage
 *
 * Why a separate module:
 *   renderer.js is the terminal. Mixing UI chrome wiring into it would
 *   make both files harder to read. The boundary is clean: this file
 *   only ever talks to the DOM, window.hexshell (preload bridge) and
 *   window.hexAudio (audio module).
 *
 * Persistence:
 *   We use localStorage with a single namespaced key `hexshell.prefs`.
 *   The shape is forwards-compatible — unknown keys are preserved when
 *   we round-trip the JSON. Defaults come from `DEFAULT_PREFS` and are
 *   used whenever a key is missing.
 */

(function () {
  const STORAGE_KEY = 'hexshell.prefs';

  const DEFAULT_PREFS = Object.freeze({
    'audio.click':    true,
    'audio.error':    true,
    'audio.process':  true,
    'audio.volume':   45,    // 0..100; mapped to 0..1 for hexAudio
    'display.cursor': 'block', // 'block' | 'bar' | 'underline'
    'splash.skipBoot': false  // true => never auto-open OS splash on launch
  });

  // -------------------------------------------------------------------------
  // Prefs storage
  // -------------------------------------------------------------------------
  function loadPrefs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_PREFS };
      const parsed = JSON.parse(raw);
      // Merge: defaults first so any new keys we add later get sane values
      // even on machines that already wrote the file.
      return { ...DEFAULT_PREFS, ...parsed };
    } catch (_) {
      return { ...DEFAULT_PREFS };
    }
  }

  function savePrefs(prefs) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (_) { /* private mode etc. */ }
  }

  /** Apply prefs to live audio. Called on boot and after any change. */
  function applyPrefs(prefs) {
    if (window.hexAudio) {
      if (typeof window.hexAudio.setEnabled === 'function') {
        window.hexAudio.setEnabled('click',   !!prefs['audio.click']);
        window.hexAudio.setEnabled('error',   !!prefs['audio.error']);
        window.hexAudio.setEnabled('process', !!prefs['audio.process']);
      }
      if (typeof window.hexAudio.setMasterVolume === 'function') {
        const v = Math.max(0, Math.min(100, Number(prefs['audio.volume']) || 0)) / 100;
        window.hexAudio.setMasterVolume(v);
      }
    }
    // Display: cursor shape. The terminal API is exposed by renderer.js
    // and may not exist if the renderer hasn't booted yet — settings.js
    // re-applies on every change, so the next change will catch up.
    if (window.hexTerminal && typeof window.hexTerminal.setCursorStyle === 'function') {
      const shape = prefs['display.cursor'];
      const allowed = ['block', 'bar', 'underline'];
      if (allowed.includes(shape)) window.hexTerminal.setCursorStyle(shape);
    }
  }

  // -------------------------------------------------------------------------
  // SYSTEM menu
  // -------------------------------------------------------------------------
  function setupMenu() {
    const button = document.getElementById('system-button');
    const menu   = document.getElementById('system-menu');
    if (!button || !menu) return;

    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));

    function openMenu() {
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      // Focus first item so keyboard users can immediately arrow-navigate.
      if (items[0]) {
        items.forEach((el, i) => el.tabIndex = i === 0 ? 0 : -1);
        items[0].focus();
      }
      // Defer attaching the outside-click listener so the same click that
      // opened the menu doesn't immediately close it.
      setTimeout(() => {
        document.addEventListener('mousedown', onOutsideMouse, true);
        document.addEventListener('keydown',   onMenuKey, true);
      }, 0);
    }

    function closeMenu() {
      if (menu.hidden) return;
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onOutsideMouse, true);
      document.removeEventListener('keydown',   onMenuKey, true);
    }

    function onOutsideMouse(e) {
      if (menu.contains(e.target) || button.contains(e.target)) return;
      closeMenu();
    }

    function onMenuKey(e) {
      const idx = items.indexOf(document.activeElement);
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          closeMenu();
          button.focus();
          return;
        case 'ArrowDown': {
          e.preventDefault();
          const next = items[(idx + 1) % items.length];
          items.forEach((el) => el.tabIndex = -1);
          next.tabIndex = 0;
          next.focus();
          return;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const prev = items[(idx - 1 + items.length) % items.length];
          items.forEach((el) => el.tabIndex = -1);
          prev.tabIndex = 0;
          prev.focus();
          return;
        }
        case 'Home':
          e.preventDefault();
          items[0] && items[0].focus();
          return;
        case 'End':
          e.preventDefault();
          items[items.length - 1] && items[items.length - 1].focus();
          return;
        case 'Enter':
        case ' ': {
          if (idx >= 0) {
            e.preventDefault();
            items[idx].click();
          }
          return;
        }
      }
    }

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden ? openMenu() : closeMenu();
    });

    menu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-action]');
      if (!item) return;
      const action = item.dataset.action;
      closeMenu();
      runAction(action);
    });
  }

  // -------------------------------------------------------------------------
  // Action dispatcher
  // -------------------------------------------------------------------------
  function runAction(action) {
    const api = window.hexshell;
    switch (action) {
      case 'reload':
        if (api && typeof api.reload === 'function') api.reload();
        return;
      case 'clear':
        // Equivalent to typing Ctrl+L: send the byte to the shell, which
        // runs the `clear` builtin and redraws the prompt.
        if (api && typeof api.write === 'function') api.write('\x0c');
        return;
      case 'settings':
        openSettings();
        return;
      case 'splash':
        openSplash();
        return;
      case 'exit':
        // Same animated path the close button uses.
        if (window.hexTerminal && typeof window.hexTerminal.shutdownWithCrt === 'function') {
          window.hexTerminal.shutdownWithCrt();
        } else if (api && typeof api.quit === 'function') {
          api.quit();
        }
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Settings modal
  // -------------------------------------------------------------------------
  let modal, modalOpen = false, prevFocus = null;
  let prefs = loadPrefs();

  function setupSettings() {
    modal = document.getElementById('settings-modal');
    if (!modal) return;

    // Hydrate controls from prefs.
    modal.querySelectorAll('[data-pref]').forEach((el) => {
      const key = el.getAttribute('data-pref');
      if (el.type === 'checkbox') {
        el.checked = !!prefs[key];
      } else if (el.type === 'range') {
        el.value = String(prefs[key]);
        const out = modal.querySelector(`[data-output="${cssEscape(key)}"]`);
        if (out) out.value = String(prefs[key]);
      }
      el.addEventListener('input',  () => onPrefChange(el));
      el.addEventListener('change', () => onPrefChange(el));
    });

    // Choice groups (single-select; cursor shape lives here).
    modal.querySelectorAll('[data-pref-group]').forEach((group) => {
      const key = group.getAttribute('data-pref-group');
      const buttons = Array.from(group.querySelectorAll('[role="radio"]'));
      function syncSelection(value) {
        for (const b of buttons) {
          b.setAttribute('aria-checked', String(b.dataset.value === value));
        }
      }
      syncSelection(prefs[key]);
      for (const b of buttons) {
        b.addEventListener('click', () => {
          const v = b.dataset.value;
          if (!v) return;
          syncSelection(v);
          prefs = { ...prefs, [key]: v };
          savePrefs(prefs);
          applyPrefs(prefs);
        });
      }
    });

    // Backdrop / X button close.
    modal.addEventListener('click', (e) => {
      if (e.target.matches('[data-modal-close]')) closeSettings();
    });
    document.addEventListener('keydown', (e) => {
      if (modalOpen && e.key === 'Escape') {
        e.preventDefault();
        closeSettings();
      }
    });

    // Show app version in the footer if Electron exposes it via preload.
    const v = (window.hexshell && window.hexshell.version) || '';
    const tag = document.getElementById('settings-version');
    if (tag && v) tag.textContent = `Hexshell ${v}`;
  }

  function onPrefChange(el) {
    const key = el.getAttribute('data-pref');
    let value;
    if (el.type === 'checkbox') value = el.checked;
    else if (el.type === 'range') {
      value = Number(el.value);
      const out = modal.querySelector(`[data-output="${cssEscape(key)}"]`);
      if (out) out.value = String(value);
    }
    prefs = { ...prefs, [key]: value };
    savePrefs(prefs);
    applyPrefs(prefs);
  }

  function openSettings() {
    if (!modal) return;
    prevFocus = document.activeElement;
    modal.hidden = false;
    modalOpen = true;
    // Focus the first input for keyboard users.
    const first = modal.querySelector('input,button');
    if (first) first.focus();
  }

  function closeSettings() {
    if (!modal) return;
    modal.hidden = true;
    modalOpen = false;
    if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  // -------------------------------------------------------------------------
  // Window controls (top-right)
  // -------------------------------------------------------------------------
  function setupWindowControls() {
    const api = window.hexshell;
    if (!api) return;
    bindClick('winctl-minimize', () => {
      if (typeof api.minimize === 'function') api.minimize();
    });
    bindClick('winctl-maximize', () => {
      if (typeof api.toggleFullscreen === 'function') api.toggleFullscreen();
    });
    bindClick('winctl-close', () => {
      // Prefer the CRT-animated path so the window collapse plays first;
      // fall back to a direct close/quit if the animation hook isn't
      // available for some reason (renderer.js boot order).
      if (window.hexTerminal && typeof window.hexTerminal.shutdownWithCrt === 'function') {
        window.hexTerminal.shutdownWithCrt();
        return;
      }
      if (typeof api.close === 'function') api.close();
      else if (typeof api.quit === 'function') api.quit();
    });
  }

  function bindClick(id, fn) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
  }

  // -------------------------------------------------------------------------
  // OS splash overlay
  // -------------------------------------------------------------------------
  // Two open modes:
  //   - normal (`{boot:false}` or no opts): in-app reopen via SYSTEM menu.
  //     Standard fade-in; closing hides immediately.
  //   - boot   (`{boot:true}`): part of the staged-boot sequence. The
  //     terminal is hidden behind us; we play a CRT-on while opening,
  //     and on close we play a CRT-off then call revealTerminal() so
  //     the user sees the same effect carry through to the terminal.
  let splashOpen = false;
  let splashKeyHandler = null;
  let splashBootMode = false;

  async function openSplash(opts) {
    const root = document.getElementById('os-splash');
    if (!root) return;
    if (splashOpen) return;
    splashOpen = true;
    splashBootMode = !!(opts && opts.boot);

    // Pull data + bundled icons in parallel; both are local so this is
    // a few ms total. Awaiting `hexLogosReady` ensures the splash shows
    // the official Simple Icons SVG on first paint instead of a flash
    // of the hand-drawn fallback while the JSON loads.
    const [info] = await Promise.all([
      window.hexshell.sysinfo().catch(() => null),
      window.hexLogosReady || Promise.resolve()
    ]);
    populateSplash(info);

    // Reset any prior state classes before we re-enter.
    root.classList.remove('splash--off');
    root.classList.toggle('splash--boot', splashBootMode);
    root.hidden = false;

    // Dismiss on any keystroke or pointer-down anywhere.
    splashKeyHandler = (e) => {
      if (e.type === 'keydown') {
        const k = e.key;
        if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta') return;
      }
      e.preventDefault();
      e.stopPropagation();
      closeSplash();
    };
    document.addEventListener('keydown',   splashKeyHandler, true);
    document.addEventListener('mousedown', splashKeyHandler, true);
  }

  function closeSplash() {
    const root = document.getElementById('os-splash');
    if (!root || !splashOpen) return;
    splashOpen = false;
    if (splashKeyHandler) {
      document.removeEventListener('keydown',   splashKeyHandler, true);
      document.removeEventListener('mousedown', splashKeyHandler, true);
      splashKeyHandler = null;
    }

    if (splashBootMode) {
      // Play CRT-off on the splash. When the animation finishes we hide
      // the splash AND ask the renderer to power-on the terminal.
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        root.hidden = true;
        root.classList.remove('splash--boot', 'splash--off');
        if (window.hexTerminal &&
            typeof window.hexTerminal.revealTerminal === 'function') {
          window.hexTerminal.revealTerminal();
        }
      };
      const onAnim = (e) => {
        if (e.animationName !== 'hex-crt-off' &&
            e.animationName !== 'hex-crt-fade-out') return;
        root.removeEventListener('animationend', onAnim);
        finish();
      };
      root.addEventListener('animationend', onAnim);
      // Trigger CRT-off animation.
      root.classList.add('splash--off');
      // Safety net.
      setTimeout(finish, 1200);
    } else {
      root.hidden = true;
    }
    splashBootMode = false;
  }

  function populateSplash(info) {
    const logoEl = document.getElementById('splash-logo');
    const grid   = document.getElementById('splash-grid');
    if (!logoEl || !grid) return;

    // Logo. logoFor falls back through ID_LIKE then to the generic Linux
    // mark. We trust the SVG strings (we wrote them ourselves) and assign
    // via innerHTML rather than DOMParser to keep this trivial.
    const id     = (info && info.os && info.os.id) || 'linux';
    const likes  = []; // ID_LIKE not currently surfaced; safe default
    const svgStr = window.hexLogos
      ? window.hexLogos.logoFor(id, likes)
      : '';
    logoEl.innerHTML = svgStr;

    // Build the info grid. Nothing fancy; mirrors what the `sys` builtin
    // shows in text form, just with proper labels and HTML markup so we
    // can highlight the headline (distro name).
    if (!info) {
      grid.innerHTML = '<dt>status</dt><dd>sysinfo unavailable</dd>';
      return;
    }
    const memPct  = info.memory && info.memory.pct;
    const memBar  = renderMiniBar(memPct, 16);
    const display = [
      info.display.monitor || `${info.display.cols}×${info.display.rows}`,
      info.display.session,
      info.display.desktop
    ].filter(Boolean).join(' · ');

    // Same shape as the text banner: only render rows that actually have
    // a value, so machines without GPU/lspci don't show empty fields.
    const rows = [
      ['os',        `<strong>${escapeHtml(info.os.pretty)}</strong> · ${escapeHtml(info.os.arch)}`],
      ['kernel',    escapeHtml(info.kernel)],
      ['host',      `${escapeHtml(info.user)}@${escapeHtml(info.host)}`],
      ['uptime',    escapeHtml(info.uptime)],
      ['packages',  escapeHtml(info.packages || '')],
      ['shell',     escapeHtml(info.shell)],
      ['terminal',  escapeHtml(info.terminal)],
      ['display',   escapeHtml(display || '—')],
      ['de',        escapeHtml(info.de || '')],
      ['wm',        escapeHtml(info.wm || '')],
      ['theme',     escapeHtml(info.theme || '')],
      ['icons',     escapeHtml(info.icons || '')],
      ['font',      escapeHtml(info.font || '')],
      ['cursor',    escapeHtml(info.cursor || '')],
      ['cpu',       escapeHtml(info.cpu)],
      ['gpu',       escapeHtml(info.gpu || '')],
      ['memory',    `${escapeHtml(info.memory.pretty)} ${memBar}`],
      ['swap',      info.swap && info.swap.total ? escapeHtml(info.swap.pretty) : ''],
      ['disk',      info.disk && info.disk.total ? escapeHtml(info.disk.pretty) : ''],
      ['ip',        escapeHtml(info.ip || '')],
      ['locale',    escapeHtml(info.locale || '')],
      ['node',      `v${escapeHtml(info.node)}`],
    ].filter(([, v]) => v && String(v).length);
    if (info.electron) rows.push(['electron', `v${escapeHtml(info.electron)}`]);

    grid.innerHTML = rows.map(([k, v]) => {
      // Strip HTML to provide a safe `title` for hover; this preserves
      // the full text when the column truncates the visible value.
      const titleText = String(v).replace(/<[^>]*>/g, '');
      return `<div><dt>${escapeHtml(k)}</dt>` +
             `<dd title="${escapeAttr(titleText)}">${v}</dd></div>`;
    }).join('');

    // Hydrate the "Don't show on launch" checkbox from saved prefs and
    // bind a change handler that writes through to localStorage. We do
    // this inside populateSplash because the rest of the prefs-binding
    // pipeline only walks #settings-modal.
    const cb = document.getElementById('splash-dontshow');
    if (cb && !cb._hexshellBound) {
      cb._hexshellBound = true;
      cb.checked = !!prefs['splash.skipBoot'];
      cb.addEventListener('change', () => {
        prefs = { ...prefs, 'splash.skipBoot': !!cb.checked };
        savePrefs(prefs);
        applyPrefs(prefs);
      });
    } else if (cb) {
      // Re-opening the splash should reflect the latest stored state.
      cb.checked = !!prefs['splash.skipBoot'];
    }
  }

  /** Tiny ASCII memory bar like `[████░░░░]`. Cheap visual at glance. */
  function renderMiniBar(pct, width) {
    if (typeof pct !== 'number' || isNaN(pct)) return '';
    const fill = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
    return `<span style="color:var(--hex-glow);letter-spacing:0">[${'█'.repeat(fill)}${'░'.repeat(width - fill)}]</span>`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  // Same intent, but specifically for HTML attribute values. Folds
  // newlines to spaces so a multi-line `title` doesn't render oddly.
  function escapeAttr(s) {
    return escapeHtml(String(s == null ? '' : s).replace(/\s+/g, ' ').trim());
  }

  // Public API for renderer.js (auto-show on boot) and runAction (menu).
  window.hexSplash = Object.freeze({ open: openSplash, close: closeSplash });

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  function boot() {
    setupMenu();
    setupSettings();
    setupWindowControls();
    // Apply persisted prefs as soon as audio is reachable. hexAudio decodes
    // its buffers in the background; setEnabled/setMasterVolume are safe to
    // call before that finishes — they just record state for later playback.
    applyPrefs(prefs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
