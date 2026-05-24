# Hexshell

A fullscreen sci-fi terminal built on **Electron**, **xterm.js** and **node-pty**, managed with **Bun**. Inspired by the look of eDEX-UI, stripped down to a single, focused thing: a beautiful, real terminal.

No widgets. No system monitor. No tabs. Just a phosphor-green CRT that runs your shell.

## Install

### Arch Linux (recommended)

```bash
paru -S hexshell-bin   # or: yay -S hexshell-bin
```

The AUR `-bin` package wraps the pre-built AppImage. Auto-updates flow through your AUR helper; no Electron rebuild required (which would otherwise take hours and 10+ GB of scratch space).

If you prefer the `.pacman` directly:

```bash
curl -LO https://github.com/hexshell/hexshell/releases/download/v0.1.0/Hexshell-0.1.0-x64.pacman
sudo pacman -U Hexshell-0.1.0-x64.pacman
```

### Debian, Ubuntu, Mint, Pop!_OS, Kali

```bash
curl -LO https://github.com/hexshell/hexshell/releases/download/v0.1.0/hexshell_0.1.0_amd64.deb
sudo apt install ./hexshell_0.1.0_amd64.deb
```

### Fedora, RHEL, openSUSE, Mageia

```bash
sudo dnf install https://github.com/hexshell/hexshell/releases/download/v0.1.0/hexshell-0.1.0.x86_64.rpm
```

### Any Linux (AppImage)

```bash
curl -LO https://github.com/hexshell/hexshell/releases/download/v0.1.0/Hexshell-0.1.0-x64.AppImage
chmod +x Hexshell-0.1.0-x64.AppImage
./Hexshell-0.1.0-x64.AppImage
```

### Manual / unsupported distros (tar.xz)

```bash
curl -LO https://github.com/hexshell/hexshell/releases/download/v0.1.0/Hexshell-0.1.0-x64.tar.xz
sudo tar -xJf Hexshell-0.1.0-x64.tar.xz -C /opt
sudo ln -s /opt/Hexshell/hexshell /usr/local/bin/hexshell
```

ARM64 builds (`-arm64.AppImage`, `_arm64.deb`, `.aarch64.rpm`, `.aarch64.pacman`, `-arm64.tar.xz`) are published alongside x64.

### Verify downloads

Every release ships `SHA256SUMS`:

```bash
sha256sum -c SHA256SUMS --ignore-missing
```

## Features

- **hexsh** — built-in interactive shell. No bash, no zsh, no fish.
  - Single-line phosphor prompt with cwd + last-exit indicator
  - Live syntax highlighting (known cmd green, unknown red, strings yellow, vars cyan, ops magenta)
  - Fish-style autosuggestions from history (accept with → / End)
  - Tab completion for commands (PATH + builtins + aliases) and file paths
  - Persistent history at `~/.local/share/hexshell/history` (5000 entries, deduped)
  - Builtins: `cd`, `pwd`, `export`, `unset`, `alias`, `unalias`, `history`, `clear`, `which`, `set`, `help`, `exit`
  - Operators: `;` `&&` `||` `|` `>` `>>` `<` `2>` `&`
  - External programs run through ephemeral PTYs, so `vim`, `htop`, `btop`, `git log`, `less` all work with full color
- Frameless, fullscreen Electron window
- Bundled **MesloLGL Nerd Font Mono** — powerline glyphs and icons (starship / p10k / lsd) work out of the box
- Cyberpunk HUD: static frame, corner brackets, CRT scanlines, subtle flicker, grid overlay
- xterm.js with FitAddon, web-links, 256/truecolor, unicode, 5000-line scrollback
- GPU-friendly CSS effects (transform/opacity only, no per-frame filters)
- Hardened Electron: `contextIsolation: true`, `nodeIntegration: false`, no remote, strict CSP, validated IPC
- Resize coalesced to one rAF; only sends IPC when cell dims actually change

## Why Bun (and what Bun is *not* doing here)

Bun is the **package manager and task runner** for this project. It installs faster than npm, gives us a single deterministic `bun.lock`, and runs scripts directly.

