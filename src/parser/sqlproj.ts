import * as fs from 'fs';
import * as path from 'path';

export interface SqlProject {
  name: string;
  file: string;
  dir: string;
  sdkStyle: boolean;
  sqlFiles: string[]; // absolute paths
}

const SKIP_DIRS = new Set(['bin', 'obj', 'node_modules', '.git', '.vs']);

/** Reads a .sqlproj (legacy SSDT or SDK-style Microsoft.Build.Sql) and lists its build scripts. */
export function readSqlProject(file: string): SqlProject {
  const xml = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  const name = tag(xml, 'Name') ?? path.basename(file, path.extname(file));
  const sdkStyle = /<Project[^>]*\bSdk\s*=/.test(xml) || /<Sdk\s+Name\s*=\s*"Microsoft\.Build\.Sql"/i.test(xml);

  const includes = items(xml, 'Build', 'Include');
  const removes = [
    ...items(xml, 'Build', 'Remove'),
    ...items(xml, 'None', 'Include'),
    ...items(xml, 'PreDeploy', 'Include'),
    ...items(xml, 'PostDeploy', 'Include'),
    ...items(xml, 'RefactorLog', 'Include'),
  ];
  // SDK-style projects implicitly include every .sql file under the project folder.
  if (sdkStyle && !/<EnableDefaultSqlItems>\s*false/i.test(xml)) includes.unshift('**/*.sql');

  const all = walk(dir);
  const rel = (f: string) => path.relative(dir, f).split(path.sep).join('/');
  const inc = includes.map(globRe);
  const exc = removes.map(globRe);
  const sqlFiles = all.filter((f) => {
    const r = rel(f);
    return inc.some((re) => re.test(r)) && !exc.some((re) => re.test(r));
  });
  sqlFiles.sort();
  return { name, file, dir, sdkStyle, sqlFiles };
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return m?.[1].trim() || undefined;
}

function items(xml: string, element: string, attr: string): string[] {
  const re = new RegExp(`<${element}\\s+[^>]*\\b${attr}\\s*=\\s*"([^"]+)"`, 'g');
  const out: string[] = [];
  for (let m; (m = re.exec(xml)); ) {
    for (const part of m[1].split(';')) {
      const v = decodeXml(part.trim()).replace(/\\/g, '/');
      if (v && !v.includes('$(')) out.push(v);
    }
  }
  return out;
}

function decodeXml(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/** MSBuild glob → RegExp over '/'-separated project-relative paths (case-insensitive like Windows). */
export function globRe(glob: string): RegExp {
  let g = glob.replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name.toLowerCase())) walk(full, out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.sql')) out.push(full);
  }
  return out;
}
