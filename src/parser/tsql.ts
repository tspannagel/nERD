import { Column, DbObject, ForeignKey, ObjectKind, Parameter, objectId } from '../model';
import { Token, isIdent, tokenize } from './tokenizer';

/** A reference found in a module body, resolved against the catalog later. */
export interface NameRef {
  parts: string[]; // 1..4 name parts, unquoted
  strong: boolean; // appeared in a position that can only be an object (FROM, JOIN, EXEC, ...)
}

/** A view column whose type is looked up after all tables are known. */
export interface ViewColumnRef {
  name: string;
  qualifier?: string; // table alias or name, if given
  column?: string; // source column; undefined for expressions
  star?: boolean; // `*` or `alias.*`
}

export interface ViewSource {
  alias: string; // lower-case alias or object name
  parts: string[];
}

export interface ParsedObject extends DbObject {
  refs: NameRef[];
  viewColumns?: ViewColumnRef[];
  viewSources?: ViewSource[];
}

/** Constraints/columns from `ALTER TABLE ... ADD`, merged after all files are parsed. */
export interface AlterTable {
  schema: string;
  name: string;
  columns: Column[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
}

export interface ParseResult {
  objects: ParsedObject[];
  alters: AlterTable[];
  warnings: string[];
}

const TABLE_CONSTRAINT = new Set(['CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'INDEX', 'PERIOD']);
const STRONG_PREFIX = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'EXEC', 'EXECUTE', 'MERGE', 'APPLY', 'TABLE', 'USING']);

export function parseSql(src: string, file: string, defaultSchema = 'dbo'): ParseResult {
  const toks = tokenize(src);
  const p = new Parser(toks, src, file, defaultSchema);
  p.run();
  return { objects: p.objects, alters: p.alters, warnings: p.warnings };
}

class Parser {
  objects: ParsedObject[] = [];
  alters: AlterTable[] = [];
  warnings: string[] = [];
  private i = 0;

  constructor(
    private toks: Token[],
    private src: string,
    private file: string,
    private defSchema: string,
  ) {}

  run() {
    while (this.i < this.toks.length) {
      const t = this.toks[this.i];
      if (t.u === 'CREATE' || t.u === 'ALTER') {
        const start = this.i;
        try {
          if (this.statement()) continue;
        } catch (e) {
          this.warnings.push(`${this.file}:${t.line + 1}: ${(e as Error).message}`);
        }
        this.i = start + 1;
        continue;
      }
      this.i++;
    }
  }

  // ---- helpers ---------------------------------------------------------

  private peek(o = 0) { return this.toks[this.i + o]; }
  private is(u: string, o = 0) { return this.toks[this.i + o]?.u === u; }
  private isP(v: string, o = 0) { const t = this.toks[this.i + o]; return !!t && t.t === 'punct' && t.v === v; }

  private expectP(v: string) {
    if (!this.isP(v)) throw new Error(`expected '${v}' near '${this.peek()?.v ?? 'EOF'}'`);
    this.i++;
  }

  /** Multi-part name: a.b.c (empty parts allowed, e.g. db..obj). */
  private name(): string[] {
    const parts: string[] = [];
    if (!isIdent(this.peek())) throw new Error(`expected name near '${this.peek()?.v ?? 'EOF'}'`);
    parts.push(this.toks[this.i++].v);
    while (this.isP('.')) {
      this.i++;
      if (this.isP('.')) { parts.push(''); continue; }
      if (!isIdent(this.peek())) break;
      parts.push(this.toks[this.i++].v);
    }
    return parts;
  }

  private schemaName(parts: string[]): [string, string] {
    const name = parts[parts.length - 1];
    const schema = parts.length > 1 && parts[parts.length - 2] ? parts[parts.length - 2] : this.defSchema;
    return [schema, name];
  }

  /** Index of the matching ')' for the '(' at index `open`. */
  private closeParen(open: number): number {
    let depth = 0;
    for (let k = open; k < this.toks.length; k++) {
      const t = this.toks[k];
      if (t.t !== 'punct') continue;
      if (t.v === '(') depth++;
      else if (t.v === ')' && --depth === 0) return k;
    }
    return this.toks.length - 1;
  }

