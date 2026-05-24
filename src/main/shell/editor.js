'use strict';

/**
 * Line editor.
 *
 * Receives raw keystroke chunks from xterm and turns them into edits on a
 * single-line buffer. Renders the prompt + colored buffer + autosuggestion
 * to the renderer with the smallest ANSI sequence we can get away with.
 *
 * Key design choices:
 *   - Single-line input. Multi-line is rare in interactive shells; if a
 *     command is too long, the user types ` \` to continue, which we treat
 *     as a continuation (handled by HexShell, not here). This keeps the
 *     redraw math trivial: we always know the cursor is on the prompt row.
 *   - We always redraw the entire line on edit. With colored highlighting
 *     and autosuggestions the cost of computing a diff exceeds the cost of
 *     reprinting <300 bytes; xterm.js handles that easily.
 *   - The prompt is treated as opaque: we measure its visible width once
 *     when rendering, so cursor positioning is independent of prompt color
 *     codes.
 *
 * Public API:
 *   editor.feed(data)           // from renderer keystrokes
 *   editor.refresh()            // redraw current line (after async events)
 *   editor.events: 'submit', 'cancel', 'eof', 'clear'
 */

const { EventEmitter } = require('events');
const { ANSI } = require('./env');

// Visible-width helpers. We don't ship a full grapheme/wcwidth lib; for the
// small set of characters that appear in prompts and typical input this is
// enough. ASCII == 1 column. Combining marks == 0. Otherwise default to 1.
function visibleWidth(str) {
  // Strip CSI / OSC sequences first.
  const stripped = str.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
                      .replace(/\x1b\][^\x07]*\x07/g, '');
  let w = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0);
    if (code === 0x0a || code === 0x0d) continue;
    // Combining marks (U+0300..U+036F) are zero-width.
    if (code >= 0x0300 && code <= 0x036F) continue;
    w++;
  }
  return w;
}

class LineEditor extends EventEmitter {
  /**
   * @param {object} deps
   * @param {(s:string)=>void} deps.emit          send to renderer
   * @param {()=>{cols:number,rows:number}} deps.getSize
   * @param {import('./env').Env} deps.env
   * @param {import('./highlighter').Highlighter} deps.highlighter
   * @param {import('./completer').Completer} deps.completer
   * @param {import('./history').History} deps.history
   */
  constructor(deps) {
    super();
    this._emit = deps.emit;
    this._getSize = deps.getSize;
    this._env = deps.env;
    this._hi = deps.highlighter;
    this._comp = deps.completer;
    this._hist = deps.history;

    this.buffer = '';
    this.cursor = 0;            // index into buffer
    this._yank = '';            // last killed text
    this._suggestion = '';      // current autosuggestion (the FULL line)
    this._lastDrawnRows = 1;    // how many terminal rows the prompt+buffer occupied
    this._promptVisibleCols = 0; // width of the LAST prompt line
    this._enabled = false;
  }

  // -------------------------------------------------------------------------
  // External lifecycle
  // -------------------------------------------------------------------------

  /** Begin reading a new line. Prints the prompt. */
  begin() {
    this.buffer = '';
    this.cursor = 0;
    this._suggestion = '';
    this._enabled = true;
    this._hist.endNavigation();
    this._renderPromptAndLine(/*freshLine*/ true);
  }

  /**
   * Replace the buffer in place (used by history navigation). Keeps the
   * editor enabled and redraws.
   */
  replaceBuffer(s) {
    this.buffer = s;
    this.cursor = s.length;
    this._refreshSuggestion();
    this._redraw();
  }

  /** Force a redraw (e.g. after a resize). */
  refresh() {
    if (this._enabled) this._redraw();
  }

