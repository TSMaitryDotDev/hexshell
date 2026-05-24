'use strict';

/**
 * Tokenizer for hexsh.
 *
 * Goal: be useful enough to drive both syntax highlighting and execution
 * without becoming a full POSIX shell parser. We support:
 *
 *   - words separated by whitespace
 *   - single-quoted strings (no escapes inside, like bash)
 *   - double-quoted strings (allow \" \\ \$ escapes; preserve the rest)
 *   - $var and ${var} variable references
 *   - ~ and ~/ home expansion (recognized in word context only)
 *   - operators:  |  ;  &&  ||  >  >>  <  2>  &
 *   - comments starting with # at the beginning of a token
 *
 * Two entry points:
 *   tokenize(line)  -> Token[]      (used by highlighter + completer)
 *   parse(line)     -> Pipeline[]   (used by executor)
 *
 * The token stream is *lossless*: every character of the input belongs to
 * exactly one token (including whitespace as TOKEN_WS). That matters because
 * the highlighter rebuilds the colored buffer by walking tokens and slicing
 * the original string, so positions must line up perfectly.
 */

const T = Object.freeze({
  WS:        'ws',
  WORD:      'word',     // bare identifier / path / argument
  SQ_STRING: 'sq',       // single-quoted
  DQ_STRING: 'dq',       // double-quoted
  VAR:       'var',      // $foo / ${foo}
  OP:        'op',       // | ; && || > >> < 2> &
  COMMENT:   'comment',
  ERROR:     'error'     // unterminated quote etc. (keeps highlight alive)
});

const OPS = ['&&', '||', '>>', '2>', '|', ';', '>', '<', '&'];

function isWordChar(c) {
  // Anything that isn't whitespace, a quote, or a known operator char.
  if (c === undefined) return false;
  if (/\s/.test(c)) return false;
  if (c === '"' || c === "'" || c === '$') return false;
  if (c === '|' || c === ';' || c === '>' || c === '<' || c === '&') return false;
  if (c === '#') return false;
  return true;
}

function tokenize(input) {
  /** @type {{type:string,start:number,end:number,value:string}[]} */
  const out = [];
  const n = input.length;
  let i = 0;

  while (i < n) {
    const c = input[i];

    // Whitespace run.
    if (/\s/.test(c)) {
      const start = i;
      while (i < n && /\s/.test(input[i])) i++;
      out.push({ type: T.WS, start, end: i, value: input.slice(start, i) });
      continue;
    }

    // Comment to EOL.
    if (c === '#' && (out.length === 0 || out[out.length - 1].type === T.WS)) {
      const start = i;
      while (i < n && input[i] !== '\n') i++;
      out.push({ type: T.COMMENT, start, end: i, value: input.slice(start, i) });
      continue;
    }

    // Operators (longest match first).
    let opMatched = null;
    for (const op of OPS) {
      if (input.startsWith(op, i)) { opMatched = op; break; }
    }
    if (opMatched) {
      out.push({ type: T.OP, start: i, end: i + opMatched.length, value: opMatched });
      i += opMatched.length;
      continue;
    }

    // Single quote: literal until next single quote.
    if (c === "'") {
      const start = i;
      i++;
      while (i < n && input[i] !== "'") i++;
      const closed = i < n;
      if (closed) i++;
      out.push({
        type: closed ? T.SQ_STRING : T.ERROR,
        start, end: i,
        value: input.slice(start, i)
      });
      continue;
    }

    // Double quote: allow $var and basic escapes.
    if (c === '"') {
      const start = i;
      i++;
      while (i < n && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < n) i += 2;
        else i++;
      }
      const closed = i < n;
      if (closed) i++;
      out.push({
        type: closed ? T.DQ_STRING : T.ERROR,
        start, end: i,
        value: input.slice(start, i)
      });
      continue;
    }

    // Variable reference.
    if (c === '$') {
      const start = i;
      i++;
      if (input[i] === '{') {
        i++;
        while (i < n && input[i] !== '}') i++;
        if (i < n) i++; // consume }
      } else {
        while (i < n && /[A-Za-z0-9_]/.test(input[i])) i++;
      }
      out.push({ type: T.VAR, start, end: i, value: input.slice(start, i) });
      continue;
    }

    // Bare word (covers paths, options like --foo, numbers, ~ etc.).
    const start = i;
    while (i < n && isWordChar(input[i])) i++;
    if (i === start) {
      // Defensive: unrecognized char becomes error so the highlighter sees it.
      i++;
      out.push({ type: T.ERROR, start, end: i, value: input.slice(start, i) });
    } else {
      out.push({ type: T.WORD, start, end: i, value: input.slice(start, i) });
    }
  }

  return out;
}