  /** Splits [from, to) on top-level commas. */
  private splitCommas(from: number, to: number): [number, number][] {
    const out: [number, number][] = [];
    let depth = 0;
    let s = from;
    for (let k = from; k < to; k++) {
      const t = this.toks[k];
      if (t.t !== 'punct') continue;
      if (t.v === '(') depth++;
      else if (t.v === ')') depth--;
      else if (t.v === ',' && depth === 0) { out.push([s, k]); s = k + 1; }
    }
    if (s < to) out.push([s, to]);
    return out;
  }

  private text(from: number, to: number): string {
    if (from >= to) return '';
    return this.src.slice(this.toks[from].start, this.toks[to - 1].end).replace(/\s+/g, ' ').trim();
  }

  /** End of the current batch: next `GO` that starts a line, or EOF. */
  private batchEnd(from: number): number {
    for (let k = from; k < this.toks.length; k++) {
      const t = this.toks[k];
      if (t.u === 'GO' && (k === 0 || this.toks[k - 1].line < t.line)) return k;
    }
    return this.toks.length;
  }

  private newObject(kind: ObjectKind, parts: string[], line: number): ParsedObject {
    const [schema, name] = this.schemaName(parts);
    return {
      id: objectId(schema, name), kind, schema, name,
      columns: [], parameters: [], foreignKeys: [], references: [], refs: [],
      source: { file: this.file, line },
    };
  }

  // ---- statements ------------------------------------------------------

  /** Returns true when it consumed a statement (this.i already advanced). */
  private statement(): boolean {
    const first = this.peek();
    const isAlter = first.u === 'ALTER';
    this.i++;
    if (this.is('OR') && this.is('ALTER', 1)) this.i += 2;
    const kw = this.peek()?.u;
    if (kw === 'TABLE') {
      this.i++;
      if (isAlter) return this.alterTable();
      return this.createTable(first.line);
    }
    if (kw === 'VIEW') { this.i++; return this.module('view', first.line); }
    if (kw === 'PROC' || kw === 'PROCEDURE') { this.i++; return this.module('procedure', first.line); }
    if (kw === 'FUNCTION') { this.i++; return this.module('function', first.line); }
    return false;
  }

  private createTable(line: number): boolean {
    const parts = this.name();
    if (parts[parts.length - 1].startsWith('#')) return false; // temp table
    if (this.is('AS') && (this.is('NODE', 1) || this.is('EDGE', 1))) this.i += 2;
    const obj = this.newObject('table', parts, line);
    if (!this.isP('(')) return false; // CREATE TABLE ... AS FileTable etc.
    const open = this.i;
    const close = this.closeParen(open);
    const pk: string[] = [];
    for (const [s, e] of this.splitCommas(open + 1, close)) {
      this.tableItem(s, e, obj.columns, pk, obj.foreignKeys);
    }
    markPk(obj.columns, pk);
    this.objects.push(obj);
    this.i = close + 1;
    return true;
  }

  private alterTable(): boolean {
    const parts = this.name();
    const [schema, name] = this.schemaName(parts);
    if (this.is('WITH') && (this.is('CHECK', 1) || this.is('NOCHECK', 1))) this.i += 2;
    if (!this.is('ADD')) return false;
    this.i++;
    // statement runs until ';', next GO, or next top-level statement keyword
    const end = this.statementEnd(this.i);
    const alter: AlterTable = { schema, name, columns: [], primaryKey: [], foreignKeys: [] };
    for (const [s, e] of this.splitCommas(this.i, end)) {
      this.tableItem(s, e, alter.columns, alter.primaryKey, alter.foreignKeys);
    }
    this.alters.push(alter);
    this.i = end;
    return true;
  }

  private statementEnd(from: number): number {
    let depth = 0;
    for (let k = from; k < this.toks.length; k++) {
      const t = this.toks[k];
      if (t.t === 'punct') {
        if (t.v === '(') depth++;
        else if (t.v === ')') depth--;
        else if (t.v === ';' && depth === 0) return k;
        continue;
      }
      if (depth === 0 && (t.u === 'GO' || t.u === 'CREATE' || t.u === 'ALTER' || t.u === 'EXEC' || t.u === 'EXECUTE')) return k;
    }
    return this.toks.length;
  }

