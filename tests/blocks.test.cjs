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
  assert.throws(() => B.editVisual(f, p, removed), /protected LaTeX tokens/);
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

test('visual edits preserve complete citations, footnotes and literal URLs', () => {
  const citation = tex`\citep*[see, \emph{for example}][p.~3]{mcmc,` + '\r\n' + 'chain}';
  const alias = tex`\citet[][hereafter \citetalias{paper}]{paper}`;
  const url = tex`\url{https://example.invalid/path_(item)?a=2&b=3#results}`;
  const footnote = tex`\footnote[ 12 ]{At ` + url + tex` compare $x^2$ and \textit{the previous note}.}`;
  const source = `See ${citation} and ${alias}${footnote}. More at ${url}.`;
  const file = B.parseFile(source);
  assert.deepEqual(file.blocks.map(block => block.kind), ['paragraph']);
  const [paragraph] = file.blocks;
  assert.deepEqual(B.tokens(paragraph.rich), [citation, alias, footnote, url]);
  const edited = append(paragraph.rich, ' Revised.');
  B.editVisual(file, paragraph, edited);
  assert.equal(B.exportText(file), source + ' Revised.');
  const reimported = B.parseFile(B.exportText(file));
  assert.deepEqual(B.tokens(reimported.blocks[0].rich), [citation, alias, footnote, url]);
  const changedToken = clone(edited);
  changedToken.content[0].content.find(node => node.type === 'texToken').attrs.latex = tex`\cite{other}`;
  assert.throws(() => B.editVisual(file, paragraph, changedToken), /protected LaTeX tokens/);
  B.editSource(file, paragraph, `See ${footnote.replace('At ', 'From ')} now.`);
  assert.deepEqual(B.tokens(B.rich(file, paragraph)), [footnote.replace('At ', 'From ')]);
});

test('updates run-in headings and noindent prose while preserving structural prefixes', () => {
  const source = tex`\paragraph* {Run-in heading}` + '\r\n\r\n' + tex`\noindent` + '\r\n  Body text.' + '\r\n';
  const file = B.parseFile(source);
  assert.deepEqual(file.blocks.map(block => block.kind), ['heading', 'paragraph']);
  const [heading, paragraph] = file.blocks;
  assert.equal(B.preview(paragraph.rich), 'Body text.');
  B.editVisual(file, heading, append(heading.rich, ' revised'));
  B.editVisual(file, paragraph, append(paragraph.rich, ' Revised.'));
  assert.equal(B.exportText(file), source.replace('heading}', 'heading revised}').replace('text.', 'text. Revised.'));
  B.editSource(file, paragraph, tex`\noindent` + '\n  New body text.');
  assert.equal(B.current(file, paragraph), tex`\noindent` + '\r\n  New body text.');
  assert.throws(() => B.editSource(file, paragraph, 'Remove the layout command.'), /one supported paragraph/);
  assert.throws(() => B.editSource(file, heading, tex`\section{Other heading}`), /one supported heading/);
});

test('isolates balanced top-level TeX groups and skipped conditionals byte for byte', () => {
  const conditional = [tex`\iffalse`, tex`  \begin{figure} Some hidden TeX \end{figure}`,
    tex`\iffalse`, tex`Nested \unknown{  code }.`, tex`\fi`, tex`\fi`].join('\r\n');
  const group = [tex`\begingroup`, tex`\allowdisplaybreaks   `,
    tex`\begin{align}x &= 2\end{align}`, tex`\endgroup`].join('\r\n');
  const sentence = tex`Another sentence, see \cref{fig:result}.`;
  const source = ['First text.', '', conditional, '', sentence, group, '', 'Last text.'].join('\r\n');
  const file = B.parseFile(source);
  assert.deepEqual(file.blocks.map(block => block.kind), ['paragraph', 'raw', 'paragraph', 'raw', 'paragraph']);
  const raw = parsed => parsed.blocks.filter(block => !block.rich).map(block => B.current(parsed, block));
  assert.deepEqual(raw(file), [conditional, group]);
  B.editVisual(file, file.blocks[2], append(file.blocks[2].rich, ' More prose.'));
  const exported = B.exportText(file);
  assert.equal(exported, source.replace(sentence, sentence + ' More prose.'));
  assert.deepEqual(raw(B.parseFile(exported)), [conditional, group]);
});

test('retains whole files when a control region crosses an uncertain boundary', () => {
  const regions = [
    [tex`\iffalse`, 'Never closed.'],
    [tex`\iffalse`, tex`\begin{figure}\fi\end{figure}`, tex`\fi`, '', 'Trailing prose.'],
    [tex`\iffalse`, tex`\else`, 'Enabled branch.', tex`\fi`, '', 'Trailing prose.'],
    [tex`\custom`, tex`\begingroup`, 'Unknown argument.', tex`\endgroup`, '', 'Trailing prose.'],
    [tex`\custom{one}`, tex`\begingroup`, 'Another unknown argument.', tex`\endgroup`, '', 'Trailing prose.'],
    [tex`\begingroup`, 'The next line continues.', tex`\endgroup`, 'Adjacent prose.']
  ];
  for (const region of regions) {
    const source = ['First text.', '', ...region].join('\n');
    const file = B.parseFile(source);
    assert.deepEqual(file.blocks.map(block => block.kind), ['raw']);
    assert.equal(B.exportText(file), source);
    assert.equal(B.current(file, file.blocks[0]), source);
  }
});

test('preserves uncertain grammar, unsupported constructs and over-limit UTF-8 as raw source', () => {
  const cases = [tex`\iftrue x\fi`, tex`\catcode`, 'orphan {', tex`\custom{keep}`,
    tex`\begin{align}x &= 2\end{align}`, '界'.repeat(180000),
    tex`A note\footnote{\custom{detail}} stays here.`, tex`A note\footnote[\1]{detail} stays here.`,
    tex`See \citep[\custom{note}]{key}.`, tex`See \citep[unfinished{key}.`,
    tex`A \url{https://example.invalid/\unknown} stays here.`, tex`A \noindent command in mid-paragraph.`,
    tex`\newcommand{\headline}[1]` + '\n' + tex`\paragraph{A macro argument}`];
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
    tex`A note\footnote{\custom{detail}} stays here.`, '',
    tex`See \citep[\unknown{note}]{key}.`, '',
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
  assert.equal(commands.citep, 1);
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
