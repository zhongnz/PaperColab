// Exercise a copy of a published source, compare original bytes, and emit a ZIP for the independent TeX build.
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
globalThis.zip = require('../web/vendor/zip-core.min.js');
require('../web/vendor/latex.min.js');
require('../web/blocks.js');
require('../web/archive.js');
const B = PaperColabBlocks;

async function members(blob) {
  const r = new zip.ZipReader(new zip.BlobReader(blob), {useWebWorkers:false});
  const result = new Map();
  try {
    for (const entry of await r.getEntries()) if (!entry.directory) {
      result.set(entry.filename, Buffer.from(await entry.getData(new zip.Uint8ArrayWriter(), {checkSignature:true})));
    }
  } finally { await r.close(); }
  return result;
}

async function run(input, root, output) {
  if (!input || !root || !output) throw new Error('Usage: node corpus/roundtrip.cjs INPUT.zip ROOT.tex OUTPUT.zip');
  const archive = new Blob([await fs.readFile(input)]);
  const source = (await PaperColabArchive.readArchive(archive)).get(root)?.text;
  assert.equal(typeof source, 'string', 'Root must be readable UTF-8.');
  const original = B.parseFile(source, {root:true});
  const report = B.coverage(original);
  const paragraph = original.blocks.find(b => b.kind === 'paragraph');
  assert.ok(paragraph, 'Expected an editable paragraph.');
  const unchanged = await PaperColabArchive.exportArchive(archive, new Map());
  assert.deepEqual(Buffer.from(await unchanged.arrayBuffer()), Buffer.from(await archive.arrayBuffer()));
  const rich = structuredClone(paragraph.rich);
  rich.content[0].content.push({type:'text',text:' PaperColab round-trip check.'});
  B.editVisual(original, paragraph, rich);
  const result = B.exportText(original);
  const outputZip = await PaperColabArchive.exportArchive(archive, new Map([[root,result]]));
  const before = await members(archive), after = await members(outputZip);
  assert.deepEqual([...after.keys()], [...before.keys()]);
  const offset = Buffer.byteLength(source.slice(0,paragraph.from));
  const end = Buffer.byteLength(source.slice(0,paragraph.to));
  const member = [...before.keys()].find(name => name.replace(/^(?:\.\/)+/, '') === root);
  for (const [name, bytes] of before) {
    const expected = name === member ? Buffer.concat([bytes.subarray(0,offset), Buffer.from(B.current(original,paragraph)), bytes.subarray(end)]) : bytes;
    assert.deepEqual(after.get(name), expected, name);
  }
  const imported = B.parseFile((await PaperColabArchive.readArchive(outputZip)).get(root).text, {root:true});
  assert.ok(imported.blocks.some(b=>b.rich && B.preview(b.rich).includes('PaperColab round-trip check.')));
  const raw = f => f.blocks.filter(b=>b.kind==='raw').map(b=>Buffer.from(B.current(f,b)));
  assert.deepEqual(raw(imported),raw(original));
  await fs.writeFile(output,Buffer.from(await outputZip.arrayBuffer()));
  const commands = report.fallbackCommands.map(item => item.command + ' (' + item.blocks + ')').join(', ');
  console.log(root + ': one paragraph edited, ' + raw(original).length + ' raw blocks preserved, ' +
    (before.size - 1) + ' other files unchanged. Unedited archive is byte-identical.');
  console.log('Coverage before editing: ' + report.editableParagraphs + ' editable paragraphs, ' +
    report.editableHeadings + ' editable headings, ' + report.fallbackParagraphs + ' fallback paragraphs, ' +
    report.fallbackHeadings + ' fallback headings' + (commands ? '; commands ' + commands : '') + '.');
}
run(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
