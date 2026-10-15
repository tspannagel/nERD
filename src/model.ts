// Shared schema model. Pure data (JSON-serializable) so it can cross the
// extension/webview boundary and, later, be the source for code generation.

export type ObjectKind = 'table' | 'view' | 'procedure' | 'function';

export interface SourceRef {
  file: string; // absolute path
  line: number; // 0-based
}

export interface Column {
  name: string;
  type: string; // e.g. "nvarchar(50)", "decimal(18,2)", or "AS (expr)" for computed
  nullable: boolean;
  isPrimaryKey: boolean;
  identity?: string; // e.g. "IDENTITY(1,1)"
  default?: string;
  computed?: boolean;
  unique?: boolean;
}

export interface Parameter {
  name: string; // includes leading '@'
  type: string;
  output?: boolean;
  default?: string;
}

export interface ForeignKey {
  name?: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface DbObject {
  id: string; // "schema.name", lower-cased
  kind: ObjectKind;
  schema: string;
  name: string;
  columns: Column[]; // tables, views (when resolvable), table-valued function results
  parameters: Parameter[]; // procedures, functions
  returns?: string; // functions
  foreignKeys: ForeignKey[]; // tables
  references: string[]; // ids of objects referenced from the body (views/procs/functions)
  source?: SourceRef;
}

export interface Relation {
  id: string;
  kind: 'fk' | 'dependency';
  from: string; // object id
  to: string; // object id
  fromColumns?: string[];
  toColumns?: string[];
  label?: string;
}

export interface SchemaModel {
  project: string; // project name
  projectFile: string;
  objects: DbObject[];
  relations: Relation[];
  warnings: string[];
}

export function objectId(schema: string, name: string): string {
  return `${schema}.${name}`.toLowerCase();
}
