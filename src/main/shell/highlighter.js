'use strict';

/**
 * Live syntax highlighting for the input buffer.
 *
 * Output is a colored copy of the buffer using ANSI SGR sequences. We rely
 * on tokenize() being lossless: every character of the input is in exactly
 * one token, so we can walk tokens in order and emit the colored slice for
 * each. The cursor position math stays in editor.js and is computed against
 * the *uncolored* buffer; ANSI is purely visual.
 *
 * Coloring rules (pragmatic, not POSIX-perfect):
 *   - Operators            -> magenta
 *   - Variables            -> cyan
 *   - Single/double strings-> yellow
 *   - Comments             -> dim
 *   - Errors (unterminated)-> red, underlined
 *   - First word of a stmt -> green if it resolves to a known command,
 *                             red if it does not. "Resolution" means:
 *                                builtin || alias || $PATH lookup
 *   - Other words          -> default fg
 *
 * Command resolution is async on-disk in spirit, but we cache PATH listings
 * inside the completer so it's effectively O(1) here.
 */

const path = require('path');
const { T, tokenize } = require('./parser');
const { ANSI } = require('./env');

class Highlighter {
  /**
   * @param {import('./env').Env} env
   * @param {import('./completer').Completer} completer  // for cmd existence
   * @param {import('./builtins').Builtins} builtins
   */
  constructor(env, completer, builtins) {
    this._env = env;
    this._completer = completer;
    this._builtins = builtins;
  }

  /**
   * @param {string} buffer  current input buffer
   * @returns {string} colored buffer (visual only; same printable width)
   */
  render(buffer) {
    if (!buffer) return '';
    const toks = tokenize(buffer);
    let out = '';
    let atStmtStart = true; // first non-ws token is the command
    let inPipelineHead = true;

    for (const tk of toks) {
      const slice = buffer.slice(tk.start, tk.end);

      if (tk.type === T.WS) {
        out += slice;
        continue;
      }
      if (tk.type === T.COMMENT) {
        out += ANSI.dim + slice + ANSI.reset;
        continue;
      }
      if (tk.type === T.ERROR) {
        out += '\x1b[4;38;5;203m' + slice + ANSI.reset;
        continue;
      }
      if (tk.type === T.OP) {
        out += ANSI.magenta + slice + ANSI.reset;
        // After ;, &&, ||, |, the next word is a new command head.
        if (tk.value === ';' || tk.value === '&&' || tk.value === '||' || tk.value === '|') {
          atStmtStart = true;
          inPipelineHead = true;
        }
        continue;
      }
      if (tk.type === T.VAR) {
        out += ANSI.cyan + slice + ANSI.reset;
        atStmtStart = false;
        continue;
      }
      if (tk.type === T.SQ_STRING || tk.type === T.DQ_STRING) {
        out += ANSI.yellow + slice + ANSI.reset;
        atStmtStart = false;
        inPipelineHead = false;
        continue;
      }
      if (tk.type === T.WORD) {
        if (atStmtStart && inPipelineHead) {
          const known = this._isKnownCommand(tk.value);
          out += (known ? ANSI.green : ANSI.red) + slice + ANSI.reset;
          atStmtStart = false;
          inPipelineHead = false;
        } else {
          // Args: light up flags slightly so options stand out.
          if (slice.startsWith('-')) out += ANSI.dim + slice + ANSI.reset;
          else                       out += slice;
        }
        continue;
      }

      out += slice;
    }

    return out;
  }

  _isKnownCommand(name) {
    if (!name) return false;
    if (this._builtins.has(name)) return true;
    if (this._env.aliases[name]) return true;
    if (name.includes('/')) {
      // Treat as path; existence check is too IO-heavy on every keystroke,
      // so we simply trust the user. The executor will report not-found.
      return true;
    }
    return this._completer.commandExists(name);
  }
}

module.exports = { Highlighter };
