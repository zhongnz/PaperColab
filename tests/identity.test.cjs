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

test('hosted catalogue and proposal share the file-local macro context',()=>{
  const source='\\documentclass{article}\n\\newcommand{\\methodname}{Method}\n\\begin{document}\nUse \\methodname{} here.\n\\end{document}';
  const catalog=B.parseFile(source,{root:true});
  const listed=I.catalogue(catalog);
  const cell=listed.blocks.find(b=>b.kind==='paragraph');
  assert.ok(cell?.rich);
  const after='Use \\methodname{} there.';
  const proposal=I.applyEdit(source,listed.blocks,cell.stableId,after,true);
  assert.ok(proposal.ok,proposal.error);
  assert.equal(proposal.text,source.replace(cell.quote,after));
  assert.equal(proposal.blocks.find(b=>b.stableId===cell.stableId).quote,after);
  const {spawnSync}=require('node:child_process');
  const direct=spawnSync(process.execPath,['server/blocks.cjs'],{input:JSON.stringify({
    op:'direct',text:source,root:true,previous:listed.blocks,stableId:cell.stableId,after,mode:'visual'
  }),encoding:'utf8'});
  assert.equal(direct.status,0,direct.stderr);
  const result=JSON.parse(direct.stdout);
  assert.ok(result.ok,result.error);
  assert.equal(result.text,proposal.text);
  assert.equal(result.blocks.find(b=>b.stableId===cell.stableId).quote,after);
});
