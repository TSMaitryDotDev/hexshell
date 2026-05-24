'use strict';

/**
 * Tab completion + command-existence cache used by the highlighter.
 *
 * Two responsibilities:
 *
 *   1. Fast "does <name> exist on $PATH?" check. We list every $PATH dir
 *      once, cache the results, refresh in the background every 10s. The
 *      highlighter calls this on EVERY keystroke, so it must be a Set
 *      lookup, never a fs.stat round trip.
 *
 *   2. Tab completion.
 *      - If the user is on the FIRST word of a pipeline: complete from
 *        commands (PATH + builtins + aliases).
 *      - Otherwise: complete from filesystem paths relative to env.cwd,
 *        honoring ~ and absolute paths.
 *
 * Returned shape:
 *   {
 *     prefix:       string   - the token we tried to complete
 *     candidates:   string[] - matches (sorted, deduped)
 *     replaceFrom:  number   - byte offset in the buffer where completion replaces from
 *     trailing:     string   - either '' or '/' (for directory completion) or ' '
 *   }
 */

const fs = require('fs');
const path = require('path');
const { tokenize, T } = require('./parser');

const REFRESH_MS = 10_000;

class Completer {
  /**
   * @param {import('./env').Env} env
   * @param {import('./builtins').Builtins} builtins
   */
  constructor(env, builtins) {
    this._env = env;
    this._builtins = builtins;
    /** @type {Set<string>} */
    this._commands = new Set();
    this._lastBuilt = 0;
    this._building = false;
    this._rebuild(); // synchronous on first use; cheap on Linux
  }

  // -------------------------------------------------------------------------
  // PATH cache
  // -------------------------------------------------------------------------

  _rebuild() {
    if (this._building) return;
    this._building = true;
    try {
      const set = new Set();
      const PATH = (this._env.env.PATH || '').split(':').filter(Boolean);
      for (const dir of PATH) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch (_) { continue; }
        for (const e of entries) {
          // Add files (including symlinks, since most binaries are symlinked).
          if (e.isFile() || e.isSymbolicLink()) set.add(e.name);
        }
      }
      // Builtins always count as commands.
      for (const name of this._builtins.names()) set.add(name);
      // Aliases too.
      for (const name of Object.keys(this._env.aliases)) set.add(name);
      this._commands = set;
      this._lastBuilt = Date.now();
    } finally {
      this._building = false;
    }
  }

  _maybeRefresh() {
    if (Date.now() - this._lastBuilt > REFRESH_MS) this._rebuild();
  }

  /** Hot path: called by the highlighter on every keystroke. */
  commandExists(name) {
    this._maybeRefresh();
    return this._commands.has(name);
  }

  // -------------------------------------------------------------------------
  // Completion entry point
  // -------------------------------------------------------------------------

  /**
   * @param {string} buffer
   * @param {number} cursor   index in buffer (0..buffer.length)
   */
  complete(buffer, cursor) {
    const before = buffer.slice(0, cursor);
    const ctx = this._currentToken(buffer, cursor);

    const isFirstWord = this._isFirstWord(before, ctx.start);
    if (isFirstWord && !ctx.prefix.includes('/') && !ctx.prefix.startsWith('~')) {
      return this._completeCommand(ctx);
    }
    return this._completePath(ctx);
  }

  /** Compute the token under the cursor (or an empty token at the cursor). */
  _currentToken(buffer, cursor) {
    const toks = tokenize(buffer);
    for (const tk of toks) {
      if (tk.type === T.WS) continue;
      if (tk.start <= cursor && cursor <= tk.end) {
        return {
          prefix: buffer.slice(tk.start, cursor),
          start:  tk.start,
          end:    tk.end,
          full:   buffer.slice(tk.start, tk.end)
        };
      }
    }
    // Cursor is in whitespace: empty token at the cursor.
    return { prefix: '', start: cursor, end: cursor, full: '' };
  }

  /** Is the token at `tokenStart` the first non-op token of its statement? */
  _isFirstWord(beforeText, tokenStart) {
    // Walk back from tokenStart over whitespace, then check whether what's
    // immediately before is the start of buffer or a chain operator.
    const upto = beforeText.slice(0, tokenStart);
    const trimmed = upto.replace(/\s+$/, '');
    if (trimmed.length === 0) return true;
    return /(^|[^&|;])(\||;|&&|\|\|)$/.test(trimmed) || /(^|\s)(;|&&|\|\||\|)$/.test(trimmed);
  }

  // -------------------------------------------------------------------------
  // Command completion
  // -------------------------------------------------------------------------

  _completeCommand(ctx) {
    this._maybeRefresh();
    const matches = [];
    for (const name of this._commands) {
      if (name.startsWith(ctx.prefix)) matches.push(name);
    }
    matches.sort();
    return {
      prefix: ctx.prefix,
      candidates: matches,
      replaceFrom: ctx.start,
      trailing: ' '
    };
  }

  // -------------------------------------------------------------------------
  // Path completion
  // -------------------------------------------------------------------------

  _completePath(ctx) {
    let prefix = ctx.prefix;
    let basedir;
    let basename;
    let displayDir; // what we keep at the start of every replacement string

    if (prefix.startsWith('~')) {
      const home = this._env.env.HOME || require('os').homedir();
      const rest = prefix.slice(1);
      const expanded = path.join(home, rest);
      basedir = rest.endsWith('/') ? expanded : path.dirname(expanded);
      basename = rest.endsWith('/') ? '' : path.basename(expanded);
      const tildePart = '~' + (rest.includes('/') ? rest.slice(0, rest.lastIndexOf('/') + 1) : '');
      displayDir = tildePart;
    } else if (prefix.startsWith('/')) {
      basedir = prefix.endsWith('/') ? prefix : path.dirname(prefix);
      basename = prefix.endsWith('/') ? '' : path.basename(prefix);
      displayDir = prefix.endsWith('/') ? prefix : prefix.slice(0, prefix.lastIndexOf('/') + 1);
    } else {
      const abs = path.resolve(this._env.cwd, prefix || '.');
      basedir = (prefix === '' || prefix.endsWith('/')) ? abs : path.dirname(abs);
      basename = (prefix === '' || prefix.endsWith('/')) ? '' : path.basename(abs);
      displayDir = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/') + 1) : '';
    }

    let entries;
    try { entries = fs.readdirSync(basedir, { withFileTypes: true }); }
    catch (_) { entries = []; }

    const showHidden = basename.startsWith('.');
    const matches = [];
    for (const e of entries) {
      if (!showHidden && e.name.startsWith('.')) continue;
      if (!e.name.startsWith(basename)) continue;
      const isDir = e.isDirectory() ||
        (e.isSymbolicLink() && this._isDir(path.join(basedir, e.name)));
      matches.push({ name: e.name, isDir });
    }
    matches.sort((a, b) => a.name.localeCompare(b.name));

    const candidates = matches.map((m) => displayDir + m.name + (m.isDir ? '/' : ''));
    // If the only candidate is a directory, the editor will append nothing
    // extra (we already added '/'); otherwise it appends a space.
    const trailing = (matches.length === 1 && matches[0].isDir) ? '' : ' ';
    return {
      prefix,
      candidates,
      replaceFrom: ctx.start,
      trailing
    };
  }

  _isDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
  }
}

module.exports = { Completer };
