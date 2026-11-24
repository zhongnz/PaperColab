const { test } = require('node:test');
const assert = require('node:assert/strict');
globalThis.zip = require('../web/vendor/zip-core.min.js');
require('../web/vendor/latex.min.js');
require('../web/blocks.js');
require('../web/archive.js');
const B = PaperColabBlocks;
const A = PaperColabArchive;
const tex = String.raw;
const original = '\uFEFF' + [
  tex`\documentclass{article}`, tex`% Original: é 🐋`, tex`\newcommand{\station}{A1}`,
  tex`\begin{document}`, tex`\section*{Field notes}`, '',
  tex`Paired readings at Café are \textbf{independent},`, tex`with $v_0$ and protocol~\cite{field}.`, '',
  tex`% Comment with spaces  `, tex`\station{} on Tuesday.`, '',
  tex`\begin{tikzpicture}`, tex`  \draw (0,0) -- (1,1); % inline`, tex`\end{tikzpicture}`, '',
  tex`\begin{verbatim}`, tex` \unknown{  exact } $x$  `, tex`\end{verbatim}`, tex`\end{document}`, ''
].join('\r\n');
const clone = rich => structuredClone(rich);
const append = (rich, text) => {
  const value = clone(rich);
  value.content[0].content.push({ type: 'text', text });
  return value;
};

test('PEG ranges patch one supported block in a CRLF, BOM and Unicode manuscript', () => {
  const f = B.parseFile(original, { root: true });
  assert.equal(B.exportText(f), original);
  const prose = f.blocks.find(b => b.kind === 'paragraph');
  const heading = f.blocks.find(b => b.kind === 'heading');
  assert.equal(B.current(f, heading), tex`\section*{Field notes}`);
  assert.match(B.current(f, prose), /^Paired readings/);
  assert.deepEqual(B.tokens(prose.rich), ['$v_0$', tex`\cite{field}`]);
  assert.ok(f.blocks.filter(b => b.kind === 'raw').length >= 4);
  B.editVisual(f, prose, append(prose.rich, ' Extra.'));
  const expected = original.slice(0, prose.from) + B.current(f, prose) + original.slice(prose.to);
  assert.deepEqual(Buffer.from(B.exportText(f)), Buffer.from(expected));
  assert.ok(B.current(f, prose).endsWith(' Extra.'));
  const f2 = B.parseFile(B.exportText(f), { root: true });
  const raw = file => file.blocks.filter(b => b.kind === 'raw').map(b => Buffer.from(B.current(file, b)));
  assert.deepEqual(raw(f2), raw(f));
  B.editVisual(f, prose, clone(prose.rich));
  assert.equal(f.edits.size, 0);
  assert.equal(B.exportText(f), original);
});

test('headings and paragraphs patch independent original ranges in either edit order', () => {
  const f = B.parseFile(original, { root: true });
  const [h, p] = f.blocks.filter(b => b.rich);
  B.editSource(f, p, 'A shorter paragraph.');
  B.editSource(f, h, tex`\section*{Revised heading}`);
  assert.equal(B.exportText(f), original.slice(0,h.from) + tex`\section*{Revised heading}` +
    original.slice(h.to,p.from) + 'A shorter paragraph.' + original.slice(p.to));
});

test('formatting, typed TeX punctuation and nonbreaking space survive re-import', () => {
  const f = B.parseFile('Original.'), p = f.blocks[0];
  const plain = 'A # $ % & _ { } \\ ~ ^\u00a0';
  const rich = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: plain }, { type: 'text', text: 'marked', marks: [{ type: 'bold' }, { type: 'italic' }] }
  ] }] };
  B.editVisual(f, p, rich);
  assert.ok(B.current(f, p).endsWith(tex`\textbf{\emph{marked}}`));
  const imported = B.parseFile(B.exportText(f));
  assert.deepEqual(imported.blocks[0].rich, rich);
});

test('source and visual modes protect citation and math tokens until explicitly edited in source', () => {
  const t = tex`Measured $x$ following \cite{a}.`;
  const f = B.parseFile(t), p = f.blocks[0], removed = clone(p.rich);
  removed.content[0].content = removed.content[0].content.filter(n => n.type !== 'texToken');
  assert.throws(() => B.editVisual(f, p, removed), /citation and math/);
  assert.equal(B.current(f, p), t);
  B.editSource(f, p, tex`See \cite{b} and $y$.`);
  assert.deepEqual(B.tokens(B.rich(f, p)), [tex`\cite{b}`, '$y$']);
  for (const draft of ['one\n\ntwo', tex`\undefined{z}`, tex`\section{X}`, 'unclosed {']) {
    assert.throws(() => B.editSource(f, p, draft), /one supported/);
    assert.equal(B.current(f, p), tex`See \cite{b} and $y$.`);
  }
  B.editSource(f, p, t);
  assert.equal(f.edits.size, 0);
});

