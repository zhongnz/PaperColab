const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../web/vendor/latex.min.js');
require('../web/blocks.js');
require('../web/identity.js');

const B = PaperColabBlocks;
const I = PaperColabIdentity;
const source = [
  '\\section{Sampling method}',
  'Alpha reads the morning sample.',
  '',
  'Beta reads the afternoon sample.',
  ''
].join('\n');

function listed(text, previous, prefer) {
  const file = B.parseFile(text, { root: false });
  const result = I.catalogue(file, previous, prefer);
  assert.equal(result.ok, true);
  return result;
}

test('block ids survive an edit to a different block and a move', () => {
  const first = listed(source, []);
  const [heading, alpha, beta] = first.blocks;
  assert.equal(first.unresolved.length, 0);
  const edited = I.applyEdit(source, first.blocks, beta.stableId, 'Beta reads the evening sample.', false);
  assert.equal(edited.ok, true);
  assert.equal(edited.blocks.find(block => block.stableId === heading.stableId).quote, heading.quote);
  assert.equal(edited.blocks.find(block => block.stableId === alpha.stableId).quote, alpha.quote);
  assert.match(edited.blocks.find(block => block.stableId === beta.stableId).quote, /evening/);
  const anchor = { blockId: alpha.stableId, quote: alpha.quote };
  assert.equal(I.resolveAnchor(edited.blocks.map(block => ({ ...block, path: 'notes.tex' })), anchor).status, 'exact');
  const destination = edited.text.length;
  const moved = I.moveBlock(edited.text, edited.blocks, alpha.stableId, destination, false);
  assert.equal(moved.ok, true);
  const again = moved.blocks.find(block => block.stableId === alpha.stableId);
  assert.equal(again.quote, alpha.quote);
  assert.ok(again.from > moved.blocks.find(block => block.stableId === beta.stableId).from);
  assert.equal(I.resolveAnchor(moved.blocks, anchor).status, 'exact');
});

test('a split is not applied and an edited block whose text changed is unresolved', () => {
  const first = listed(source, []);
  const alpha = first.blocks.find(block => /morning/.test(block.quote));
  const split = I.applyEdit(source, first.blocks, alpha.stableId, 'Alpha reads.\n\nA second paragraph.', false);
  assert.equal(split.ok, false);
  assert.equal(split.result, 'needs-review');
  assert.deepEqual(split.unresolved, [alpha.stableId]);
  const changed = first.blocks.map(block => block.stableId === alpha.stableId ? { ...block, quote: 'rewritten' } : block);
  const resolved = I.resolveAnchor(changed, { blockId: alpha.stableId, quote: alpha.quote });
  assert.equal(resolved.status, 'unresolved');
});

test('visual and source suggestions are the same kind of block replacement', () => {
  const file = B.parseFile('Alpha reads the morning sample.');
  const block = file.blocks[0];
  const visual = structuredClone(block.rich);
  visual.content[0].content[0].text = 'Ada reads the morning sample.';
  B.editVisual(file, block, visual);
  const after = B.current(file, block);
  const first = listed('Alpha reads the morning sample.', []);
  const applied = I.applyEdit('Alpha reads the morning sample.', first.blocks, first.blocks[0].stableId, after, false);
  assert.equal(applied.ok, true);
  assert.match(applied.text, /^Ada reads/);
  const sourceEdit = I.applyEdit(applied.text, applied.blocks, applied.blocks[0].stableId, 'Bao reads the morning sample.', false);
  assert.equal(sourceEdit.blocks[0].stableId, first.blocks[0].stableId);
  assert.match(sourceEdit.text, /^Bao reads/);
});

test('editing a block to match an earlier paragraph retains both identities', () => {
  const text = 'Same paragraph.\n\nDifferent paragraph.\n';
  const first = listed(text, []);
  const [other, target] = first.blocks;
  const result = I.applyEdit(text, first.blocks, target.stableId, other.quote, false);
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocks.map(block => block.stableId), [other.stableId, target.stableId]);
  assert.equal(result.blocks[1].from, target.from);
});

test('moving a block preserves raw LaTeX bytes and source line endings', () => {
  const text = [
    'Alpha.',
    '',
    '\\begin{verbatim}',
    'Preserve the two empty lines below.',
    '',
    '',
    'Keep this line too.',
    '\\end{verbatim}',
    '',
    'Beta.',
    ''
  ].join('\r\n');
  const first = listed(text, []);
  const [alpha, raw, beta] = first.blocks;
  const result = I.moveBlock(text, first.blocks, alpha.stableId, text.length, false);
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocks.map(block => block.stableId), [raw.stableId, beta.stableId, alpha.stableId]);
  assert.equal(result.blocks[0].quote, raw.quote);
  assert.equal(result.text.replace(/(?:\r\n)/g, '').includes('\n'), false);
  assert.ok(result.text.includes(raw.quote));
});
