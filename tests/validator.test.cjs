const { test } = require('node:test');
const assert = require('node:assert/strict');
globalThis.zip = require('../web/vendor/zip-core.min.js');
require('../web/archive.js');
require('../web/inspect.js');
require('../web/example.js');

const { readArchive } = PaperColabArchive;
const { inventory, inspectRoot } = PaperColabInspect;
const root = body => '\\documentclass{article}\n\\begin{document}\n' + body + '\n\\end{document}\n';
const info = entries => inventory(new Map(Object.entries(entries).map(([path, text]) => [path, { text, size: text.length }])));
async function makeZip(entries, level = 0) {
  const writer = new zip.ZipWriter(new zip.BlobWriter(), { useWebWorkers: false });
  for (const [path, data] of entries) {
    const reader = typeof data === 'string' ? new zip.TextReader(data) : new zip.Uint8ArrayReader(data);
    await writer.add(path, reader, { level });
  }
  return writer.close();
}
const replacements = async (blob, a, b) => {
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(a.length, b.length);
  let start = bytes.indexOf(a);
  while (start >= 0) {
    bytes.write(b, start);
    start = bytes.indexOf(a, start + b.length);
  }
  return new Blob([bytes]);
};

test('embedded example passes entry checks and finds its nested section and bibliography', async () => {
  const data = inventory(await readArchive(new Blob([Buffer.from(PaperColabExample, 'base64')])));
  assert.deepEqual(data.roots, ['estuary/main.tex']);
  assert.deepEqual(data.notes, []);
  const selected = inspectRoot(data, data.roots[0]);
  assert.equal(selected.sources.length, 2);
  assert.equal(selected.references.filter(ref => ref.status === 'found').length, 2);
  assert.equal(selected.references.filter(ref => ref.status === 'toolchain').length, 3);
});

test('deflated archives retain sizes and detect invalid UTF-8 without altering source bytes', async () => {
  const blob = await makeZip([['study.tex', root('Café')], ['other.tex', new Uint8Array([255, 254])]], 6);
  const files = await readArchive(blob);
  assert.equal(files.get('study.tex').text, root('Café'));
  assert.match(files.get('other.tex').skipped, /UTF-8/);
  assert.equal(inventory(files).notes[0].level, 'review');
});

test('projects with identical basenames have independent dependency reports', () => {
  const data = info({ 'a/main.tex': root('\\input{method}'), 'b/main.tex': root('\\input{method}'), 'b/method.tex': 'Only in B' });
  assert.deepEqual(data.roots, ['a/main.tex', 'b/main.tex']);
  assert.equal(inspectRoot(data, 'a/main.tex').references.at(-1).status, 'missing');
  assert.equal(inspectRoot(data, 'b/main.tex').references.at(-1).resolved, 'b/method.tex');
});

test('walks include cycles and resolves graphics paths, local styles and bibliography lists', () => {
  const data = info({
    'x/main.tex': root('\\usepackage{local}\n\\input preamble\n\\include{chap/method}\n\\bibliography{a, b}'),
    'x/local.sty': '\\RequirePackage{booktabs}', 'x/preamble.tex': '\\graphicspath{{figs/}{art/}}',
    'x/chap/method.tex': '\\input{chap/method}\\includegraphics*[width=.7\\linewidth]{plot}',
    'x/art/plot.pdf': '', 'x/a.bib': '', 'x/b.bib': ''
  });
  const paper = inspectRoot(data, 'x/main.tex');
  assert.equal(paper.sources.length, 4);
  assert.equal(paper.references.find(ref => ref.target === 'plot').resolved, 'x/art/plot.pdf');
  assert.deepEqual(paper.references.filter(ref => ref.status === 'missing'), []);
});

test('comments, inline examples and verbatim environments do not create dependencies', () => {
  const data = info({ 'main.tex': root('%\\input{ignore}\n\\verb|\\input{ignore}|\n' +
    '\\begin{lstlisting}\n\\input{ignore}\n\\end{lstlisting}\n20\\% \\input{real}\n' +
    '\\\\input{ignore}'), 'fake.tex': '%\\documentclass{article}\n\\verb|\\begin{document}|' });
  assert.deepEqual(data.roots, ['main.tex']);
  const refs = inspectRoot(data, 'main.tex').references.filter(ref => ref.command === 'input');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].line, 8);
  assert.equal(refs[0].target, 'real');
});

test('computed filenames, prebuilt bibliographies and secondary path candidates need a build', () => {
  const data = info({ 'main.tex': root('\\input{sub/part}\n\\bibliography{gone}\n\\includegraphics{\\figdir/p}'),
    'main.bbl': '', 'sub/part.tex': '\\input{near}', 'sub/near.tex': 'near' });
  const review = inspectRoot(data, 'main.tex').references.filter(ref => ref.status === 'review');
  assert.equal(review.length, 3);
  assert.equal(review.find(ref => ref.target === 'near').resolved, 'sub/near.tex');
});

test('missing root, nested ZIP and unreadable JSON all yield explicit findings', () => {
  const data = info({ 'nested.zip': '', 'plain.tex': 'a fragment', 'project.json': 'bad JSON' });
  assert.equal(data.roots.length, 0);
  assert.equal(data.notes.length, 3);
});

test('export errors retain counts and known metadata keys without copying private text', () => {
  const data = info({ 'main.tex': root('body'), 'export-errors.json': '{"errors":[{"message":"private"}]}',
    'project.json': '{"title":"private"}', 'conversations/a.json': '[{"body":"private"}]' });
  assert.equal(data.conversations, 1);
  assert.equal(data.notes[0].level, 'missing');
  assert.equal(data.metadata.length, 2);
  assert.ok(!JSON.stringify([data.notes, data.metadata]).includes('private'));
  for (const log of ['{}', 'true', '{"message":"failure"}']) {
    assert.equal(info({'main.tex':root('x'), 'export-errors.json':log}).notes[0].level, 'review');
  }
});

test('damaged stored assets fail integrity checks even when no source references them', async () => {
  const archive = await makeZip([['img.png', 'asset-one']]);
  await assert.rejects(readArchive(await replacements(archive, 'asset-one', 'asset-two')), /img\.png/);
});

test('rejects ambiguous and unsafe entry names before accepting the archive', async () => {
  const archive = await makeZip([['ab/a.tex', 'a'], ['ab/b.tex', 'b']]);
  await assert.rejects(readArchive(await replacements(archive, 'ab/b.tex', 'ab/a.tex')), /Conflicting/);
  await assert.rejects(readArchive(await replacements(archive, 'ab/a.tex', '../a.tex')), /path|filename/i);
  await assert.rejects(readArchive(new Blob(['not a ZIP'])));
  await assert.rejects(readArchive(new Blob([])), /empty/);
  await assert.rejects(readArchive({ size: 65 * 1024 * 1024 }), /64 MiB/);
});

test('accepts leading current-directory components and rejects aliases of the same file', async () => {
  const dotted = await makeZip([['./main.tex', root('ok')]]);
  assert.deepEqual(inventory(await readArchive(dotted)).roots, ['main.tex']);
  const alias = await makeZip([['./main.tex', root('one')], ['main.tex', root('two')]]);
  await assert.rejects(readArchive(alias), /Conflicting/);
});
