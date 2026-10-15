import * as fs from 'fs';
import { Column, DbObject, Relation, SchemaModel, objectId } from '../model';
import { readSqlProject } from './sqlproj';
import { NameRef, ParsedObject, ParseResult, parseSql } from './tsql';

export { readSqlProject } from './sqlproj';
export { parseSql } from './tsql';

export interface SourceFile {
  file: string;
  text: string;
}

/** Parses every build script of a .sqlproj into a schema model. */
export function loadProject(projectFile: string, defaultSchema = 'dbo'): SchemaModel {
  const proj = readSqlProject(projectFile);
  const files: SourceFile[] = [];
  const warnings: string[] = [];
  for (const file of proj.sqlFiles) {
    try {
      files.push({ file, text: fs.readFileSync(file, 'utf8') });
    } catch (e) {
      warnings.push(`${file}: ${(e as Error).message}`);
    }
  }
  const model = buildModel(proj.name, projectFile, files, defaultSchema);
  model.warnings.unshift(...warnings);
  return model;
}

export function buildModel(project: string, projectFile: string, files: SourceFile[], defaultSchema = 'dbo'): SchemaModel {
  const results: ParseResult[] = files.map((f) => parseSql(f.text, f.file, defaultSchema));
  const warnings = results.flatMap((r) => r.warnings);

  const byId = new Map<string, ParsedObject>();
  for (const o of results.flatMap((r) => r.objects)) {
    if (byId.has(o.id)) {
      warnings.push(`Duplicate definition of ${o.schema}.${o.name} in ${o.source?.file}`);
      continue;
    }
    byId.set(o.id, o);
  }

  // merge ALTER TABLE ... ADD
  for (const a of results.flatMap((r) => r.alters)) {
    const t = byId.get(objectId(a.schema, a.name));
    if (!t || t.kind !== 'table') continue;
    for (const c of a.columns) if (!t.columns.some((x) => same(x.name, c.name))) t.columns.push(c);
    for (const name of a.primaryKey) {
      const c = t.columns.find((x) => same(x.name, name));
      if (c) { c.isPrimaryKey = true; c.nullable = false; }
    }
    t.foreignKeys.push(...a.foreignKeys);
  }

  const relations: Relation[] = [];
  const relIds = new Set<string>();

  // foreign keys
  for (const t of byId.values()) {
    if (t.kind !== 'table') continue;
    t.foreignKeys.forEach((fk, n) => {
      const to = objectId(fk.refSchema, fk.refTable);
      const target = byId.get(to);
      if (!target) {
        warnings.push(`${t.schema}.${t.name}: foreign key references unknown table ${fk.refSchema}.${fk.refTable}`);
        return;
      }
      // REFERENCES t without a column list → target primary key
      if (!fk.refColumns.length) fk.refColumns = target.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
      const id = `fk:${t.id}:${fk.name ?? n}`;
      relations.push({
        id, kind: 'fk', from: t.id, to,
        fromColumns: fk.columns, toColumns: fk.refColumns, label: fk.name,
      });
    });
  }

  // module dependencies
  for (const o of byId.values()) {
    if (o.kind === 'table') continue;
    const deps = new Set<string>();
    for (const ref of o.refs) {
      const hit = resolveRef(ref, byId, defaultSchema);
      if (hit && hit !== o.id) deps.add(hit);
    }
    o.references = [...deps].sort();
    for (const to of o.references) {
      const id = `dep:${o.id}:${to}`;
      if (relIds.has(id)) continue;
      relIds.add(id);
      relations.push({ id, kind: 'dependency', from: o.id, to });
    }
  }

  // view / inline-function column types
  for (const o of byId.values()) {
    if (o.viewColumns) o.columns = resolveViewColumns(o, byId, defaultSchema);
  }

  const objects: DbObject[] = [...byId.values()].map(strip);
  objects.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { project, projectFile, objects, relations, warnings };
}

function resolveRef(ref: NameRef, byId: Map<string, ParsedObject>, def: string): string | undefined {
  const p = ref.parts;
  const candidates: string[] = [];
  if (p.length === 1) {
    if (ref.strong) candidates.push(objectId(def, p[0]));
  } else {
    // a.b → schema.object; a.b.c → db.schema.object or schema.object.column
    candidates.push(objectId(p[p.length - 2] || def, p[p.length - 1]));
    if (p.length >= 3) candidates.push(objectId(p[p.length - 3] || def, p[p.length - 2]));
  }
  return candidates.find((c) => byId.has(c));
}

function resolveViewColumns(o: ParsedObject, byId: Map<string, ParsedObject>, def: string): Column[] {
  const sources = (o.viewSources ?? []).map((s) => ({
    alias: s.alias,
    obj: byId.get(objectId(s.parts.length > 1 ? s.parts[s.parts.length - 2] || def : def, s.parts[s.parts.length - 1])),
  }));
  const findSource = (q?: string) => (q ? sources.find((s) => s.alias === q.toLowerCase())?.obj : undefined);
  const out: Column[] = [];
  for (const vc of o.viewColumns ?? []) {
    if (vc.star) {
      const objs = vc.qualifier ? [findSource(vc.qualifier)] : sources.map((s) => s.obj);
      for (const so of objs) for (const c of so?.columns ?? []) out.push(viewCol(c.name, c));
      continue;
    }
    let src: Column | undefined;
    if (vc.column) {
      const cands = vc.qualifier ? [findSource(vc.qualifier)] : sources.map((s) => s.obj);
      for (const so of cands) {
        src = so?.columns.find((c) => same(c.name, vc.column!));
        if (src) break;
      }
    }
    out.push(viewCol(vc.name, src));
  }
  return out;
}

function viewCol(name: string, src?: Column): Column {
  return { name, type: src?.computed ? '' : src?.type ?? '', nullable: src?.nullable ?? true, isPrimaryKey: false };
}

function strip(o: ParsedObject): DbObject {
  const { refs: _r, viewColumns: _v, viewSources: _s, ...rest } = o;
  return rest;
}

function same(a: string, b: string) { return a.toLowerCase() === b.toLowerCase(); }
