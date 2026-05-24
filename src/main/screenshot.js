'use strict';

/**
 * System screenshot launcher.
 *
 * Hexshell does NOT capture pixels itself. We invoke the user's preferred
 * screenshot tool so the result lives in their own screenshot library
 * (Pictures/Screenshots/, Spectacle's queue, Flameshot's clipboard, etc.).
 *
 * Detection order (best -> fallback):
 *
 *   flameshot              fast, modern, region-or-fullscreen GUI, X11+Wayland
 *   grim + slurp           native Wayland (sway, Hyprland)
 *   gnome-screenshot       Mutter Wayland and X11 GNOME
 *   spectacle              KDE Plasma (Wayland and X11)
 *   xfce4-screenshooter    XFCE
 *   maim                   X11, scriptable
 *   scrot                  X11, classic fallback
 *
 * The tools are launched detached. We do NOT wait for them — the user
 * might decide to draw a region for a minute, and we don't want their
 * shell to freeze waiting for the file to appear.
 */

const { spawn } = require('child_process');
const { accessSync, constants, mkdirSync } = require('fs');
const path = require('path');
const os = require('os');

/**
 * Describe how to invoke a tool. `argsFor(file)` returns the argv tail.
 * Some tools save automatically (flameshot --gui), others want an output
 * file path (grim, maim, scrot). We branch in `args` accordingly.
 */
const TOOLS = [
  {
    name: 'flameshot',
    bin:  'flameshot',
    // `flameshot gui` opens the region-select UI and saves to the user's
    // configured directory + clipboard. No output path argument needed.
    args: () => ['gui'],
    needsFile: false
  },
  {
    name: 'grim+slurp',
    // grim is the binary. We need slurp present to do region selection;
    // if slurp is missing we fall back to a full-screen grim shot.
    bin:  'grim',
    args: (file) => {
      const haveSlurp = which('slurp');
      // grim writes the file synchronously, so we DO need a path here.
      // Use a here-doc style: spawn `sh -c 'grim ...'` so we can pipe
      // slurp into grim cleanly.
      if (haveSlurp) {
        return ['-c', `grim -g "$(slurp)" ${shellQuote(file)}`];
      }
      return ['-c', `grim ${shellQuote(file)}`];
    },
    spawnBinOverride: '/bin/sh',
    needsFile: true
  },
  {
    name: 'gnome-screenshot',
    bin:  'gnome-screenshot',
    // `-i` opens the interactive UI. Modern GNOME screenshots auto-save
    // to ~/Pictures/Screenshots without us specifying a path.
    args: () => ['-i'],
    needsFile: false
  },
  {
    name: 'spectacle',
    bin:  'spectacle',
    // `-r` for region, `-i` to open KDE's GUI; without -i it captures
    // immediately and saves. We pick `-i` so the user gets a chance to
    // edit/annotate before saving.
    args: () => ['-i'],
    needsFile: false
  },
  {
    name: 'xfce4-screenshooter',
    bin:  'xfce4-screenshooter',
    args: () => [],
    needsFile: false
  },
  {
    name: 'maim',
    bin:  'maim',
    // -s = select region. Saves to file path we provide.
    args: (file) => ['-s', file],
    needsFile: true
  },
  {
    name: 'scrot',
    bin:  'scrot',
    // -s = select. Output path required.
    args: (file) => ['-s', file],
    needsFile: true
  }
];

function which(bin) {
  if (!bin) return null;
  if (bin.includes('/')) {
    try { accessSync(bin, constants.X_OK); return bin; } catch (_) { return null; }
  }
  const PATH = (process.env.PATH || '').split(':').filter(Boolean);
  for (const dir of PATH) {
    const full = path.join(dir, bin);
    try { accessSync(full, constants.X_OK); return full; } catch (_) {}
  }
  return null;
}

function shellQuote(s) {
  if (s === '') return "''";
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/**
 * Pick the screenshot directory and an unused filename in it.
 *   $XDG_PICTURES_DIR/Screenshots if set, else ~/Pictures/Screenshots,
 *   else $HOME, else /tmp.
 *
 * We respect the user's `xdg-user-dirs` preference when possible by
 * reading $XDG_PICTURES_DIR. We don't shell out to `xdg-user-dir` to
 * avoid the extra dependency.
 */
function pickFilename() {
  const home = os.homedir() || '/tmp';
  let dir;
  if (process.env.XDG_PICTURES_DIR && process.env.XDG_PICTURES_DIR.length) {
    dir = path.join(process.env.XDG_PICTURES_DIR, 'Screenshots');
  } else {
    dir = path.join(home, 'Pictures', 'Screenshots');
  }
  try { mkdirSync(dir, { recursive: true }); }
  catch (_) { dir = home; }

  const stamp = new Date().toISOString()
    .replace(/[T:]/g, '-')
    .replace(/\..+$/, '');
  return path.join(dir, `Hexshell-${stamp}.png`);
}

/**
 * Detect and run the first available screenshot tool.
 *
 * @returns {{ok:boolean, tool?:string, file?:string, error?:string}}
 */
function takeScreenshot() {
  for (const tool of TOOLS) {
    if (!which(tool.bin)) continue;
    try {
      const file = tool.needsFile ? pickFilename() : null;
      const args = tool.args(file);
      const cmd  = tool.spawnBinOverride || tool.bin;

      const child = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        env: process.env
      });
      // Detach: don't keep a handle that would prevent the child from
      // outliving Hexshell. .unref() also lets Hexshell exit cleanly even
      // if the screenshot tool is still showing its UI.
      child.unref();

      return { ok: true, tool: tool.name, file: file || undefined };
    } catch (err) {
      // Try the next tool; this one failed to spawn for some reason.
      if (process.env.HEXSHELL_DEBUG) {
        console.warn(`[screenshot] ${tool.name} failed:`, err.message);
      }
    }
  }
  return {
    ok: false,
    error:
      'No screenshot tool found. Install one of: flameshot, grim+slurp, ' +
      'spectacle, gnome-screenshot, xfce4-screenshooter, maim, scrot.'
  };
}

module.exports = { takeScreenshot };