  /** A column definition or table constraint inside CREATE TABLE (...) / ALTER TABLE ADD. */
  private tableItem(s: number, e: number, cols: Column[], pk: string[], fks: ForeignKey[]) {
    if (s >= e) return;
    const t = this.toks;
    let k = s;
    let constraintName: string | undefined;
    if (t[k].u === 'CONSTRAINT') { constraintName = t[k + 1]?.v; k += 2; }

    if (TABLE_CONSTRAINT.has(t[k]?.u) && t[k].t === 'word') {
      const kw = t[k].u;
      if (kw === 'PRIMARY' && t[k + 1]?.u === 'KEY') {
        const cols2 = this.columnList(k + 2, e);
        pk.push(...cols2);
      } else if (kw === 'FOREIGN' && t[k + 1]?.u === 'KEY') {
        const open = this.findP('(', k + 2, e);
        if (open < 0) return;
        const close = this.closeParen(open);
        const columns = this.identsIn(open + 1, close);
        const fk = this.references(close + 1, e, columns, constraintName);
        if (fk) fks.push(fk);
      } else if (kw === 'UNIQUE') {
        const uq = this.columnList(k + 1, e);
        if (uq.length === 1) {
          const c = cols.find((c) => eq(c.name, uq[0]));
          if (c) c.unique = true;
        }
      }
      return;
    }

    // column definition
    if (!isIdent(t[k])) return;
    const col: Column = { name: t[k].v, type: '', nullable: true, isPrimaryKey: false };
    k++;
    if (t[k]?.u === 'AS') {
      col.computed = true;
      col.type = 'AS ' + this.text(k + 1, e);
      col.type = col.type.replace(/\s+PERSISTED.*$/i, ' PERSISTED');
      cols.push(col);
      return;
    }
    // data type: [schema.]name [(args)]
    const typeStart = k;
    while (k < e && isIdent(t[k])) {
      k++;
      if (t[k]?.t === 'punct' && t[k].v === '.') k++;
      else break;
    }
    if (k < e && t[k].t === 'punct' && t[k].v === '(') k = this.closeParen(k) + 1;
    col.type = this.text(typeStart, k).replace(/\s*\(\s*/g, '(').replace(/\s*,\s*/g, ',').replace(/\s*\)/g, ')');

    while (k < e) {
      const u = t[k].u;
      if (u === 'NOT' && t[k + 1]?.u === 'NULL') { col.nullable = false; k += 2; continue; }
      if (u === 'NULL') { col.nullable = true; k++; continue; }
      if (u === 'IDENTITY') {
        let end = k + 1;
        if (t[end]?.v === '(') end = this.closeParen(end) + 1;
        col.identity = this.text(k, end).replace(/\s+/g, '');
        k = end;
        continue;
      }
      if (u === 'DEFAULT') {
        let end = k + 1;
        if (t[end]?.v === '(') end = this.closeParen(end) + 1;
        else {
          end++;
          if (t[end]?.v === '(') end = this.closeParen(end) + 1; // GETDATE()
        }
        col.default = stripParens(this.text(k + 1, end));
        k = end;
        continue;
      }
      if (u === 'PRIMARY' && t[k + 1]?.u === 'KEY') { pk.push(col.name); k += 2; continue; }
      if (u === 'UNIQUE') { col.unique = true; k++; continue; }
      if (u === 'CONSTRAINT') { constraintName = t[k + 1]?.v; k += 2; continue; }
      if (u === 'FOREIGN' && t[k + 1]?.u === 'KEY') { k += 2; continue; }
      if (u === 'REFERENCES') {
        const fk = this.references(k, e, [col.name], constraintName);
        if (fk) fks.push(fk);
        break;
      }
      if (u === 'CHECK' && t[k + 1]?.v === '(') { k = this.closeParen(k + 1) + 1; continue; }
      k++;
    }
    cols.push(col);
  }