Bun does **not** replace Electron's runtime. When you launch the app, Electron uses its own bundled Node/V8 for the main process and Chromium for the renderer. The source code under `src/` is plain CommonJS that Electron executes; Bun just orchestrates dependencies and scripts around it.

## Requirements (Arch Linux)

```bash
# Bun
curl -fsSL https://bun.sh/install | bash
# or: paru -S bun-bin   (AUR)

# Native build toolchain for node-pty + unzip for the font fetcher
sudo pacman -S --needed base-devel python git unzip
```

You do not need Node installed; Bun ships its own JavaScript runtime, and Electron carries its own Node binary internally.

## Build from source

```bash
git clone https://github.com/hexshell/hexshell
cd hexshell
bun install         # respects trustedDependencies in package.json:
                    #   - downloads the Electron binary
                    #   - builds node-pty native bindings
                    #   - postinstall runs `bun run fonts` (downloads
                    #     MesloLGL Nerd Font Mono into src/renderer/fonts)
                    #   - then runs electron-builder install-app-deps to
                    #     rebuild node-pty against Electron's Node ABI
bun run start
```

If you ever see `Error: The module ... was compiled against a different Node.js version`:

```bash
bun run rebuild
```

### Why `trustedDependencies` matters

Bun blocks lifecycle scripts (`postinstall`, native builds) by default — a supply-chain mitigation. Hexshell needs them for `electron`, `node-pty`, `@electron/rebuild`, and `electron-builder`. They're listed under `trustedDependencies` in `package.json`, so `bun install` runs only those scripts and refuses to run lifecycle scripts from anything else.

## Fonts

Hexshell bundles **MesloLGL Nerd Font Mono** so terminal prompts that use powerline / Nerd Font icons (starship, powerlevel10k, oh-my-zsh themes, `lsd`, `eza`) render correctly with no system font setup.

The TTFs are not committed to git. They're fetched on `bun install` (or via `bun run fonts` on demand) from the [Nerd Fonts release](https://github.com/ryanoasis/nerd-fonts/releases) into `src/renderer/fonts/`. The renderer awaits `document.fonts.ready` before xterm.js measures cell size, so the grid never reflows when the font loads.

