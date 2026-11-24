// Build locally; never fetch scripts from a CDN or change offline bundles.
import {build} from 'esbuild';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const dir=fileURLToPath(new URL('.',import.meta.url));
const result=await build({entryPoints:[path.join(dir,'browser.mjs')],outfile:path.join(dir,'browser.bundle.js'),
  bundle:true,minify:true,format:'esm',platform:'browser',target:'es2022',metafile:true,legalComments:'inline'});
const packages=new Map();
for(const name of Object.keys(result.metafile.inputs)){
  const match=name.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if(!match||packages.has(match[1]))continue;
  const pkg=JSON.parse(await readFile(path.join(match[1],'package.json'),'utf8'));
  const license=(await readdir(match[1])).find(n=>/^licen[cs]e(?:\.\w+)?$/i.test(n));
  if(!license)throw Error('Missing licence for '+pkg.name);
  packages.set(match[1],pkg.name+'@'+pkg.version+'\n\n'+(await readFile(path.join(match[1],license),'utf8')).trim());
}
await writeFile(path.join(dir,'browser-NOTICES.txt'),[...packages.values()].sort().join('\n\n-----\n\n')+'\n');