  /** Parses `REFERENCES x [(cols)] [ON DELETE ..] [ON UPDATE ..]` starting at/after index k. */
  private references(k: number, e: number, columns: string[], name?: string): ForeignKey | undefined {
    const t = this.toks;
    while (k < e && t[k].u !== 'REFERENCES') k++;
    if (k >= e) return undefined;
    const save = this.i;
    this.i = k + 1;
    const parts = this.name();
    let refColumns: string[] = [];
    if (this.isP('(')) {
      const close = this.closeParen(this.i);
      refColumns = this.identsIn(this.i + 1, close);
      this.i = close + 1;
    }
    const [refSchema, refTable] = this.schemaName(parts);
    const fk: ForeignKey = { name, columns, refSchema, refTable, refColumns };
    while (this.i < e) {
      if (this.is('ON') && (this.is('DELETE', 1) || this.is('UPDATE', 1))) {
        const which = this.peek(1).u;
        let action = this.peek(2)?.u ?? '';
        let adv = 3;
        if ((action === 'SET' || action === 'NO') && this.peek(3)) { action += ' ' + this.peek(3).u; adv = 4; }
        if (which === 'DELETE') fk.onDelete = action; else fk.onUpdate = action;
        this.i += adv;
        continue;
      }
      this.i++;
    }
    this.i = save;
    return fk;
  }

  private findP(v: string, from: number, to: number): number {
    for (let k = from; k < to; k++) if (this.toks[k].t === 'punct' && this.toks[k].v === v) return k;
    return -1;
  }

  /** `[CLUSTERED|NONCLUSTERED] (a ASC, b DESC)` → [a, b] */
  private columnList(from: number, to: number): string[] {
    const open = this.findP('(', from, to);
    if (open < 0) return [];
    const close = this.closeParen(open);
    return this.identsIn(open + 1, close);
  }

  private identsIn(from: number, to: number): string[] {
    return this.splitCommas(from, to)
      .map(([s]) => this.toks[s])
      .filter((t) => isIdent(t))
      .map((t) => t.v);
  }

  // ---- views, procedures, functions ------------------------------------

  private module(kind: ObjectKind, line: number): boolean {
    const parts = this.name();
    const obj = this.newObject(kind, parts, line);
    const end = this.batchEnd(this.i);

    if (kind === 'view') {
      if (this.isP('(')) {
        const close = this.closeParen(this.i);
        obj.viewColumns = this.identsIn(this.i + 1, close).map((name) => ({ name }));
        this.i = close + 1;
      }
    } else if (kind === 'procedure') {
      // optional ";number", then parameters (with or without parens) up to WITH/FOR/AS
      let from = this.i;
      let to = from;
      let depth = 0;
      while (to < end) {
        const t = this.toks[to];
        if (t.t === 'punct' && t.v === '(') depth++;
        if (t.t === 'punct' && t.v === ')') depth--;
        if (depth === 0 && (t.u === 'AS' || t.u === 'WITH' || t.u === 'FOR') && t.t === 'word' && this.toks[to - 1]?.t !== 'var') break;
        to++;
      }
      if (this.toks[from]?.v === '(' && this.closeParen(from) === to - 1) { from++; to--; }
      obj.parameters = this.params(from, to);
      this.i = to;
    } else {
      if (this.isP('(')) {
        const close = this.closeParen(this.i);
        obj.parameters = this.params(this.i + 1, close);
        this.i = close + 1;
      }
      if (this.is('RETURNS')) {
        this.i++;
        if (this.is('TABLE')) {
          obj.returns = 'TABLE';
          this.i++;
        } else if (this.peek()?.t === 'var' && this.is('TABLE', 1)) {
          obj.returns = `${this.peek().v} TABLE`;
          this.i += 2;
          if (this.isP('(')) {
            const close = this.closeParen(this.i);
            const pk: string[] = [];
            for (const [s, e] of this.splitCommas(this.i + 1, close)) this.tableItem(s, e, obj.columns, pk, []);
            markPk(obj.columns, pk);
            this.i = close + 1;
          }
        } else {
          const s = this.i;
          while (this.i < end && isIdent(this.peek()) && !this.is('AS') && !this.is('WITH')) {
            this.i++;
            if (this.isP('.')) this.i++; else break;
          }
          if (this.isP('(')) this.i = this.closeParen(this.i) + 1;
          obj.returns = this.text(s, this.i);
        }
      }
    }

    // body: everything after the header up to the end of the batch
    const bodyStart = this.i;
    obj.refs = this.collectRefs(bodyStart, end);
    if (kind === 'view' || obj.returns === 'TABLE') this.viewSelect(obj, bodyStart, end);
    this.objects.push(obj);
    this.i = end;
    return true;
  }