Licensing: Meslo is Apache-2.0 (Andre Berg, based on Apple's Menlo / Bitstream Vera Sans Mono). The Nerd Fonts patches are SIL OFL 1.1. Both permit redistribution; `LICENSE.font` files travel with the AppImage.

If you'd rather use a different face, edit `src/renderer/fonts/fonts.css` and the `fontFamily` field in `src/renderer/renderer.js`. Anything monospaced will work; xterm needs accurate cell metrics, which means a true monospace face (not a "ligatures everywhere" variable-width one).

## Keyboard shortcuts

| Shortcut       | Action              |
|----------------|---------------------|
| `F11`          | Toggle fullscreen   |
| `Ctrl+Shift+R` | Reload (resets PTY) |
| `Ctrl+Shift+Q` | Quit                |

Everything else is forwarded straight to your shell.

## Architecture

```
src/
├── main/
│   ├── main.js        # Electron lifecycle + IPC + window
│   └── shell/         # hexsh, the interactive shell
│       ├── hexsh.js   # state machine: editing <-> running
│       ├── editor.js  # line editor (keys, redraw, cursor math)
│       ├── parser.js  # lossless tokenizer + pipeline parser
│       ├── env.js     # vars, aliases, cwd, expansion, prompt
│       ├── history.js # persistent history + autosuggest source
│       ├── highlighter.js  # ANSI coloring driven by token stream
│       ├── completer.js    # Tab completion + PATH cache
│       ├── builtins.js     # cd / pwd / export / alias / etc.
│       └── executor.js     # ephemeral node-pty per external command
├── preload/   # contextBridge boundary
├── renderer/  # xterm.js UI, no Node access
├── ipc/       # shared channel names
└── styles/    # reset, terminal theme, HUD chrome
```

### IPC flow

```
xterm.onData ─▶ preload.write ─▶ ipc 'terminal:write' ─▶ main ─▶ pty.write
pty.onData   ─▶ ipc 'terminal:data' ─▶ preload.onData ─▶ xterm.write
ResizeObserver ─▶ preload.resize ─▶ ipc 'terminal:resize' ─▶ pty.resize
pty.onExit   ─▶ ipc 'terminal:exit' ─▶ renderer banner
```

Channel names live in `src/ipc/channels.js` so main, preload, and renderer cannot drift.

### PTY lifecycle

Hexsh has no long-lived shell process. Each external command (or pipeline) gets a fresh `node-pty` session that's disposed when the command exits. Single foreground commands are spawned directly; pipelines and redirections are routed through `/bin/sh -c` after we've done variable expansion. Builtins (`cd`, `export`, `alias`…) run inside the main process, never in a child.

### Resize strategy

A `ResizeObserver` on the terminal container schedules at most one `requestAnimationFrame` callback. That callback runs `fit.fit()`, computes proposed cols/rows, and only sends IPC if they differ from the last value sent.

### Rendering strategy

xterm.js uses its default DOM renderer. All sci-fi effects are CSS layers stacked above with `pointer-events: none`. Animations are `transform` and `opacity` only, so they live on the GPU compositor and don't trigger layout or text repaint.

## Packaging & releases (maintainers)

Hexshell ships five Linux artifact formats per architecture, plus an AUR `-bin` package. CI does this automatically on every `v*.*.*` tag push.

### Build all artifacts locally

```bash
bun run dist:all          # AppImage + deb + rpm + pacman + tar.xz
bun run checksums         # writes dist/SHA256SUMS

# Or one format at a time:
bun run dist:appimage
bun run dist:deb
bun run dist:rpm
bun run dist:pacman
bun run dist:tar
```

You'll need a few system packages on the build host:

```bash
# Arch
sudo pacman -S --needed rpm-tools dpkg fakeroot binutils xz librsvg unzip
# Debian/Ubuntu
sudo apt install rpm fakeroot dpkg-dev xz-utils librsvg2-bin unzip
```

`bun run icon` rasterises `build/icon.svg` to `build/icon.png` (electron-builder needs a 512×512 PNG; SVG icons would be re-rastered per format with worse hinting).

### Cut a release

```bash
# 1. Bump version
$EDITOR package.json
git commit -am "chore: 0.2.0"

# 2. Build + checksum
bun run release           # refuses if working tree is dirty or tag exists

# 3. Tag and push
git tag -a v0.2.0 -m "Release v0.2.0"
git push origin main v0.2.0
```

The push triggers `.github/workflows/release.yml`, which builds x64 and arm64 in parallel and creates a draft GitHub Release with all artifacts and `SHA256SUMS` attached. Edit the notes, click Publish.

### Update the AUR `-bin` package

Lives in `packaging/aur/hexshell-bin/`. After a release:

1. Edit `pkgver` in `PKGBUILD`.
2. `updpkgsums` to rewrite `sha256sums_*` from the new release URLs.
3. `makepkg --printsrcinfo > .SRCINFO`.
4. Commit + push to the AUR git repo.

### Why these formats

- **AppImage** — universal Linux, no install needed, ideal "just works" path.
- **.pacman** — first-class on Arch; `sudo pacman -U` integrates with the package db.
- **AUR `-bin`** — the path most Arch users actually take; gets auto-updates via `paru`/`yay`.
- **.deb** — Debian-family distros (~60% of Linux desktops).
- **.rpm** — Red Hat-family distros.
- **.tar.xz** — Slackware, Void, Gentoo, NixOS, anyone who wants to inspect or repack.

## Common Bun commands

```bash
bun install              # install deps + run trusted lifecycle scripts
bun run start            # launch Electron in dev mode
bun run dev              # same with --enable-logging
bun run fonts            # (re)download MesloLGL Nerd Font Mono
bun run rebuild          # rebuild node-pty for current Electron version
bun run dist:linux       # build AppImage
bun run clean            # remove dist, node_modules, bun caches
bun add <pkg>            # add a runtime dep
bun add -d <pkg>         # add a dev dep
bun update               # update lockfile
bun pm ls                # list installed packages
```

## License

MIT.