test('preserves uncertain grammar, unsupported constructs and over-limit UTF-8 as raw source', () => {
  const cases = [tex`\iftrue x\fi`, tex`\catcode`, 'orphan {', tex`\custom{keep}`,
    tex`\begin{align}x &= 2\end{align}`, '界'.repeat(180000)];
  for (const s of cases) {
    const f = B.parseFile(s);
    assert.ok(f.blocks.length && f.blocks.every(b => b.kind === 'raw'));
    assert.equal(B.exportText(f), s);
    assert.throws(() => B.editSource(f, f.blocks[0], 'different'), /preserved/);
  }
});

test('an untouched ZIP is byte-identical and a changed ZIP preserves paths, siblings and compressed assets', async () => {
  const writer = new zip.ZipWriter(new zip.BlobWriter(), { useWebWorkers: false });
  const path = './group/a/main.tex', asset = Uint8Array.from([0,255,128,1,2,13,10,7]);
  await writer.add('./group/', undefined, { directory: true });
  for (const [name, bytes] of [[path,Buffer.from(original)],['group/b/main.tex',Buffer.from('Independent.')],
    ['group/a/image.png',asset],['group/b/latin1.tex',Uint8Array.from([0xf6,0xff])]]) {
    await writer.add(name, new zip.Uint8ArrayReader(bytes), { level: 6, comment: 'field project' });
  }
  const blob = await writer.close(Uint8Array.from([65,66]));
  const files = await A.readArchive(blob);
  assert.equal(files.get('group/a/main.tex').text, original);
  assert.ok(files.get('group/b/latin1.tex').skipped);
  assert.strictEqual(await A.exportArchive(blob, new Map()), blob);
  const f = B.parseFile(original, { root: true }), p = f.blocks.find(b => b.kind === 'paragraph');
  B.editVisual(f, p, append(p.rich, ' Revised.'));
  const after = await A.exportArchive(blob, new Map([['group/a/main.tex',B.exportText(f)]]));
  assert.equal((await A.readArchive(after)).get('group/a/main.tex').text, B.exportText(f));
  async function entries(archive) {
    const r = new zip.ZipReader(new zip.BlobReader(archive), { useWebWorkers: false });
    try {
      const value = [];
      for (const e of await r.getEntries()) value.push({ name:e.filename, directory:e.directory, comment:e.comment,
        bytes:e.directory ? null : Buffer.from(await e.getData(new zip.Uint8ArrayWriter(), {checkSignature:true})),
        compressed:e.directory ? null : Buffer.from(await e.getData(new zip.Uint8ArrayWriter(), {passThrough:true})) });
      return { value, comment: Array.from(r.comment) };
    } finally { await r.close(); }
  }
  const a = await entries(blob), b = await entries(after);
  assert.deepEqual(a.comment,b.comment);
  assert.deepEqual(a.value.map(e=>e.name),b.value.map(e=>e.name));
  for (let i=0;i<a.value.length;i++) {
    if (a.value[i].name === path) assert.deepEqual(b.value[i].bytes, Buffer.from(B.exportText(f)));
    else assert.deepEqual(b.value[i],a.value[i]);
  }
});

test('coverage counts editable blocks and names the command that preserved a paragraph', () => {
  const source = [
    '\\section{Methods}', '', 'Supported prose.', '',
    'A note\\footnote{detail} stays here.', '',
    'See \\cite[p.~3]{key}.', '',
    '\\begin{tabular}{c}', 'a', '\\end{tabular}'
  ].join('\n');
  const file = B.parseFile(source);
  assert.equal(B.exportText(file), source);
  const report = B.coverage(file);
  assert.equal(report.editableHeadings, 1);
  assert.equal(report.editableParagraphs, 1);
  assert.equal(report.fallbackParagraphs, 2);
  assert.equal(report.editableBlocks, 2);
  const commands = Object.fromEntries(report.fallbackCommands.map(item => [item.command, item.blocks]));
  assert.equal(commands.footnote, 1);
  assert.equal(commands.cite, 1);
});

test('editing prose preserves multiline math tokens, textit semantics and raw macro definitions', () => {
  const s = tex`\newcommand\section{word}` + '\r\n\r\n' + tex`A \textit{word} with $a` + '\r\n' + tex`+ b$.`;
  const f = B.parseFile(s);
  assert.deepEqual(f.blocks.map(b=>b.kind), ['raw','paragraph']);
  const p = f.blocks[1];
  B.editVisual(f, p, append(p.rich, ' Done.'));
  assert.equal(B.exportText(f), s + ' Done.');
  for (const contents of [tex`\emph{one \emph{two}}`,tex`A \verb|\section{literal}| here.`]) {
    assert.deepEqual(B.parseFile(contents).blocks.map(b=>b.kind), ['raw']);
  }
});

