// Rebuild the browser libraries from the npm lockfile, including the notices for shipped modules.
import { build } from 'esbuild';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const output = 'web/vendor';
await mkdir(output, { recursive: true });
const modules = new Map();
for (const [entry, globalName] of [['latex', 'PaperColabLatex'], ['engines', 'PaperColabEngines']]) {
  const result = await build({
    entryPoints: ['vendor-src/' + entry + '.mjs'], outfile: output + '/' + entry + '.min.js',
    globalName, bundle: true, minify: true, target: 'es2022', format: 'iife', platform: 'browser',
    metafile: true, legalComments: 'none', footer: { js: 'globalThis.' + globalName + ' = ' + globalName + ';' }
  });
  for (const file of Object.values(result.metafile.outputs)) {
    for (const [name, input] of Object.entries(file.inputs)) {
      if (!input.bytesInOutput || !name.includes('node_modules/')) continue;
      const match = name.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
      if (!match || modules.has(match[1])) continue;
      const pkg = JSON.parse(await readFile(path.join(match[1], 'package.json'), 'utf8'));
      const names = await readdir(match[1]);
      const local = names.find(n => /^licen[cs]e(?:\.\w+)?$/i.test(n));
      const fallback = { '@tiptap': 'tiptap.txt', '@unified-latex': 'unified-latex.txt' }[pkg.name.split('/')[0]];
      if (!local && !fallback) throw new Error('Missing licence text for ' + pkg.name);
      const license = await readFile(local ? path.join(match[1], local) : path.join('vendor-src/notices', fallback), 'utf8');
      modules.set(match[1], { label: pkg.name + '@' + pkg.version, license: license.trim() });
    }
  }
}
const sorted = [...modules.values()].sort((a, b) => a.label < b.label ? -1 : 1);
await writeFile(output + '/editor-NOTICES.txt', sorted.map(m => m.label + '\n\n' + m.license).join('\n\n-----\n\n') + '\n');
