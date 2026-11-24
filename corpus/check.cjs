// Run the browser's exact static checks on one or more local corpus ZIPs.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
globalThis.zip = require('../web/vendor/zip-core.min.js');
require('../web/vendor/latex.min.js');
require('../web/archive.js');
require('../web/inspect.js');
require('../web/blocks.js');

const coverageKeys = ['editableParagraphs', 'editableHeadings', 'fallbackParagraphs', 'fallbackHeadings', 'preservedBlocks', 'editableBlocks'];

function blankCoverage() {
  return { editableParagraphs: 0, editableHeadings: 0, fallbackParagraphs: 0, fallbackHeadings: 0,
    preservedBlocks: 0, editableBlocks: 0, fallbackCommands: [], uninspectedSources: [], fullFileFallbacks: [] };
}

function addCoverage(total, part) {
  for (const key of coverageKeys) total[key] += part[key];
  for (const item of part.fallbackCommands) {
    const found = total.fallbackCommands.find(entry => entry.command === item.command);
    if (found) found.blocks += item.blocks;
    else total.fallbackCommands.push({ command: item.command, blocks: item.blocks });
  }
  total.fallbackCommands.sort((a, b) => a.command < b.command ? -1 : a.command > b.command ? 1 : 0);
}

function manuscriptCoverage(data, root, sources) {
  const total = blankCoverage();
  for (const source of sources) {
    if (!/\.(?:tex|ltx)$/i.test(source)) continue;
    const text = data.files.get(source)?.text;
    if (typeof text !== 'string') { total.uninspectedSources.push(source); continue; }
    const report = PaperColabBlocks.coverage(PaperColabBlocks.parseFile(text, { root: source === root }));
    addCoverage(total, report);
    if (report.fullFileFallback) total.fullFileFallbacks.push({source, reason: report.fullFileReason});
  }
  return total;
}

async function check(filename) {
  if (fs.statSync(filename).size > 64 * 1024 * 1024) throw new Error('Archive exceeds 64 MiB.');
  const bytes = fs.readFileSync(filename);
  const data = PaperColabInspect.inventory(await PaperColabArchive.readArchive(new Blob([bytes])));
  const roots = data.roots.map(root => {
    const { sources, references, notes } = PaperColabInspect.inspectRoot(data, root);
    const counts = { found: 0, toolchain: 0, review: 0, missing: 0 };
    for (const ref of references) counts[ref.status]++;
    const coverage = manuscriptCoverage(data, root, sources);
    const parsed=data.parsed.get(root);
    return { root, sources, counts, notes, coverage,
      rootEvidence:{hasClass:parsed.hasClass,hasBody:parsed.hasBody,titles:parsed.titles} };
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