test('structural transactions preserve unrelated bytes, IDs and protected tokens', () => {
  const text = 'First café $x$.\r\n\r\nSecond paragraph.\r\n\r\n\\begin{tabular}{c}x\\end{tabular}\r\n';
  const original = B.parseFile(text);
  const [a,b,raw] = original.blocks;
  assert.equal(a.kind,'paragraph'); assert.equal(b.kind,'paragraph'); assert.equal(raw.kind,'raw');
  const run = (f,id,action,options) => B.structural(f,id,action,options);
  let r = run(original,a.id,'insert',{kind:'paragraph'});
  const added = r.selectedId;
  assert.notEqual(added,b.id);
  assert.equal(B.exportText(original),text);
  assert.equal(B.current(r.file,r.file.blocks.find(x=>x.id===raw.id)),B.current(original,raw));
  assert.equal(B.current(r.file,r.file.blocks.find(x=>x.id===b.id)),'Second paragraph.');
  r = run(r.file,added,'move-down');
  assert.deepEqual(r.file.blocks.map(x=>x.id),[a.id,b.id,added,raw.id]);
  r = run(r.file,added,'convert');
  assert.equal(r.file.blocks.find(x=>x.id===added).kind,'heading');
  r = run(r.file,added,'convert');
  r = run(r.file,added,'delete');
  assert.deepEqual(r.file.blocks.map(x=>x.id),[a.id,b.id,raw.id]);
  r = run(r.file,a.id,'split',{offset:6});
  const split = r.selectedId;
  assert.notEqual(split,added);
  assert.deepEqual(B.tokens(r.file.blocks.find(x=>x.id===split).rich),['$x$']);
  r = run(r.file,a.id,'merge-next');
  assert.deepEqual(B.tokens(r.file.blocks.find(x=>x.id===a.id).rich),['$x$']);
  assert.equal(B.current(r.file,r.file.blocks.find(x=>x.id===raw.id)),B.current(original,raw));
  assert.throws(()=>run(r.file,b.id,'move-down'),/boundary/);
  assert.throws(()=>run(r.file,raw.id,'delete'),/preserved/i);
  assert.equal(B.exportText(original),text);
});
test('structural editing includes prior edits and keeps mixed line endings outside the patch', () => {
  const text = 'First.\r\n\r\nSecond.\n\nThird.\r\n';
  const f = B.parseFile(text);
  const [a,b,c] = f.blocks;
  B.editSource(f,c,'Third revised.');
  const r = B.structural(f,b.id,'insert',{kind:'heading'});
  assert.equal(B.exportText(r.file), 'First.\r\n\r\nSecond.\r\n\r\n\\section{New section}\r\n\r\n\n\nThird revised.\r\n');
  assert.equal(r.file.blocks.find(x=>x.id===c.id).kind,'paragraph');
  assert.equal(B.current(r.file,r.file.blocks.find(x=>x.id===c.id)),'Third revised.');
});
test('structural split refuses invalid caret and never mutates input', () => {
  const f = B.parseFile('A 🐋 and $x$.');
  const p = f.blocks[0];
  assert.throws(()=>B.structural(f,p.id,'split',{offset:3}),/Unicode/);
  assert.throws(()=>B.structural(f,p.id,'split',{offset:0}),/caret/);
  assert.equal(B.exportText(f),f.original);
});