/**
 * Parse a tokenized line into a list of pipelines separated by ; or &&/||.
 *
 * The structure we emit is small on purpose; the executor we ship runs each
 * command sequentially and treats `|` as a real pipeline (handled inside
 * executor.js by chaining child_process). For scripts we don't aim to be a
 * full bash; users who need that should run `bash -c '...'`.
 *
 * Returned shape:
 *   [
 *     {
 *       op: 'always' | '&&' | '||',     // how to chain with previous
 *       pipeline: [ { argv: string[], redir: {in?, out?, append?, err?} }, ... ],
 *       background: boolean              // trailing & on the pipeline
 *     },
 *     ...
 *   ]
 */
function parse(line) {
  const tokens = tokenize(line).filter((t) => t.type !== T.WS && t.type !== T.COMMENT);
  /** @type {any[]} */
  const stmts = [];
  let chainOp = 'always';
  let pipeline = [];
  let current = newCmd();
  let background = false;

  function flushCmd() {
    if (current.argv.length || current.redir.in || current.redir.out || current.redir.err) {
      pipeline.push(current);
    }
    current = newCmd();
  }
  function flushStmt() {
    flushCmd();
    if (pipeline.length) {
      stmts.push({ op: chainOp, pipeline, background });
    }
    pipeline = [];
    background = false;
  }

  for (let idx = 0; idx < tokens.length; idx++) {
    const tk = tokens[idx];
    if (tk.type === T.OP) {
      switch (tk.value) {
        case '|':
          flushCmd();
          continue;
        case ';':
          flushStmt();
          chainOp = 'always';
          continue;
        case '&&':
          flushStmt();
          chainOp = '&&';
          continue;
        case '||':
          flushStmt();
          chainOp = '||';
          continue;
        case '&':
          background = true;
          flushStmt();
          chainOp = 'always';
          continue;
        case '>':
        case '>>':
        case '<':
        case '2>': {
          // Next token is the target file.
          const next = tokens[idx + 1];
          if (!next || next.type === T.OP) continue; // syntax slop, ignore
          idx++;
          const path = unquote(next);
          if (tk.value === '<')  current.redir.in = path;
          if (tk.value === '>')  { current.redir.out = path; current.redir.append = false; }
          if (tk.value === '>>') { current.redir.out = path; current.redir.append = true; }
          if (tk.value === '2>') current.redir.err = path;
          continue;
        }
      }
    } else {
      current.argv.push(tk);
    }
  }
  flushStmt();
  return stmts;
}

function newCmd() {
  return { argv: [], redir: {} };
}

/**
 * Strip the quote characters from a token. Used by the executor when it
 * actually needs the literal value. The highlighter never calls this — it
 * keeps the original substring with quotes intact for accurate coloring.
 */
function unquote(tk) {
  if (!tk) return '';
  if (tk.type === T.WORD || tk.type === T.VAR) return tk.value;
  if (tk.type === T.SQ_STRING) return tk.value.slice(1, -1);
  if (tk.type === T.DQ_STRING) {
    let raw = tk.value.slice(1, -1);
    raw = raw.replace(/\\(.)/g, '$1');
    return raw;
  }
  return tk.value;
}

module.exports = { T, tokenize, parse, unquote };
