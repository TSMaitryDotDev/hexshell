# Hexshell — Maintainer Handbook

Operational notes for cutting releases, packaging Hexshell for every Linux
distro family, and pushing updates to the Arch User Repository.

This is a working doc — every command was run during the 0.1.0 / 0.1.1
releases. If something here doesn't work next time, fix the doc, don't
work around it.

---

## Table of contents

1. [Repo layout cheat sheet](#1-repo-layout-cheat-sheet)
2. [Daily development](#2-daily-development)
3. [Versioning policy](#3-versioning-policy)
4. [Release flow — TL;DR](#4-release-flow--tldr)
5. [Building artifacts locally](#5-building-artifacts-locally)
6. [GitHub release pipeline](#6-github-release-pipeline)
7. [AUR `hexshell-bin` package](#7-aur-hexshell-bin-package)
8. [Notes per distro family](#8-notes-per-distro-family)
9. [Things that broke during 0.1.x and what fixed them](#9-things-that-broke-during-01x-and-what-fixed-them)
10. [Recipes](#10-recipes)

---

## 1. Repo layout cheat sheet

```
src/                        Application source (Electron main, preload, renderer)
scripts/                    Build-time helpers (font fetch, glyph fetch, release driver)
build/                      Icon assets for electron-builder (icon.svg + icon.png)
images/                     User-facing screenshots (README preview, social card)
packaging/aur/hexshell-bin/ AUR PKGBUILD + .SRCINFO mirror (source of truth lives on AUR git)
.github/workflows/          GitHub Actions: release.yml builds + publishes on tag push
electron-builder.yml        Per-target build config (deb / rpm / pacman / AppImage / tar.xz)
package.json                Version + npm scripts; "version" is the release version
CHANGELOG.md                User-facing release notes; follows Keep a Changelog
README.md                   User-facing landing page (install, features, shortcuts)
hexsh.md                    THIS FILE — maintainer handbook
```

Things that **never** belong in git:

- `dist/`               (build output)
- `node_modules/`
- `src/renderer/fonts/*.ttf`             (downloaded by `bun run fonts`)
- `src/main/shell/glyphnames.generated.json`  (downloaded by `bun run glyphs`)
- `src/renderer/os-logos.generated.json`      (downloaded by `bun run logos`)
- AppImages, `.deb`, `.rpm`, `.pacman`, `.tar.xz` (build outputs;
  the AUR clone has its own `.gitignore` for makepkg artifacts)

`.gitignore` already covers these. The fetchers are idempotent — `bun install`
runs them via `postinstall`.

---

## 2. Daily development

```bash
bun install         # downloads Electron + node-pty + fonts + glyphs + logos
bun run start       # launches Hexshell from source
bun run dev         # same with --enable-logging for Electron
```

Reload the renderer at runtime with `Ctrl+Shift+R`. Quit with `Ctrl+Shift+Q`.
DevTools are off by default; if you need them, temporarily add
`mainWindow.webContents.openDevTools({ mode: 'detach' })` to
`src/main/main.js` and remember to remove before committing.

---

## 3. Versioning policy

We follow [SemVer](https://semver.org/) on the patch axis aggressively:

- `0.x.y` — pre-1.0; minor tweaks bump `y`.
- `0.x.0` — bump `x` for any user-visible feature.
- `1.0.0` — first stable release.

Bump in **one place**: `package.json` → `"version"`. Everything else
(electron-builder filenames, AUR PKGBUILD, banner chip in the titlebar,
artifact URLs) reads from there.

For each release also:

1. Add a `## [x.y.z] — YYYY-MM-DD` entry to `CHANGELOG.md`. Sections:
   `Added / Changed / Removed / Fixed / Security`. Skip empty ones.
2. Mirror the PKGBUILD's `pkgver` and reset `pkgrel=1` (see §7).

---

## 4. Release flow — TL;DR

The fast path, when nothing's broken:

```bash
# 1. Bump version + edit changelog
$EDITOR package.json          # "version": "0.1.1"
$EDITOR CHANGELOG.md          # add new section at the top
$EDITOR packaging/aur/hexshell-bin/PKGBUILD   # bump pkgver, reset pkgrel=1

# 2. Commit
git add -A
git commit -m "Release 0.1.1: <one-line summary>"
git push

# 3. Tag — this fires CI which builds + drafts the GitHub release
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin v0.1.1

# 4. Wait for CI to go green (~6–10 min)
gh run watch $(gh run list --limit 1 --json databaseId -q '.[0].databaseId') --exit-status

# 5. Publish the draft GitHub release (CI creates it as draft on purpose
#    so you can eyeball assets before users see them)
gh release edit v0.1.1 --draft=false

# 6. Push the AUR update (regenerate .SRCINFO first)
bash -c "cd /tmp/hexshell-bin && git pull && cp ~/Projects/Hexshell/packaging/aur/hexshell-bin/PKGBUILD . && \
  makepkg --printsrcinfo > .SRCINFO && \
  git add PKGBUILD .SRCINFO && \
  git commit -m 'hexshell-bin 0.1.1-1: bump to upstream v0.1.1' && \
  git push"

# 7. Smoke-test from a clean machine (or wipe ~/.cache/yay/hexshell-bin
#    locally and re-install). Walk through:
#      - yay -Syu hexshell-bin              picks up the new version
#      - hexshell                            launches without --no-sandbox
#      - LINK status flips ESTABLISHING -> ACTIVE
#      - SHELL label resolves to 'hexsh'
#      - cursor blinks, clock ticks
#    If any of those fail, the failure goes in §9 and the fix in this
#    page in the SAME commit as the code fix.
```

Everything below is the long version.

---

## 5. Building artifacts locally

### 5.1. What gets built

`electron-builder.yml` produces five Linux formats per arch:

| Format     | Distro family                                                  |
| ---------- | -------------------------------------------------------------- |
| `AppImage` | universal (any glibc-modern Linux 2017+)                        |
| `.deb`     | Debian / Ubuntu / Mint / Pop!_OS / Kali / Parrot                |
| `.rpm`     | Fedora / RHEL / openSUSE / Mageia / Rocky / Alma                |
| `.pacman`  | Arch / Manjaro / EndeavourOS / Garuda / Artix                   |
| `.tar.xz`  | fallback (Slackware / Void / Gentoo / NixOS / manual installs)  |

Plus the AUR `hexshell-bin` package (§7) which is **not** built by
electron-builder; it wraps the AppImage.

### 5.2. System packages required

```bash
# Arch
sudo pacman -S --needed nodejs-lts-iron base-devel python git unzip \
                        librsvg fakeroot libarchive
# (rpm builds fail on modern Arch; let CI handle them — see §9.1)

# Debian / Ubuntu
sudo apt install rpm fakeroot dpkg-dev xz-utils librsvg2-bin \
                 libsecret-1-dev libarchive-tools unzip
```

`bun` itself: `curl -fsSL https://bun.sh/install | bash` if you don't
have it (`paru -S bun-bin` on Arch).

### 5.3. Build commands

```bash
bun run dist:appimage     # one format
bun run dist:deb
bun run dist:rpm          # may fail on Arch; CI handles it
bun run dist:pacman
bun run dist:tar
bun run dist:all          # all five (chains; aborts on first failure)
bun run checksums         # writes dist/SHA256SUMS for whatever's there
```

The icon SVG is rasterised separately by `bun run icon`. `bun install`
already does this; only re-run if you edit `build/icon.svg`.

Output lives in `dist/`. Artifacts are named like:

```
Hexshell-<ver>-x86_64.AppImage
Hexshell-<ver>-amd64.deb
Hexshell-<ver>-x86_64.rpm
Hexshell-<ver>-x64.pacman
Hexshell-<ver>-x64.tar.xz
```

The arch suffix is **not** consistent across formats (electron-builder /
fpm decisions). The AUR PKGBUILD hard-codes the AppImage filename; if
you ever change formats or rename, update the `source=()` line.

### 5.4. One-shot release driver

```bash
bun run release       # refuses if working tree dirty or tag exists
```

This calls `dist:all`, generates `SHA256SUMS`, and prints the next
manual steps. It deliberately stops short of pushing anything — releases
are one-way doors.

---

## 6. GitHub release pipeline

### 6.1. What happens on `git push origin vX.Y.Z`

`.github/workflows/release.yml` runs:

1. Job `linux (x64)` on `ubuntu-22.04`:
   - `bun install` (postinstall pulls fonts / glyphs / simple-icons)
   - `bun run icon` rasterises the icon
   - `bun run dist:all -- --x64 --publish never` — five artifacts
   - `bun run checksums`
   - Upload all five plus `SHA256SUMS` as a workflow artifact
2. Job `release` (only on tag push):
   - `actions/download-artifact` pulls the workflow's outputs
   - Concatenates `SHA256SUMS` files (if multi-arch later)
   - `softprops/action-gh-release` creates a **draft** release with
     `generate_release_notes: true` and attaches every file

### 6.2. Publishing the draft

CI leaves the release as a draft so you can review before users see it:

```bash
gh release view v0.1.1                      # confirm assets attached
gh release edit v0.1.1 --draft=false        # publishes
```

If you want to add or replace files after publishing:

```bash
gh release upload v0.1.1 dist/Hexshell-*.AppImage --clobber
```

### 6.3. Why arm64 isn't built

The workflow has the arm64 matrix entry commented out:

```yaml
# - arch: arm64
#   runner: ubuntu-22.04-arm
```

GitHub's free arm64 runners require a **public** repo. To enable arm64:

```bash
gh repo edit TSMaitryDotDev/hexshell --visibility public --accept-visibility-change-consequences
```

Then uncomment those lines and re-tag. Both arches will build in
parallel and the `release` job concatenates their SHA256SUMS files.

### 6.4. Common workflow failures (and what fixed them)

See [§9 — Things that broke](#9-things-that-broke-during-01x-and-what-fixed-them).

---

## 7. AUR `hexshell-bin` package

### 7.1. Why `-bin`

Building Electron from source on the AUR is a 2–3 hour job needing
10+ GB of scratch. Every popular Electron app on the AUR (vscode,
slack-desktop, discord, vscodium) ships a `-bin` flavor that wraps the
upstream AppImage. We do the same.

### 7.2. Source of truth

The AUR git repo at `ssh://aur@aur.archlinux.org/hexshell-bin.git` IS
the authoritative source for the AUR package. We mirror PKGBUILD and
.SRCINFO into `packaging/aur/hexshell-bin/` so the package source is
visible inside the GitHub repo, but **the AUR repo's history is what
matters** for users running `yay -S hexshell-bin`.

The mirror exists for:

- code review (PRs that touch packaging)
- regenerating after a clean clone
- recovering if the AUR repo is ever lost

### 7.3. First-time setup (on a new dev machine)

```bash
# 1. SSH key registered at https://aur.archlinux.org/account/<you>/edit
cat ~/.ssh/id_ed25519.pub      # paste into the "SSH Public Key" field
# 2. Clone
git clone ssh://aur@aur.archlinux.org/hexshell-bin.git /tmp/hexshell-bin
```

If you've never used the AUR over SSH before, the first push will ask
you to verify a host key — accept it.

### 7.4. Updating the AUR package

After bumping version + publishing the GitHub release:

```bash
cd /tmp/hexshell-bin
git pull                                           # always start fresh
cp ~/Projects/Hexshell/packaging/aur/hexshell-bin/PKGBUILD ./PKGBUILD

# Regenerate .SRCINFO from the new PKGBUILD. NEVER hand-edit it.
makepkg --printsrcinfo > .SRCINFO

# Sanity check: build it locally to make sure the GitHub release URL
# is reachable and the package installs cleanly.
makepkg -f --noconfirm
sudo pacman -U hexshell-bin-*-x86_64.pkg.tar.zst   # optional but recommended

# If all good, commit + push.
git add PKGBUILD .SRCINFO
git commit -m "hexshell-bin <ver>-<rel>: bump to upstream v<ver>"
git push
```

Within ~5 minutes `yay -Syu` will offer the new version to users.

### 7.5. What the PKGBUILD does

In `package()`:

1. Extracts the AppImage into `${pkgdir}/opt/Hexshell/`
2. Scrubs permissions so `/opt/Hexshell/resources/app.asar` is
   world-readable (the AppImage's squashfs preserves the build host's
   umask — without this, Electron exits silently).
3. Sets `chrome-sandbox` to `4755` (setuid root). Without this, on most
   Arch setups Electron silently exits because the sandbox helper
   refuses to start. Wrapper falls back to `--no-sandbox` on hardened
   distros where setuid is forbidden.
4. Installs `/usr/bin/hexshell` wrapper that exec's the binary.
5. Copies the icon into every standard hicolor size
   (16/24/32/48/64/128/256/512). Electron-builder writes it to a
   non-standard `0x0/` path which DEs ignore.
6. Writes a fresh `.desktop` entry under `/usr/share/applications/`.

### 7.6. AUR push gotchas

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Permission denied (publickey)` | SSH key not registered with your AUR account | Paste your `~/.ssh/id_ed25519.pub` at https://aur.archlinux.org/account |
| `maximum blob size (488.28KiB) exceeded` | Build artifacts (`src/`, `pkg/`, `*.pkg.tar.zst`) committed by accident | Reset history: `git reset --hard <good-commit>` ; the AUR clone has a `.gitignore` that prevents this — keep it |
| `403` on `https://...aur.archlinux.org/...` | AUR rejects HTTPS push | Use the SSH remote: `ssh://aur@aur.archlinux.org/hexshell-bin.git` |
| `cgit` shows old version | AUR's web cache | Wait 5–15 min; the git ref itself is updated immediately. `gh release` URL works for users right away. |

---

## 8. Notes per distro family

> URLs in this section use `/releases/latest/download/` so they never
> need bumping per release. GitHub redirects to the newest published
> tag automatically. Replace `latest` with a tag name (e.g. `v0.1.3`)
> when you need to pin a specific release for a bug report or
> reproducibility check.

### 8.1. Arch / Manjaro / EndeavourOS / Garuda / Artix

Two install paths:

```bash
# Recommended: AUR (auto-updates via paru/yay)
paru -S hexshell-bin
yay -S hexshell-bin

# Direct .pacman (no auto-updates; one-shot install)
curl -LO https://github.com/TSMaitryDotDev/hexshell/releases/latest/download/Hexshell-0.1.3-x64.pacman
sudo pacman -U Hexshell-*-x64.pacman
```

### 8.2. Debian / Ubuntu / Mint / Pop!_OS / Kali

```bash
curl -LO https://github.com/TSMaitryDotDev/hexshell/releases/latest/download/Hexshell-0.1.3-amd64.deb
sudo apt install ./Hexshell-*-amd64.deb
```

`apt install ./<file>.deb` (with the `./`) is preferred over `dpkg -i`
because it pulls runtime dependencies for you.

### 8.3. Fedora / RHEL / openSUSE / Rocky / Alma

```bash
sudo dnf install https://github.com/TSMaitryDotDev/hexshell/releases/latest/download/Hexshell-0.1.3-x86_64.rpm
# or zypper, or rpm -i
```

The `.rpm` is built on CI (Ubuntu's older rpmbuild plays nicely with
fpm; Arch's strict rpmbuild does not — see §9.1).

### 8.4. Any Linux (AppImage)

```bash
curl -LO https://github.com/TSMaitryDotDev/hexshell/releases/latest/download/Hexshell-0.1.3-x86_64.AppImage
chmod +x Hexshell-*.AppImage
./Hexshell-*.AppImage
```

Useful when the distro isn't packaged or you don't have root. AppImages
mount themselves via FUSE; if `appimage-launcher` is installed, double-
clicking the file integrates it into your app menu.

### 8.5. Slackware / Void / Gentoo / NixOS / manual

```bash
curl -LO https://github.com/TSMaitryDotDev/hexshell/releases/latest/download/Hexshell-0.1.3-x64.tar.xz
sudo tar -xJf Hexshell-*-x64.tar.xz -C /opt
sudo ln -s /opt/Hexshell/hexshell /usr/local/bin/hexshell
```

The tarball doesn't pre-set the `chrome-sandbox` setuid bit (we can't
do that from a tar.xz). On hardened systems you may need:

```bash
sudo chmod 4755 /opt/Hexshell/chrome-sandbox
```

…or run with `--no-sandbox`.

### 8.6. Verifying downloads

Every release includes `SHA256SUMS`:

```bash
curl -LO https://github.com/TSMaitryDotDev/hexshell/releases/latest/download/SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
```

---

## 9. Things that broke during 0.1.x and what fixed them

If you hit one of these on a future release, the fix is committed; this
section is the why so you don't undo it.

### 9.1. `rpmbuild` fails on Arch

- **Symptom**: `dist:rpm` fails with `File not found: ...resources/...` or
  exit code 1 from rpmbuild.
- **Root cause**: fpm's manifest path checking conflicts with modern
  Arch rpm's strict mode.
- **Fix**: don't build rpm locally on Arch. CI uses Ubuntu 22.04's
  older rpmbuild which is tolerant.

### 9.2. CI succeeds for AppImage/deb/rpm but fails on pacman

- **Symptom**: `pacman` step fails with `bsdtar: command not found`.
- **Root cause**: Ubuntu doesn't ship `bsdtar` by default; fpm needs it
  to build the .pacman MTREE.
- **Fix**: install `libarchive-tools` in the workflow's "Install Linux
  build deps" step (already done in `.github/workflows/release.yml`).

### 9.3. CI fails with "GitHub Personal Access Token is not set"

- **Symptom**: build succeeds but the run errors at the end.
- **Root cause**: electron-builder auto-publishes to GH releases when
  it sees a tag context, then needs `GH_TOKEN`. We use our own publish
  step instead.
- **Fix**: pass `--publish never` to electron-builder (already in the
  workflow's run step).

### 9.4. AUR install: "404 downloading AppImage"

- **Symptom**: `yay -S hexshell-bin` fails at the source download with
  `curl: (22) The requested URL returned error: 404`.
- **Root cause #1**: PKGBUILD points at the wrong filename. The release
  asset is `Hexshell-<ver>-x86_64.AppImage` (lowercase 's', `-x86_64`
  suffix). Old hand-written PKGBUILDs used `HexShell-<ver>.AppImage`.
- **Root cause #2**: GitHub repo is **private**. Release assets on
  private repos require an authenticated header; anonymous downloads
  return 404.
- **Fix #1**: keep the canonical PKGBUILD in `packaging/aur/hexshell-bin/`
  in sync; refresh the AUR mirror with it.
- **Fix #2**: keep the GitHub repo public.

### 9.5. AUR install succeeds but app doesn't launch / no icon

- **Symptom**: `hexshell` exits 0 with no output. App icon missing
  in panels.
- **Root cause #1**: `chrome-sandbox` lacks the setuid root bit.
- **Root cause #2**: `/opt/Hexshell/resources/` was packaged at mode
  0700 (build-host umask leaked through the AppImage).
- **Root cause #3**: icon installed at `hicolor/0x0/`, an invalid path.
- **Fix**: PKGBUILD `package()` runs a permission scrub
  (`find -type d -exec chmod 755 {} +` etc.), `chmod 4755 chrome-sandbox`,
  and copies the icon into every standard hicolor size. All three are
  baked into the current PKGBUILD; do not remove them.

### 9.6. AUR push: "maximum blob size (488.28KiB) exceeded"

- **Symptom**: AUR rejects the push with that error.
- **Root cause**: build artifacts (`src/squashfs-root/`, `pkg/`,
  `*.pkg.tar.zst`, the AppImage) were committed.
- **Fix**: AUR repos hold ONLY source (PKGBUILD, .SRCINFO, install
  scripts, patches). The AUR clone has a `.gitignore` that prevents
  `makepkg`'s output from being staged. If you ever delete the
  `.gitignore`, recreate it from `packaging/aur/hexshell-bin/.gitignore`.

### 9.7. Renderer hang on boot — `LINK: ESTABLISHING` stuck forever

- **Symptom**: app launches, titlebar paints, but `SHELL: detecting…`
  never resolves, no cursor, no clock ticking, prompt never appears.
- **Root cause #1** (0.1.1): Orbitron `@font-face` used
  `format("truetype-variations")`, a CSS Fonts Module Level 4 string
  some Chromium builds reject. `document.fonts.ready` then never
  resolves and `await` in `bootTerminal()` blocks forever.
- **Fix**: use plain `format("truetype")` for variable TTFs (axes still
  work). Rename file to drop `[wght]` brackets that some font loaders
  trip over. Wrap `document.fonts.ready` in a `Promise.race` with a
  500 ms timeout so a future broken `@font-face` can never hang us
  again.
- **Root cause #2** (0.1.2): a `let chimeFired = false; function
  playStartupChime() { ... chimeFired ... }` block was placed below
  the call site that invoked `playStartupChime()`. `let` bindings
  live in the temporal dead zone before their declaration line, so
  the very first call threw `ReferenceError`, killing the entire
  renderer IIFE silently.
- **Fix**: declare `let` bindings ABOVE consumers — function
  declarations hoist but `let`/`const` they read do not. Two-line
  reorder.

If you ever see `LINK: ESTABLISHING` stuck again, open DevTools first
thing — the first red Console error tells you the line that threw.
Don't try to debug from screenshots; the stack trace is the source of
truth.

---

## 10. Recipes

### 10.1. Hotfix release (no new features)

```bash
$EDITOR package.json                 # 0.1.1 -> 0.1.2
$EDITOR CHANGELOG.md                 # add 0.1.2 entry, sections: ### Fixed
$EDITOR packaging/aur/hexshell-bin/PKGBUILD   # pkgver=0.1.2, pkgrel=1

git add -A && git commit -m "Release 0.1.2: <fix summary>"
git push
git tag -a v0.1.2 -m "Release v0.1.2"
git push origin v0.1.2

# Wait for CI, then:
gh release edit v0.1.2 --draft=false

# AUR
bash -c "cd /tmp/hexshell-bin && git pull && \
  cp ~/Projects/Hexshell/packaging/aur/hexshell-bin/PKGBUILD . && \
  makepkg --printsrcinfo > .SRCINFO && \
  git add PKGBUILD .SRCINFO && \
  git commit -m 'hexshell-bin 0.1.2-1: bump to upstream v0.1.2' && \
  git push"
```

### 10.2. AUR-only fix (no upstream change)

When PKGBUILD itself needs a bug fix but the upstream tarball is fine:

```bash
$EDITOR packaging/aur/hexshell-bin/PKGBUILD          # bump pkgrel
git add packaging/aur/hexshell-bin/PKGBUILD
git commit -m "aur: hexshell-bin 0.1.1-2: <fix description>"
git push

# Sync to AUR
bash -c "cd /tmp/hexshell-bin && git pull && \
  cp ~/Projects/Hexshell/packaging/aur/hexshell-bin/PKGBUILD . && \
  makepkg --printsrcinfo > .SRCINFO && \
  git add PKGBUILD .SRCINFO && \
  git commit -m 'hexshell-bin 0.1.1-2: <fix description>' && \
  git push"
```

`pkgver` stays the same; only `pkgrel` increments.

### 10.3. Pin SHA256 instead of `SKIP`

For users who want stronger integrity than HTTPS provides:

```bash
# After release is published:
SHA=$(curl -sL "https://github.com/TSMaitryDotDev/hexshell/releases/download/v0.1.1/SHA256SUMS" \
      | awk '/x86_64\.AppImage/ {print $1}')
$EDITOR /tmp/hexshell-bin/PKGBUILD          # sha256sums=("${SHA}")
# Bump pkgrel, regenerate .SRCINFO, commit, push.
```

### 10.4. Force a workflow re-run (without re-tagging)

```bash
gh workflow run release.yml --ref main
gh run watch $(gh run list --limit 1 --json databaseId -q '.[0].databaseId') --exit-status
```

Useful if you tweaked `.github/workflows/release.yml` after a release.
The new run uses the **current** workflow file, but builds against the
ref you pass.

### 10.5. Roll back a botched release

```bash
# 1. Delete the GH release
gh release delete v0.1.1 --yes

# 2. Delete the tag (local + remote)
git tag -d v0.1.1
git push --delete origin v0.1.1

# 3. Roll back the PKGBUILD on AUR
bash -c "cd /tmp/hexshell-bin && git revert HEAD && git push"
```

Then re-cut the tag against a fixed commit. Don't try to "fix" a
released tag in place — users with their `~/.cache/yay/` already
extracted will be confused.

### 10.6. Local sanity test of the AUR package

Useful before pushing a PKGBUILD change:

```bash
cd /tmp/hexshell-bin
makepkg -f --noconfirm                                # build
sudo pacman -U hexshell-bin-*-x86_64.pkg.tar.zst      # install
hexshell                                              # smoke test
sudo pacman -Rns --noconfirm hexshell-bin             # uninstall
```

### 10.7. Refresh font / glyph / logo bundles

```bash
bun run fonts --force      # not implemented for fonts; delete files manually
bun run glyphs --force     # re-download glyphnames.json from upstream
bun run logos --force      # re-bundle Simple Icons
```

These run automatically on `bun install`, so most of the time you don't
need to touch them.

### 10.8. Smoke-test an AUR release before users hit it

After CI publishes a draft and BEFORE you push the AUR PKGBUILD bump,
verify the actual download path one more time:

```bash
# 1. Publish the GitHub draft so URLs become anonymous-readable.
gh release edit v0.1.3 --draft=false

# 2. Build the AUR package against the live release URL.
bash -c "cd /tmp/hexshell-bin && cp ~/Projects/Hexshell/packaging/aur/hexshell-bin/PKGBUILD . && \
  makepkg --printsrcinfo > .SRCINFO && \
  rm -f *.pkg.tar.zst && makepkg -f --noconfirm"

# 3. Install + launch.
sudo pacman -U /tmp/hexshell-bin/hexshell-bin-*-x86_64.pkg.tar.zst
hexshell &
sleep 4
pgrep -a hexshell             # confirm process alive
sudo pacman -Rns --noconfirm hexshell-bin

# 4. Only now push to AUR.
bash -c "cd /tmp/hexshell-bin && git add PKGBUILD .SRCINFO && \
  git commit -m 'hexshell-bin <ver>-1: bump' && git push"
```

This catches: 404 on AppImage URL, broken PKGBUILD package() steps,
runtime crashes that don't show in `bun run start`, missing setuid on
chrome-sandbox, icon directory typos. All of those have happened to us
in the 0.1.x cycle.

### 10.9. Update the README preview screenshot

After a UI change that's worth showing off:

```bash
# 1. Take the screenshot at 1920x1080 (matches images/preview.png aspect).
#    KDE: spectacle --rectangle, drag the Hexshell window region.
#    Save as PNG, drop it at images/preview.png (overwrite).
# 2. Commit just that file.
git add images/preview.png
git commit -m "docs: refresh README preview"
git push
```

Don't link external image hosts — the README's <img src="./images/...">
relative path means GitHub serves it from the same domain (no third-
party trackers, works in offline mirrors).

---

If something on this page is wrong or out of date, fix the page and the
underlying script in the same commit. Tribal knowledge is how releases
get scary.
