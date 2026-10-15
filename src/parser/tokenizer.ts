export type TokenType = 'word' | 'ident' | 'var' | 'string' | 'number' | 'punct';

export interface Token {
  t: TokenType;
  v: string; // identifiers unquoted; words as written
  u: string; // upper-case value for keyword checks ('' for quoted identifiers)
  line: number; // 0-based
  start: number; // offset into the source
  end: number;
}

const WORD_START = /[A-Za-z_#\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_@#$\u0080-￿]/;

/** T-SQL tokenizer. Comments are dropped; quoted identifiers become `ident`. */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 0;
  const n = src.length;

  const push = (t: TokenType, v: string, start: number, startLine: number, upper = true) =>
    out.push({ t, v, u: upper ? v.toUpperCase() : '', line: startLine, start, end: i });

  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') { i++; continue; }

    // -- line comment
    if (c === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // /* block comment */ (T-SQL allows nesting)
    if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '\n') line++;
        if (src[i] === '/' && src[i + 1] === '*') { depth++; i += 2; continue; }
        if (src[i] === '*' && src[i + 1] === '/') { depth--; i += 2; continue; }
        i++;
      }
      continue;
    }

    const start = i;
    const startLine = line;

    // N'unicode' and 'string'
    if (c === "'" || ((c === 'N' || c === 'n') && src[i + 1] === "'")) {
      if (c !== "'") i++;
      i++;
      let v = '';
      while (i < n) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") { v += "'"; i += 2; continue; }
          i++;
          break;
        }
        if (src[i] === '\n') line++;
        v += src[i++];
      }
      push('string', v, start, startLine, false);
      continue;
    }

    // [bracketed identifier]
    if (c === '[') {
      i++;
      let v = '';
      while (i < n) {
        if (src[i] === ']') {
          if (src[i + 1] === ']') { v += ']'; i += 2; continue; }
          i++;
          break;
        }
        if (src[i] === '\n') line++;
        v += src[i++];
      }
      push('ident', v, start, startLine, false);
      continue;
    }

    // "quoted identifier"
    if (c === '"') {
      i++;
      let v = '';
      while (i < n) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') { v += '"'; i += 2; continue; }
          i++;
          break;
        }
        if (src[i] === '\n') line++;
        v += src[i++];
      }
      push('ident', v, start, startLine, false);
      continue;
    }

    // @variable / @@function
    if (c === '@') {
      i++;
      while (i < n && (WORD_PART.test(src[i]) || src[i] === '@')) i++;
      push('var', src.slice(start, i), start, startLine);
      continue;
    }

    // numbers (incl. 0x binary literals and decimals)
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      i++;
      while (i < n && /[0-9A-Za-z_.]/.test(src[i])) i++;
      push('number', src.slice(start, i), start, startLine);
      continue;
    }

    if (WORD_START.test(c)) {
      i++;
      while (i < n && WORD_PART.test(src[i])) i++;
      push('word', src.slice(start, i), start, startLine);
      continue;
    }

    // punctuation: keep two-char operators together
    const two = src.slice(i, i + 2);
    if (['<>', '<=', '>=', '!=', '!<', '!>', '::', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='].includes(two)) {
      i += 2;
      push('punct', two, start, startLine);
      continue;
    }
    i++;
    push('punct', c, start, startLine);
  }
  return out;
}

export function isIdent(tok: Token | undefined): boolean {
  return !!tok && (tok.t === 'ident' || tok.t === 'word');
}
