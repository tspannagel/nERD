import * as esbuild from 'esbuild';
import { readdirSync } from 'fs';

const args = process.argv.slice(2);
const production = args.includes('--production');
const watch = args.includes('--watch');

const builds = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  },
  {
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    loader: { '.css': 'text' },
  },
];

if (args.includes('--tests')) {
  builds.length = 0;
  builds.push({
    entryPoints: readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`),
    outdir: 'dist-test',
    platform: 'node',
    format: 'cjs',
  });
}

const common = { bundle: true, minify: production, sourcemap: !production, target: 'es2022', logLevel: 'info' };
if (watch) {
  for (const b of builds) await (await esbuild.context({ ...common, ...b })).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b })));
}
