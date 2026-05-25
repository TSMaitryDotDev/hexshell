# Hexshell

A fullscreen sci-fi terminal built on **Electron**, **xterm.js** and **node-pty**, managed with **Bun**. Inspired by the look of eDEX-UI, stripped down to a single, focused thing: a beautiful, real terminal.

No widgets. No system monitor. No tabs. Just a phosphor-green CRT that runs your shell.

![status](https://img.shields.io/github/v/release/TSMaitryDotDev/hexshell?label=release)
![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/platform-Linux-blue)

## Install

All download URLs use `/releases/latest/` so they always pull the newest version. Replace `latest` with a specific tag like `v0.1.3` if you want to pin.

### Arch Linux (recommended)

```bash
paru -S hexshell-bin    # or: yay -S hexshell-bin
```

The AUR `-bin` package wraps the prebuilt AppImage. Auto-updates flow through your AUR helper; no Electron rebuild needed (which would otherwise take hours and 10+ GB scratch).

If you'd rather drop in a `.pacman` directly:

```bash
curl -LO https://github.com/TSMaitryDotDev/hexshell/releases/latest/download/Hexshell-0.1.3-x64.pacman
sudo pacman -U Hexshell-*-x64.pacman
```

### Debian / Ubuntu / Mint / Pop!_OS / Kali

```bash
curl -LO https://github.com/TSMaitryDotDev/hexshell/releases/latest/download/Hexshell-0.1.3-amd64.deb
sudo apt install ./Hexshell-*-amd64.deb
```

`apt install ./<file>.deb` (with the `./`) pulls runtime dependencies; `dpkg -i` on its own won't.

### Fedora / RHEL / openSUSE / Rocky / Alma

```bash
sudo dnf install https://github.com/TSMaitryDotDev/hexshell/releases/latest/download/Hexshell-0.1.3-x86_64.rpm
```

(Substitute `zypper`, `rpm -i`, etc. as appropriate for your distro.)

### Any Linux (AppImage)

```bash
curl -LO https://github.com/TSMaitryDotDev/hexshell/releases/latest/download/Hexshell-0.1.3-x86_64.AppImage
chmod +x Hexshell-*.AppImage
./Hexshell-*.AppImage
```

The AppImage is self-mounting via FUSE and runs on any Linux with glibc 2.17+ (CentOS 7, Ubuntu 14.04, anything newer).

### Manual / unsupported distros (tar.xz)

```bash
curl -LO https://github.com/TSMaitryDotDev/hexshell/releases/latest/download/Hexshell-0.1.3-x64.tar.xz
sudo tar -xJf Hexshell-*-x64.tar.xz -C /opt
sudo ln -s /opt/Hexshell/hexshell /usr/local/bin/hexshell
# Optional: setuid the sandbox helper for proper Chromium isolation.
sudo chmod 4755 /opt/Hexshell/chrome-sandbox
```

### Verify downloads

Every release ships a `SHA256SUMS` file:

```bash
curl -LO https://github.com/TSMaitryDotDev/hexshell/releases/latest/download/SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
```

## Features

- **hexsh** — built-in interactive shell. No bash / zsh / fish dependency.
  - Fish-style autosuggestions from history, accept with `→` or End.
  - Tab completion for commands (`PATH` + builtins + aliases) and file paths.
  - Live syntax highlighting (commands green/red by existence, strings yellow, vars cyan, ops magenta).
  - Persistent history at `~/.local/share/hexshell/history` — 5000 entries, deduped.
  - Builtins: `cd`, `pwd`, `export`, `unset`, `alias`, `unalias`, `history`, `clear`, `which`, `set`, `help`, `exit`, `ls` / `ll` / `la`, `sys`.
  - Operators: `;`, `&&`, `||`, `|`, `>`, `>>`, `<`, `2>`, `&`.
  - External programs run through ephemeral `node-pty` sessions — `vim`, `htop`, `btop`, `git log`, `less` all work with full color and resize.
- **Frameless fullscreen window** with a cyberpunk HUD: animated frame, corner brackets, CRT scanlines, subtle flicker, grid overlay.
- **Bundled fonts** — MesloLGL Nerd Font Mono (terminal grid) + Orbitron (HUD clock). Powerline glyphs and Nerd Font icons (starship, p10k, lsd, eza) work out of the box.
- **OS splash** with official distro logos from [Simple Icons](https://simpleicons.org/), fastfetch-class info readout (kernel / packages / DE / WM / theme / GPU / memory / disk / IP / locale).
- **Settings modal** — cursor shape (block / I-beam / underline), audio toggles (key click / error chime / process loop), master volume.
- **Audio** — startup chime, key click, command-error chime, ambient process loop during installs / downloads. WebAudio mixer with per-kind gain. Process loop only runs on real install activity (not during `sudo` password prompts).
- **Retro CRT power-on / power-off** animations on launch and exit.
- **Custom Nerd Font iconography system** for files, folders, languages, archives, etc. — backed by the upstream `glyphnames.json` cheat sheet.
- **Hardened Electron**: `contextIsolation: true`, `nodeIntegration: false`, no remote, strict CSP, validated IPC.

## Keyboard shortcuts

| Shortcut         | Action                                       |
| ---------------- | -------------------------------------------- |
| `F11`            | Toggle fullscreen                            |
| `Ctrl+Shift+R`   | Reload (resets the shell)                    |
| `Ctrl+Shift+Q`   | Quit (with CRT shutdown animation)           |
| `Ctrl+Shift+S`   | Screenshot via system tool (flameshot, etc.) |
| `Ctrl+Shift+C`   | Copy selection                               |
| `Ctrl+Shift+V`   | Paste from clipboard                         |
| Right-click      | Copy selection if any, else paste            |
| Middle-click     | Paste from PRIMARY (X11/Wayland)             |
| `Ctrl+C`         | SIGINT to running command (untouched)        |

Everything else is forwarded straight to your shell.

## Build from source

You generally don't need to — install via your distro's package manager above. But if you want to hack on it:

```bash
# 1. Install Bun (if not already)
curl -fsSL https://bun.sh/install | bash
# or: paru -S bun-bin   (AUR)

# 2. Install build toolchain
sudo pacman -S --needed base-devel python git unzip librsvg     # Arch
sudo apt install build-essential python3 git unzip librsvg2-bin # Debian

# 3. Clone + install
git clone https://github.com/TSMaitryDotDev/hexshell
cd hexshell
bun install        # downloads Electron + node-pty + fonts + glyphs + logos
bun run start
```

`bun install` runs lifecycle scripts only for the four packages we vetted (`electron`, `electron-builder`, `@electron/rebuild`, `node-pty`) — see `trustedDependencies` in `package.json`. Everything else is blocked by Bun's supply-chain default.

You **don't** need Node installed; Bun ships its own JavaScript runtime, and Electron carries its own Node binary internally.

### Common scripts

```bash
bun run start             # launch in dev mode
bun run dev               # same with --enable-logging
bun run rebuild           # rebuild node-pty for current Electron version
bun run fonts             # re-download MesloLGL + Orbitron
bun run glyphs            # re-fetch Nerd Fonts glyphnames.json
bun run logos             # re-bundle Simple Icons distro SVGs
bun run dist:appimage     # build one format
bun run dist:all          # build all five Linux formats
bun run release           # one-shot driver: build + checksum + summary
bun run clean             # nuke dist + node_modules + bun caches
```

## Architecture

```
src/
├── main/                    # Electron main process
│   ├── main.js              # window + IPC + global shortcuts
│   ├── screenshot.js        # detect + invoke system screenshot tool
│   └── shell/               # hexsh — the in-process interactive shell
│       ├── hexsh.js         # state machine: editing <-> running
│       ├── editor.js        # line editor (keys, redraw, cursor math)
│       ├── parser.js        # lossless tokenizer + pipeline parser
│       ├── env.js           # vars, aliases, cwd, expansion, prompt
│       ├── history.js       # persistent history + autosuggestion source
│       ├── highlighter.js   # ANSI coloring driven by token stream
│       ├── completer.js     # tab completion + PATH cache
│       ├── builtins.js      # cd / pwd / export / alias / ls / sys / etc.
│       ├── executor.js      # ephemeral node-pty per external command
│       ├── icons.js         # file/folder Nerd Font icon mapping
│       └── sysinfo.js       # gather OS / CPU / GPU / packages / DE / WM
├── preload/preload.js       # contextBridge — the only renderer ↔ main seam
├── renderer/                # xterm.js UI, no Node access
│   ├── index.html           # locked-down CSP, layered HUD scaffolding
│   ├── renderer.js          # xterm boot + IPC wiring + clock + cleanup
│   ├── system.js            # SYSTEM menu + Settings modal + OS splash
│   ├── audio.js             # WebAudio mixer (chime / click / error / loop)
│   ├── os-logos.js          # bundled Simple Icons distro SVGs
│   └── fonts/               # MesloLGL + Orbitron (downloaded by bun install)
├── ipc/channels.js          # shared IPC channel names
├── styles/                  # reset, terminal theme, HUD chrome
└── audio/                   # bundled WAVs (startup, click, error, process)
```

### IPC flow

```
xterm.onData ──▶ preload.write ──▶ ipc 'terminal:write' ──▶ main ──▶ pty.write
pty.onData   ──▶ ipc 'terminal:data' ──▶ preload.onData ──▶ xterm.write
ResizeObserver ──▶ preload.resize ──▶ ipc 'terminal:resize' ──▶ pty.resize
shell-bell ──▶ ipc 'terminal:bell' ──▶ renderer hexAudio.{error|process-start|process-stop}
```

Channel names live in `src/ipc/channels.js` so main, preload, and renderer can't drift.

### Shell lifecycle

Hexsh has no long-lived shell process. Each external command (or pipeline) gets a fresh `node-pty` session that's disposed when the command exits. Single foreground commands spawn directly; pipelines and redirections route through `/bin/sh -c` after variable expansion. Builtins (`cd`, `export`, `alias`, …) run inside the main process — never in a child.

### Resize strategy

A `ResizeObserver` on the terminal container schedules at most one `requestAnimationFrame` callback. That callback runs `fit.fit()`, computes proposed cols/rows, and only sends IPC if they differ from the last value. Handles fullscreen toggles, drag-resizes, and DPI changes uniformly without flooding the PTY.

### Rendering strategy

xterm.js uses its default DOM renderer. All sci-fi effects are CSS layers stacked above the terminal with `pointer-events: none`. Animations are `transform` and `opacity` only, so they live on the GPU compositor and don't trigger layout or text repaint. `prefers-reduced-motion` disables all animated overlays.

## Maintainer / packaging docs

For release flow, distro packaging notes, AUR push procedure, and recipes (hotfix release, AUR-only fix, rollback, etc.) see [`hexsh.md`](./hexsh.md).

## License

[MIT](./LICENSE).