  /** Stop accepting input but leave whatever's drawn. */
  pause() { this._enabled = false; }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /**
   * Feed raw bytes from xterm. We parse them into editor actions.
   *
   * The parsing is intentionally minimal: we cover the keys that matter
   * for an interactive shell. Anything we don't recognize (and that's
   * printable) is inserted as text.
   */
  feed(data) {
    if (!this._enabled) return;
    let i = 0;
    while (i < data.length) {
      const c = data[i];

      // ESC sequences -----------------------------------------------------
      if (c === '\x1b') {
        // Look ahead for CSI (ESC [) and SS3 (ESC O).
        if (data[i + 1] === '[' || data[i + 1] === 'O') {
          const m = data.slice(i).match(/^\x1b[\[O][0-9;]*[A-Za-z~]/);
          if (m) {
            this._onCsi(m[0]);
            i += m[0].length;
            continue;
          }
        }
        // Bare ESC (e.g. Alt + key)
        const next = data[i + 1];
        if (next === 'b') { this._wordLeft();  i += 2; continue; }
        if (next === 'f') { this._wordRight(); i += 2; continue; }
        if (next === '\x7f' || next === 'h') { this._killWordLeft(); i += 2; continue; }
        // Unknown ESC sequence; swallow.
        i += 1;
        continue;
      }

      // Control characters ------------------------------------------------
      if (c === '\r' || c === '\n')          { this._submit(); i++; continue; }
      if (c === '\x7f' || c === '\b')        { this._backspace(); i++; continue; }
      if (c === '\t')                        { this._tab(); i++; continue; }
      if (c === '\x03')                      { this._cancel(); i++; continue; }   // Ctrl+C
      if (c === '\x04')                      { this._eof();    i++; continue; }   // Ctrl+D
      if (c === '\x0c')                      { this._clear();  i++; continue; }   // Ctrl+L
      if (c === '\x01')                      { this._home();   i++; continue; }   // Ctrl+A
      if (c === '\x05')                      { this._end();    i++; continue; }   // Ctrl+E
      if (c === '\x02')                      { this._left();   i++; continue; }   // Ctrl+B
      if (c === '\x06')                      { this._right();  i++; continue; }   // Ctrl+F
      if (c === '\x10')                      { this._historyPrev(); i++; continue; } // Ctrl+P
      if (c === '\x0e')                      { this._historyNext(); i++; continue; } // Ctrl+N
      if (c === '\x15')                      { this._killToHome(); i++; continue; } // Ctrl+U
      if (c === '\x0b')                      { this._killToEnd();  i++; continue; } // Ctrl+K
      if (c === '\x17')                      { this._killWordLeft(); i++; continue; } // Ctrl+W
      if (c === '\x19')                      { this._yankInsert();   i++; continue; } // Ctrl+Y

      // Bracketed paste markers — strip them; insert paste body literally.
      if (data.startsWith('\x1b[200~', i)) { i += 6; continue; }
      if (data.startsWith('\x1b[201~', i)) { i += 6; continue; }

      // Printable. We accept any non-control byte.
      if (c >= ' ') {
        // Coalesce a run of printable chars into a single insert for speed.
        let j = i;
        while (j < data.length && data[j] >= ' ' && data[j] !== '\x7f') j++;
        this._insert(data.slice(i, j));
        i = j;
        continue;
      }
      i++;
    }
  }

  // -------------------------------------------------------------------------
  // CSI handling
  // -------------------------------------------------------------------------

  _onCsi(seq) {
    // Common arrows + home/end.
    switch (seq) {
      case '\x1b[A': case '\x1bOA': return this._historyPrev();
      case '\x1b[B': case '\x1bOB': return this._historyNext();
      case '\x1b[C': case '\x1bOC': return this._rightOrAccept();
      case '\x1b[D': case '\x1bOD': return this._left();
      case '\x1b[H': case '\x1bOH': case '\x1b[1~': case '\x1b[7~': return this._home();
      case '\x1b[F': case '\x1bOF': case '\x1b[4~': case '\x1b[8~': return this._endOrAccept();
      case '\x1b[3~': return this._delete();
      case '\x1b[1;5C': return this._wordRight();
      case '\x1b[1;5D': return this._wordLeft();
    }
    // Unknown: ignore.
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  _insert(s) {
    this.buffer = this.buffer.slice(0, this.cursor) + s + this.buffer.slice(this.cursor);
    this.cursor += s.length;
    this._refreshSuggestion();
    this._redraw();
  }

  _backspace() {
    if (this.cursor === 0) return;
    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
    this.cursor--;
    this._refreshSuggestion();
    this._redraw();
  }

  _delete() {
    if (this.cursor === this.buffer.length) return;
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
    this._refreshSuggestion();
    this._redraw();
  }

  _left()  { if (this.cursor > 0)             { this.cursor--; this._redraw(); } }
  _right() { if (this.cursor < this.buffer.length) { this.cursor++; this._redraw(); } }

  _rightOrAccept() {
    if (this.cursor < this.buffer.length) { this.cursor++; this._redraw(); return; }
    if (this._suggestion && this._suggestion.length > this.buffer.length) {
      this.buffer = this._suggestion;
      this.cursor = this.buffer.length;
      this._suggestion = '';
      this._redraw();
    }
  }

  _endOrAccept() {
    if (this._suggestion && this._suggestion.length > this.buffer.length) {
      this.buffer = this._suggestion;
      this.cursor = this.buffer.length;
      this._suggestion = '';
      this._redraw();
      return;
    }
    this._end();
  }

  _home() { this.cursor = 0; this._redraw(); }
  _end()  { this.cursor = this.buffer.length; this._redraw(); }

  _wordLeft() {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.buffer[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.buffer[i - 1])) i--;
    this.cursor = i;
    this._redraw();
  }

  _wordRight() {
    let i = this.cursor;
    const n = this.buffer.length;
    while (i < n && /\s/.test(this.buffer[i])) i++;
    while (i < n && !/\s/.test(this.buffer[i])) i++;
    this.cursor = i;
    this._redraw();
  }

  _killToHome() {
    if (this.cursor === 0) return;
    this._yank = this.buffer.slice(0, this.cursor);
    this.buffer = this.buffer.slice(this.cursor);
    this.cursor = 0;
    this._refreshSuggestion();
    this._redraw();
  }

  _killToEnd() {
    if (this.cursor === this.buffer.length) return;
    this._yank = this.buffer.slice(this.cursor);
    this.buffer = this.buffer.slice(0, this.cursor);
    this._refreshSuggestion();
    this._redraw();
  }

  _killWordLeft() {
    if (this.cursor === 0) return;
    const orig = this.cursor;
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.buffer[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.buffer[i - 1])) i--;
    this._yank = this.buffer.slice(i, orig);
    this.buffer = this.buffer.slice(0, i) + this.buffer.slice(orig);
    this.cursor = i;
    this._refreshSuggestion();
    this._redraw();
  }