test('scientific adapters patch exact fields and preserve other source',()=>{
  const table='\\begin{tabular}{lr}\r\n\\toprule\r\nName & 12 \\\\\r\n\\bottomrule\r\n\\end{tabular}';
  const model=B.scientific(table);
  assert.equal(model.type,'table');
  assert.deepEqual(model.fields.map(f=>f.value),['Name','12']);
  const edited=B.scientificEdit(table,['Name','34']);
  assert.equal(edited,table.replace('12','34'));
  assert.throws(()=>B.scientificEdit(table,['Name','x & y']),/Invalid/);
  assert.equal(B.scientific(table.replace('Name','\\multicolumn{1}{l}{Name}')),null);
  const equation='\\begin{equation}\n\\frac{x}{2}\n\\end{equation}';
  assert.equal(B.scientific(equation).type,'equation');
  assert.equal(B.scientificEdit(equation,['\n\\frac{y}{2}\n']),equation.replace('x','y'));
  assert.throws(()=>B.scientificEdit(equation,['\\input{private}']),/Invalid/);
  const figure='\\begin{figure}[ht]\n\\centering\n\\includegraphics{figures/a.png}\n\\caption{Old caption}\\label{fig:a}\n\\end{figure}';
  assert.equal(B.scientific(figure).type,'figure');
  assert.equal(B.scientificEdit(figure,['figures/a.png','New caption']),figure.replace('Old caption','New caption'));
  assert.throws(()=>B.scientificEdit(figure,['../secret','Caption']),/Invalid/);
  const list='\\begin{enumerate}\n\\item First\n\\item Second\n\\end{enumerate}';
  assert.equal(B.scientificEdit(list,['First','Third']),list.replace('Second','Third'));
  const source='Before.\n\n'+table+'\n\nAfter.';
  const file=B.parseFile(source), [a,t,z]=file.blocks;
  const result=B.structural(file,t.id,'scientific',{values:['Name','34']});
  assert.equal(B.exportText(result.file),source.replace('12','34'));
  assert.deepEqual(result.file.blocks.map(b=>b.id),[a.id,t.id,z.id]);
  assert.equal(B.exportText(file),source);
  const inserted=B.structural(file,a.id,'insert',{kind:'equation'});
  assert.equal(B.scientific(B.current(inserted.file,inserted.file.blocks.find(b=>b.id===inserted.selectedId))).type,'equation');
});
test('citation keys and explicit citation insertion retain existing tokens',()=>{
  assert.deepEqual(B.bibliographyKeys('@misc{one,\n title={Example}\n}\n@string{abc="X"}\n@article(two, title={Y})'),['one','two']);
  const file=B.parseFile('Existing $x$.'), p=file.blocks[0];
  B.appendCitation(file,p,'one');
  assert.equal(B.exportText(file),'Existing $x$.~\\cite{one}');
  assert.deepEqual(B.tokens(B.rich(file,p)),['$x$','\\cite{one}']);
  assert.throws(()=>B.appendCitation(file,p,'bad}'),/citation/);
});

test('scientific source edits and field edits share validated source checkpoints',()=>{
  const source='Before.\r\n\r\n\\begin{equation}\r\nx = y\r\n\\end{equation}\r\n\r\nAfter.';
  const file=B.parseFile(source), [a,e,z]=file.blocks;
  const result=B.structural(file,e.id,'scientific-source',{source:'\\begin{equation}\r\nx = z\r\n\\end{equation}'});
  assert.equal(B.exportText(result.file),source.replace('x = y','x = z'));
  assert.deepEqual(result.file.blocks.map(b=>b.id),[a.id,e.id,z.id]);
  assert.equal(B.scientific(B.current(result.file,result.file.blocks[1])).fields[0].value,'\r\nx = z\r\n');
  assert.throws(()=>B.structural(file,e.id,'scientific-source',{source:'\\begin{equation}x\\end{equation}\n\nExtra.'}),/Keep one supported/);
  assert.equal(B.exportText(file),source);
});
test('archive reader retains local bibliography text without modifying ZIP',async()=>{
  const writer=new zip.ZipWriter(new zip.BlobWriter(),{useWebWorkers:false});
  const bib='@article{local,\n title={Local reference}\n}';
  await writer.add('references.bib',new zip.TextReader(bib));
  const blob=await writer.close(), files=await A.readArchive(blob);
  assert.equal(files.get('references.bib').text,bib);
  assert.deepEqual(B.bibliographyKeys(files.get('references.bib').text),['local']);
  assert.strictEqual(await A.exportArchive(blob,new Map()),blob);
});

test('local raster preview resolves only explicit archive assets and reads bounded bytes',async()=>{
  const writer=new zip.ZipWriter(new zip.BlobWriter(),{useWebWorkers:false});
  const bytes=Uint8Array.from([137,80,78,71,13,10,26,10]);
  await writer.add('project/figures/a.png',new zip.Uint8ArrayReader(bytes));
  await writer.add('project/figures/a.svg',new zip.TextReader('<svg/>'));
  const blob=await writer.close(), files=await A.readArchive(blob);
  assert.deepEqual(A.rasterCandidates(files,'project/main.tex','project/sections/methods.tex','figures/a'),['project/figures/a.png']);
  assert.deepEqual(A.rasterCandidates(files,'project/main.tex','project/sections/methods.tex','../figures/a'),[]);
  assert.deepEqual(A.rasterCandidates(files,'project/main.tex','project/sections/methods.tex','figures/a.svg'),[]);
  const image=await A.readRaster(blob,'project/figures/a.png');
  assert.equal(image.type,'image/png');
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()),bytes);
  await assert.rejects(()=>A.readRaster(blob,'project/figures/a.svg'),/Only PNG/);
  assert.strictEqual(await A.exportArchive(blob,new Map()),blob);
});
