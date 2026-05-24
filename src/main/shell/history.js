'use strict';

/**
 * Persistent command history.
 *
 * Stored as one entry per line at:
 *   $XDG_DATA_HOME/hexshell/history    (default: ~/.local/share/hexshell/history)
 *
 * Why this design:
 *   - Cheap. Append on accept, no fsync needed; we don't lose much if we
 *     crash mid-keystroke.
 *   - Fast. Loaded into memory once at startup; navigation is array index.
 *   - Deduplicated. Consecutive duplicates collapse, like zsh.
 *   - Bounded. We trim to MAX entries on save to keep the file small.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX = 5000;

function dataDir() {
  const xdg = process.env.XDG_DATA_HOME;
  return xdg && xdg.length
    ? path.join(xdg, 'hexshell')
    : path.join(os.homedir(), '.local', 'share', 'hexshell');
}

class History {
  constructor() {
    this.file = path.join(dataDir(), 'history');
    /** @type {string[]} */
    this.items = [];
    this.cursor = -1;          // -1 means "not currently navigating"
    this.draft = '';           // line the user was typing before pressing Up
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.items = raw.split('\n').filter(Boolean);
    } catch (_) {
      this.items = [];
    }
  }

  /**
   * Append a new entry. Skips empty lines and consecutive duplicates.
   * Persists synchronously; on Linux this is a single small write that
   * costs ~0.1ms and avoids losing entries on crash.
   */
  add(line) {
    const v = String(line || '').trim();
    if (!v) return;
    if (this.items.length && this.items[this.items.length - 1] === v) {
      this.cursor = -1;
      return;
    }
    this.items.push(v);
    if (this.items.length > MAX) this.items = this.items.slice(-MAX);
    this.cursor = -1;
    this._persist();
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, this.items.join('\n') + '\n', 'utf8');
    } catch (err) {
      // Don't crash the shell over history I/O errors. Just complain.
      if (process.env.HEXSHELL_DEBUG) console.warn('[history]', err.message);
    }
  }

  // -------------------------------------------------------------------------
  // Navigation. We expose tiny "give me the line at offset N from end" APIs
  // and let the editor stash the user's draft before navigation.
  // -------------------------------------------------------------------------

  beginNavigation(currentDraft) {
    if (this.cursor === -1) this.draft = currentDraft || '';
  }

  endNavigation() {
    this.cursor = -1;
    this.draft = '';
  }

  /** Returns the previous entry or undefined if at top. */
  prev(currentDraft) {
    this.beginNavigation(currentDraft);
    if (!this.items.length) return undefined;
    if (this.cursor === -1) this.cursor = this.items.length - 1;
    else if (this.cursor > 0) this.cursor--;
    return this.items[this.cursor];
  }

  /** Returns the next entry or the saved draft if we walk off the end. */
  next() {
    if (this.cursor === -1) return undefined;
    if (this.cursor < this.items.length - 1) {
      this.cursor++;
      return this.items[this.cursor];
    }
    // Walked past the newest entry: restore the draft.
    const saved = this.draft;
    this.endNavigation();
    return saved;
  }

  /** Used by autosuggestions: most recent entry that starts with `prefix`. */
  suggest(prefix) {
    if (!prefix) return undefined;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].startsWith(prefix) && this.items[i] !== prefix) {
        return this.items[i];
      }
    }
    return undefined;
  }
}

module.exports = { History };