  _yankInsert() {
    if (!this._yank) return;
    this._insert(this._yank);
  }

  _historyPrev() {
    const v = this._hist.prev(this.buffer);
    if (v === undefined) return;
    this.buffer = v;
    this.cursor = v.length;
    this._suggestion = '';
    this._redraw();
  }

  _historyNext() {
    const v = this._hist.next();
    if (v === undefined) return;
    this.buffer = v;
    this.cursor = v.length;
    this._suggestion = '';
    this._redraw();
  }

  _tab() {
    const result = this._comp.complete(this.buffer, this.cursor);
    if (!result.candidates.length) return;
    if (result.candidates.length === 1) {
      const replacement = result.candidates[0] + result.trailing;
      const before = this.buffer.slice(0, result.replaceFrom);
      const after  = this.buffer.slice(this.cursor);
      this.buffer = before + replacement + after;
      this.cursor = before.length + replacement.length;
      this._refreshSuggestion();
      this._redraw();
      return;
    }
    // Multiple matches: replace prefix with their longest common prefix and,
    // if that didn't change anything, list them.
    const lcp = longestCommonPrefix(result.candidates);
    if (lcp.length > result.prefix.length) {
      const before = this.buffer.slice(0, result.replaceFrom);
      const after  = this.buffer.slice(this.cursor);
      this.buffer = before + lcp + after;
      this.cursor = before.length + lcp.length;
      this._refreshSuggestion();
      this._redraw();
      return;
    }
    this._listCandidates(result.candidates);
  }

  _listCandidates(candidates) {
    // Print on a fresh line, then redraw the prompt+buffer.
    this._eraseFromPromptDown();
    this._emit('\r\n');
    const cols = Math.max(20, this._getSize().cols || 80);
    // Each candidate becomes "<icon> <name>"; the icon is one cell + space.
    // We compute column width on the displayed string, not the raw one, so
    // the grid stays aligned even with NF glyphs.
    const I = require('./icons');
    const display = candidates.map((c) => {
      const isDir = c.endsWith('/');
      const name = isDir ? c.slice(0, -1) : c;
      const icon = I.iconForCached(name, { dir: isDir });
      // 2 visible cells (glyph + space) + name length + optional trailing /
      return { text: `${icon.glyph} ${c}`, len: 2 + c.length };
    });
    const colW = Math.max(...display.map((d) => d.len)) + 2;
    const perRow = Math.max(1, Math.floor(cols / colW));
    for (let i = 0; i < display.length; i++) {
      const pad = ' '.repeat(Math.max(0, colW - display[i].len));
      this._emit(ANSI.fg + display[i].text + ANSI.reset + pad);
      if ((i + 1) % perRow === 0) this._emit('\r\n');
    }
    if (display.length % perRow !== 0) this._emit('\r\n');
    this._renderPromptAndLine(/*freshLine*/ true);
  }