  private params(from: number, to: number): Parameter[] {
    const out: Parameter[] = [];
    for (const [s, e] of this.splitCommas(from, to)) {
      const t = this.toks;
      if (t[s]?.t !== 'var') continue;
      const p: Parameter = { name: t[s].v, type: '' };
      let k = s + 1;
      if (t[k]?.u === 'AS') k++;
      const ts = k;
      while (k < e && isIdent(t[k])) {
        k++;
        if (t[k]?.v === '.') k++; else break;
      }
      if (t[k]?.v === '(') k = this.closeParen(k) + 1;
      p.type = this.text(ts, k).replace(/\s+/g, '');
      for (; k < e; k++) {
        const u = t[k].u;
        if (u === 'OUTPUT' || u === 'OUT') p.output = true;
        else if (u === 'READONLY') p.type += ' READONLY';
        else if (t[k].v === '=') {
          let d = k + 1;
          while (d < e && !['OUTPUT', 'OUT', 'READONLY'].includes(t[d].u)) d++;
          p.default = this.text(k + 1, d);
          k = d - 1;
        }
      }
      out.push(p);
    }
    return out;
  }

  private collectRefs(from: number, to: number): NameRef[] {
    const refs: NameRef[] = [];
    const t = this.toks;
    for (let k = from; k < to; k++) {
      if (!isIdent(t[k])) continue;
      if (k > from && t[k - 1].t === 'punct' && t[k - 1].v === '.') continue; // middle of a name
      const prev = t[k - 1];
      const parts = [t[k].v];
      let j = k + 1;
      while (j < to && t[j].t === 'punct' && t[j].v === '.') {
        if (t[j + 1]?.t === 'punct' && t[j + 1].v === '.') { parts.push(''); j++; continue; }
        if (!isIdent(t[j + 1])) break;
        parts.push(t[j + 1].v);
        j += 2;
      }
      const strong = !!prev && prev.t === 'word' && STRONG_PREFIX.has(prev.u);
      if (parts.length > 1 || strong) refs.push({ parts, strong });
      k = j - 1;
    }
    return refs;
  }

