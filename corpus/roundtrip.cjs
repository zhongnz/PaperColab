// Exercise a copy of a published source, compare original bytes, and emit a ZIP for the independent TeX build.
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
globalThis.zip = require('../web/vendor/zip-core.min.js');
require('../web/vendor/latex.min.js');
require('../web/blocks.js');
require('../web/archive.js');
require('../web/inspect.js');
const B = PaperColabBlocks;
const marker = 'PaperColab round-trip check.';

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

async function run(input, root, output, format) {
  if (!input || !root || !output || (format !== undefined && format !== '--json')) {
    throw new Error('Usage: node corpus/roundtrip.cjs INPUT.zip ROOT.tex OUTPUT.zip [--json]');
  }
  const archive = new Blob([await fs.readFile(input)]);
  const data = PaperColabInspect.inventory(await PaperColabArchive.readArchive(archive));
  assert.ok(data.roots.includes(root), 'The selected manuscript root was not found.');
  const { sources } = PaperColabInspect.inspectRoot(data, root);
  let editedPath, original, paragraph;
  for (const name of new Set([root, ...sources])) {
    const text = data.files.get(name)?.text;
    if (typeof text !== 'string' || !/\.(?:tex|ltx)$/i.test(name)) continue;
    const file = B.parseFile(text, {root:name === root});
    const block = file.blocks.find(item => item.kind === 'paragraph');
    if (!block) continue;
    editedPath = name;
    original = file;
    paragraph = block;
    break;
  }
  assert.ok(paragraph, 'The selected manuscript has no visually editable paragraph.');
  const source = original.original;
  const report = B.coverage(original);
  const unchanged = await PaperColabArchive.exportArchive(archive, new Map());
  const inputBytes = Buffer.from(await archive.arrayBuffer());
  assert.deepEqual(Buffer.from(await unchanged.arrayBuffer()), inputBytes);
  const rich = structuredClone(paragraph.rich);
  rich.content[0].content.push({type:'text',text:' ' + marker});
  B.editVisual(original, paragraph, rich);
  const result = B.exportText(original);
  const outputZip = await PaperColabArchive.exportArchive(archive, new Map([[editedPath,result]]));
  const before = await members(archive), after = await members(outputZip);
  assert.deepEqual([...after.keys()], [...before.keys()]);
  const offset = Buffer.byteLength(source.slice(0,paragraph.from));
  const end = Buffer.byteLength(source.slice(0,paragraph.to));
  const member = [...before.keys()].find(name => name.replace(/^(?:\.\/)+/, '') === editedPath);
  assert.ok(member, 'The edited source was missing from the ZIP.');
  for (const [name, bytes] of before) {
    const expected = name === member ? Buffer.concat([bytes.subarray(0,offset), Buffer.from(B.current(original,paragraph)), bytes.subarray(end)]) : bytes;
    assert.deepEqual(after.get(name), expected, name);
  }
  const imported = B.parseFile((await PaperColabArchive.readArchive(outputZip)).get(editedPath).text, {root:editedPath === root});
  assert.ok(imported.blocks.some(b=>b.rich && B.preview(b.rich).includes(marker)));
  const raw = f => f.blocks.filter(b=>b.kind==='raw').map(b=>Buffer.from(B.current(f,b)));
  assert.deepEqual(raw(imported),raw(original));
  const outputBytes = Buffer.from(await outputZip.arrayBuffer());
  await fs.writeFile(output, outputBytes);
  if (format === '--json') {
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    console.log(JSON.stringify({root, editedPath, startByte:offset, endByte:end, rawBlocksPreserved:raw(original).length,
      unchangedMembers:before.size - 1, inputArchiveSha256:digest(inputBytes), editedArchiveSha256:digest(outputBytes), marker}));
    return;
  }
  const commands = report.fallbackCommands.map(item => item.command + ' (' + item.blocks + ')').join(', ');
  console.log(editedPath + ': one paragraph edited, ' + raw(original).length + ' raw blocks preserved, ' +
    (before.size - 1) + ' other files unchanged. Unedited archive is byte-identical.');
  console.log('Coverage before editing: ' + report.editableParagraphs + ' editable paragraphs, ' +
    report.editableHeadings + ' editable headings, ' + report.fallbackParagraphs + ' fallback paragraphs, ' +
    report.fallbackHeadings + ' fallback headings' + (commands ? '; commands ' + commands : '') + '.');
}
run(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
