// Run the browser's exact static checks on one or more local corpus ZIPs.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
globalThis.zip = require('../web/vendor/zip-core.min.js');
require('../web/archive.js');
require('../web/inspect.js');

async function check(filename) {
  if (fs.statSync(filename).size > 64 * 1024 * 1024) throw new Error('Archive exceeds 64 MiB.');
  const bytes = fs.readFileSync(filename);
  const data = PaperColabInspect.inventory(await PaperColabArchive.readArchive(new Blob([bytes])));
  const roots = data.roots.map(root => {
    const { sources, references, notes } = PaperColabInspect.inspectRoot(data, root);
    const counts = { found: 0, toolchain: 0, review: 0, missing: 0 };
    for (const ref of references) counts[ref.status]++;
    return { root, sources, counts, notes };
  });
  return { name: path.basename(filename), sha256: createHash('sha256').update(bytes).digest('hex'),
    files: data.files.size, roots, archiveFindings: data.notes, pdfBuild: 'not-run', roundTrip: 'not-run' };
}

(async () => {
  if (process.argv.length < 3) { console.error('Usage: node corpus/check.cjs PROJECT.zip [...]'); process.exitCode = 2; }
  for (const filename of process.argv.slice(2)) {
    try { console.log(JSON.stringify(await check(filename))); }
    catch (error) { console.error(path.basename(filename) + ': ' + error.message); process.exitCode = 1; }
  }
})();