  /** Best-effort read of the first top-level SELECT list and FROM sources (for column types). */
  private viewSelect(obj: ParsedObject, from: number, to: number) {
    const t = this.toks;
    let sel = -1;
    let depth = 0;
    for (let k = from; k < to; k++) {
      if (t[k].v === '(') depth++;
      else if (t[k].v === ')') depth--;
      else if (depth === 0 && t[k].u === 'SELECT') { sel = k; break; }
    }
    if (sel < 0) {
      // RETURN ( SELECT ... ) in inline TVFs
      for (let k = from; k < to; k++) if (t[k].u === 'SELECT') { sel = k; break; }
      if (sel < 0) return;
    }
    // find FROM at the same depth as SELECT
    let fromIdx = -1;
    depth = 0;
    let end = to;
    for (let k = sel + 1; k < to; k++) {
      if (t[k].v === '(') depth++;
      else if (t[k].v === ')') { if (--depth < 0) { end = k; break; } }
      else if (depth === 0 && t[k].u === 'FROM' && fromIdx < 0) fromIdx = k;
    }
    let listStart = sel + 1;
    while (['DISTINCT', 'ALL'].includes(t[listStart]?.u)) listStart++;
    if (t[listStart]?.u === 'TOP') {
      listStart++;
      if (t[listStart]?.v === '(') listStart = this.closeParen(listStart) + 1; else listStart++;
      if (t[listStart]?.u === 'PERCENT') listStart++;
      if (t[listStart]?.u === 'WITH' && t[listStart + 1]?.u === 'TIES') listStart += 2;
    }
    const listEnd = fromIdx > 0 ? fromIdx : end;

    const explicit = obj.viewColumns;
    const cols: ViewColumnRef[] = [];
    for (const [s, e] of this.splitCommas(listStart, listEnd)) {
      const n = e - s;
      if (n <= 0) continue;
      // name = expr
      if (n >= 3 && isIdent(t[s]) && t[s + 1].v === '=') {
        cols.push({ name: t[s].v, ...this.simpleColumn(s + 2, e) });
        continue;
      }
      // expr [AS] alias
      let alias: string | undefined;
      let exprEnd = e;
      if (n >= 2 && (isIdent(t[e - 1]) || t[e - 1].t === 'string')) {
        if (t[e - 2].u === 'AS') { alias = t[e - 1].v; exprEnd = e - 2; }
        // `expr alias` without AS; `a.b` ends with '.' + ident and has no alias
        else if (!(t[e - 2].t === 'punct' && t[e - 2].v === '.')) { alias = t[e - 1].v; exprEnd = e - 1; }
      }
      const src = this.simpleColumn(s, exprEnd);
      if (src.star) { cols.push({ name: '*', ...src }); continue; }
      const name = alias ?? src.column;
      if (name) cols.push({ name, ...src });
    }
    obj.viewColumns = explicit
      ? explicit.map((c, i) => ({ ...cols[i], name: c.name }))
      : cols;

    // FROM sources and aliases
    if (fromIdx < 0) return;
    const sources: ViewSource[] = [];
    depth = 0;
    for (let k = fromIdx; k < end; k++) {
      if (t[k].v === '(') { depth++; continue; }
      if (t[k].v === ')') { depth--; continue; }
      if (depth !== 0) continue;
      if (t[k].u === 'WHERE' || t[k].u === 'GROUP' || t[k].u === 'ORDER' || t[k].u === 'UNION' || t[k].u === 'HAVING') break;
      if ((t[k].u === 'FROM' || t[k].u === 'JOIN' || t[k].v === ',' || t[k].u === 'APPLY') && isIdent(t[k + 1])) {
        const save = this.i;
        this.i = k + 1;
        const parts = this.name();
        if (this.isP('(')) this.i = this.closeParen(this.i) + 1; // TVF call
        let alias = parts[parts.length - 1];
        if (this.is('AS')) this.i++;
        if (isIdent(this.peek()) && !JOIN_WORDS.has(this.peek().u)) alias = this.peek().v;
        sources.push({ alias: alias.toLowerCase(), parts });
        k = this.i - 1;
        this.i = save;
      }
    }
    obj.viewSources = sources;
  }

  private simpleColumn(s: number, e: number): Omit<ViewColumnRef, 'name'> {
    const t = this.toks;
    const n = e - s;
    if (n === 1 && t[s].v === '*') return { star: true };
    if (n === 3 && isIdent(t[s]) && t[s + 1].v === '.' && t[s + 2].v === '*') return { star: true, qualifier: t[s].v };
    if (n === 1 && isIdent(t[s])) return { column: t[s].v };
    if (n === 3 && isIdent(t[s]) && t[s + 1].v === '.' && isIdent(t[s + 2])) return { qualifier: t[s].v, column: t[s + 2].v };
    return {};
  }
}

const JOIN_WORDS = new Set([
  'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'JOIN', 'ON', 'WHERE', 'GROUP', 'ORDER',
  'UNION', 'WITH', 'APPLY', 'HAVING', 'OPTION', 'FOR', 'EXCEPT', 'INTERSECT',
]);

function markPk(cols: Column[], pk: string[]) {
  for (const name of pk) {
    const c = cols.find((c) => eq(c.name, name));
    if (c) { c.isPrimaryKey = true; c.nullable = false; }
  }
}

function eq(a: string, b: string) { return a.toLowerCase() === b.toLowerCase(); }

function stripParens(s: string): string {
  let r = s.trim();
  while (r.startsWith('(') && r.endsWith(')') && balanced(r.slice(1, -1))) r = r.slice(1, -1).trim();
  return r;
}

function balanced(s: string): boolean {
  let d = 0;
  for (const ch of s) {
    if (ch === '(') d++;
    else if (ch === ')' && --d < 0) return false;
  }
  return d === 0;
}
