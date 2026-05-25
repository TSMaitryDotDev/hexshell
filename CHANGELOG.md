# Changelog

All notable changes to Hexshell are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [SemVer](https://semver.org/).

## [0.1.3] — 2026-05-25

Hotfix on top of 0.1.2.

### Fixed

- **Renderer no longer dies silently before xterm boots.** A `let
  chimeFired` declaration was placed below the function that read it,
  putting `playStartupChime()` in temporal-dead-zone territory on the
  first call. The thrown `ReferenceError` killed the whole renderer
  IIFE — symptoms were `LINK: ESTABLISHING` stuck, `SHELL: detecting…`
  never resolving, no cursor, no clock ticking. Moved the declaration
  above its consumer.

## [0.1.2] — 2026-05-24

Hotfix on top of 0.1.1.

### Fixed

- **Renderer no longer hangs on boot.** The Orbitron `@font-face`
  declaration used `format("truetype-variations")`, a CSS Fonts Level 4
  string some Chromium builds reject — which stalled
  `document.fonts.ready` indefinitely and left the terminal stuck on
  `LINK: ESTABLISHING` with the prompt never appearing.
- Use `format("truetype")` instead; variable axes work fine without the
  level-4 hint.
- Renamed bundled font from `Orbitron[wght].ttf` to
  `Orbitron-Variable.ttf` because square brackets in CSS `url()` trip
  some font loaders.
- Added a 500 ms timeout race to `await document.fonts.ready` in
  `bootTerminal()` so a future broken font declaration can never leave
  the renderer stuck again.

## [0.1.1] — 2026-05-24

Polish pass on top of 0.1.0.

### Added

- Welcome hint banner top-left at boot: "type help for keybindings +
  builtins". Fades out automatically after 8 s or on the first
  keystroke. `prefers-reduced-motion` honored.

### Changed

- Version chip in the titlebar bumped to v0.1.1.

### Removed

- "SESSION TERMINATED" dead banner that pre-dated the in-process
  hexsh shell — there's no PTY-exit semantic to surface anymore.

### Fixed

- `chrome-sandbox` setuid bit and `/opt/Hexshell/resources` perms in
  the AUR `-bin` package — Hexshell now actually launches when
  installed via `yay -S hexshell-bin`.
- AUR PKGBUILD points at the correct AppImage filename
  (`Hexshell-0.1.1-x86_64.AppImage`).
- Icon installed at every standard hicolor size (16, 24, 32, 48, 64,
  128, 256, 512) so panels and app menus pick it up.

## [0.1.0] — 2026-05-24

Initial release. Everything in Hexshell that would later become a "feature
to bisect" started here, so this entry is a thorough one.

### Shell

- New interactive shell **`hexsh`** (no zsh / bash / fish involved).
- Line editor with cursor movement (←/→/Home/End/Ctrl+A/E), word jumps
  (Alt+B/F, Ctrl+W), kill/yank (Ctrl+U/K/Y), persistent history (5000
  entries, deduped, stored under `~/.local/share/hexshell/history`).
- Fish-style autosuggestions from history; accept with → or End.
- Tab completion for commands (`PATH` + builtins + aliases) and file
  paths (with hidden-file unhide on `.` prefix and proper `~`/abs handling).
- Live syntax highlighting (commands green/red by existence, strings
  yellow, vars cyan, ops magenta, unterminated quotes underlined red).
- Builtins: `cd`, `pwd`, `export`, `unset`, `alias`, `unalias`,
  `history`, `clear`, `which`, `set`, `help`, `exit`, `ls`/`ll`/`la`,
  `sys`. Default aliases `ll`/`la`/`l`.
- Operators: `;` `&&` `||` `|` `>` `>>` `<` `2>` `&`. Single commands
  run via `node-pty` directly; pipelines and redirections route through
  `/bin/sh -c`. Builtins always run in-process.
- Per-command ephemeral PTY — full TUI app support (`vim`, `htop`,
  `btop`, `git log`, `less`).

### HUD / UX

- Frameless fullscreen window with HUD chrome, scanlines, subtle
  flicker, grid overlay; all overlays GPU-only (transform + opacity),
  zero text repaint. `prefers-reduced-motion` honored.
- Top bar: `[ SYSTEM ]` menu, `HEXSHELL` brand + version chip,
  `SHELL:` indicator, centered Orbitron 24-hour clock with phosphor
  glow + tabular digits, `LINK:` status, minimize / fullscreen / close
  controls.
- `[ SYSTEM ]` dropdown: Reload, Clear, Settings, System info, Exit
  with full keyboard navigation (arrow keys, Home/End, Esc).
- **Settings** modal (persisted in `localStorage`):
  - Cursor shape — Block / I-beam / Underline.
  - Audio — Key click / Error chime / Process loop toggles, master
    volume slider.
  - **Don't show on launch** for the OS splash.
- **OS splash** with bundled Simple Icons brand SVGs (24 distros),
  fastfetch-class info readout (kernel, host, uptime, packages, DE/WM,
  theme/font, CPU + base clock, GPU from lspci, memory + swap + disk,
  primary IPv4, locale, node + electron versions). Two-column
  multicolumn layout that adapts to width; CPU/GPU rows nowrap with
  ellipsis safety net and `title=` hover tooltips.

### Audio

- Bundled WAVs for startup chime, key click, command-error chime, and
  process-loop ambient.
- WebAudio mixer with per-kind gain nodes and a master gain. Click
  jitter (±5% playbackRate) for an organic mechanical feel; throttled
  retriggers; bounded voice cap.
- Process loop only fires on **real install/download activity** —
  state machine waits for keyword matches in the program's output, so
  `sudo` password prompts stay silent. The loop pauses on
  confirmation prompts (`[Y/n]`, `Username for...:` etc.) and resumes
  when the install activity continues.
- Long-running command detection covers pacman / paru / yay / apt /
  dnf / zypper / apk / npm / yarn / pnpm / bun / pip / pipx / uv /
  cargo / go / docker / make / cmake / ninja / wget / aria2c /
  `curl -O` / `git clone|pull|fetch|push`. `sudo` / `doas` / `pkexec`
  wrappers are peeled before matching.

### Animations

- **Retro CRT power-on / power-off** for the window. Three-stage
  vertical-collapse-to-line-to-dot animation, GPU-cheap
  (transform/filter/opacity only). Plays around exit so users see the
  full collapse before the window closes; safety timeout hard-falls to
  `app.quit()` if `animationend` ever stalls.
- **Staged boot**: when the OS splash auto-opens at launch, the
  terminal stays hidden. Splash plays its own CRT-on against a black
  backdrop; on dismiss, splash plays CRT-off, then the terminal plays
  CRT-on.

### Iconography

- **Custom Nerd Fonts iconography system** (~150 mappings) for files,
  directories, language ecosystems, build tools, packagers, archives,
  media, distros. Lookup priority: symlink → directory + name →
  exact filename → compound extension (`.tar.gz`, `.pkg.tar.zst`) →
  single extension → hidden / executable / fallback. Backed by the
  upstream `glyphnames.json` cheat sheet (auto-fetched at install
  time) so contributors add glyphs by canonical name, not codepoint.
- Bundled MesloLGL Nerd Font Mono (4 weights) and Orbitron variable
  weight font.

### Security

- Hardened Electron defaults: `contextIsolation: true`,
  `nodeIntegration: false`, no remote module, single-instance lock,
  navigation blocked, window-open routed externally only for http(s).
- Strict CSP (`default-src 'self'`, `connect-src 'self'` for the
  generated JSON files, `media-src 'self'` for audio).
- All IPC validates `event.sender === mainWindow.webContents`. Renderer
  cannot supply shell path or cwd to the spawn flow.
- Selection writes to PRIMARY only by default; explicit copy via
  Ctrl+Shift+C / right-click also writes to CLIPBOARD. Standard
  Linux convention.

### Mouse

- Drag-to-select with auto-write to PRIMARY (X11/Wayland selection).
- Middle-click pastes from PRIMARY.
- Right-click copies selection (or pastes CLIPBOARD if no selection).
- Ctrl+Shift+C / Ctrl+Shift+V keyboard fallbacks. Plain Ctrl+C still
  sends SIGINT.

### Distribution

- Linux artifacts: AppImage, `.deb`, `.rpm`, `.pacman`, `.tar.xz`
  for both `x64` and `arm64`. AUR `-bin` PKGBUILD wrapping the
  AppImage.
- GitHub Actions workflow auto-builds and drafts a release on every
  `v*.*.*` tag push.
- `bun run release` for local one-shot release builds.