  _submit() {
    this._eraseFromPromptDown();
    this._renderLine(/*final*/ true);
    this._emit('\r\n');
    this._enabled = false;
    const line = this.buffer;
    this.buffer = '';
    this.cursor = 0;
    this._suggestion = '';
    this.emit('submit', line);
  }

  _cancel() {
    this._eraseFromPromptDown();
    this._renderLine(/*final*/ true);
    this._emit(`${ANSI.dim} ^C${ANSI.reset}\r\n`);
    this.buffer = '';
    this.cursor = 0;
    this._suggestion = '';
    this._enabled = false;
    this.emit('cancel');
  }

  _eof() {
    if (this.buffer.length > 0) return; // bash: Ctrl+D mid-line is no-op
    this._emit('\r\n');
    this._enabled = false;
    this.emit('eof');
  }

  _clear() {
    // Clear screen, redraw prompt at top.
    this._emit('\x1b[2J\x1b[H');
    this._renderPromptAndLine(/*freshLine*/ true);
  }

  // -------------------------------------------------------------------------
  // Autosuggestion
  // -------------------------------------------------------------------------

  _refreshSuggestion() {
    const s = this._hist.suggest(this.buffer);
    this._suggestion = (s && this.buffer.length > 0) ? s : '';
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * Render prompt followed by the current line. If freshLine is true we
   * assume we're starting at column 0 and don't try to erase anything.
   */
  _renderPromptAndLine(freshLine) {
    if (!freshLine) this._eraseFromPromptDown();
    const prompt = this._env.renderPrompt();
    this._emit(prompt);
    // Measure the visible width of the LAST line of the prompt for cursor math.
    const lastNewline = prompt.lastIndexOf('\n');
    const lastPromptLine = lastNewline >= 0 ? prompt.slice(lastNewline + 1) : prompt;
    this._promptVisibleCols = visibleWidth(lastPromptLine);
    this._renderLine(false);
  }

  /**
   * Re-render just the input line in place. Steps:
   *   1. CR to go to the start of the prompt row.
   *   2. Cursor right past the prompt.
   *   3. Erase to end of screen (covers wrap and old listings).
   *   4. Print the colored buffer + dim suggestion suffix.
   *   5. Move the cursor to the logical position.
   *
   * `final` skips the autosuggestion (used right before submit).
   */
  _renderLine(final) {
    this._emit('\r');
    if (this._promptVisibleCols > 0) {
      this._emit(`\x1b[${this._promptVisibleCols}C`);
    }
    this._emit('\x1b[J');

    const colored = this._hi.render(this.buffer);
    this._emit(colored);

    let suffix = '';
    if (!final && this._suggestion && this._suggestion.length > this.buffer.length) {
      suffix = this._suggestion.slice(this.buffer.length);
      this._emit(ANSI.gray + suffix + ANSI.reset);
    }

    // Move cursor back from end-of-(buffer+suffix) to logical cursor.
    const end = this.buffer.length + suffix.length;
    const back = end - this.cursor;
    if (back > 0) this._emit(`\x1b[${back}D`);
  }

  _redraw() {
    if (!this._enabled) return;
    this._renderLine(false);
  }

  /**
   * Erase any candidate listing or wrapped lines that may have appeared
   * below the prompt before redrawing. We are conservative: print CR, move
   * to column 0, and clear from cursor to end of screen.
   */
  _eraseFromPromptDown() {
    this._emit('\r\x1b[J');
  }
}

function longestCommonPrefix(arr) {
  if (!arr.length) return '';
  let prefix = arr[0];
  for (let i = 1; i < arr.length; i++) {
    while (!arr[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return '';
    }
  }
  return prefix;
}

module.exports = { LineEditor };
