/* global PaperColabLatex */
(() => {
  'use strict';
  const headingNames = new Set(['section', 'subsection', 'subsubsection']);
  const standalone = new Set(['maketitle', 'tableofcontents', 'appendix', 'clearpage', 'newpage', 'frontmatter', 'mainmatter', 'backmatter']);
  const inlineRefs = new Set(['cite', 'citep', 'citet', 'ref', 'eqref', 'pageref']);
  const marks = { textbf: 'bold', emph: 'italic', textit: 'italic' };
  const escaped = { '\\': '\\textbackslash{}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}', '\u00a0': '~' };
  for (const ch of '#$%&_{}') escaped[ch] = '\\' + ch;
  const namedEscapes = { textbackslash: '\\', textasciitilde: '~', textasciicircum: '^' };
  const markup = { bold: 'textbf', italic: 'emph' };
  const encode = text => text.replace(/[\\~^#$%&_{}\u00a0]/gu, ch => escaped[ch]);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const doc = content => ({ type: 'doc', content: [{ type: 'paragraph', ...(content.length ? { content } : {}) }] });

  // PEG offsets are UTF-16 offsets. Parse physical line endings as one newline, then
  // map every accepted range back into the original string (including a UTF-8 BOM).
  function coordinates(original) {
    const bom = original.startsWith('\uFEFF') ? 1 : 0;
    const source = original.slice(bom);
    if (!source.includes('\r')) return { text: source, at: i => bom + i };
    const deletedAt = [];
    const text = source.replace(/\r\n?/g, (match, offset) => {
      if (match.length === 2) deletedAt.push(offset - deletedAt.length);
      return '\n';
    });
    return { text, at(i) {
      let lo = 0, hi = deletedAt.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (deletedAt[mid] < i) lo = mid + 1; else hi = mid;
      }
      return bom + i + lo;
    } };
  }

  function asRich(nodes, slice, depth = 0, failures = null) {
    const fail = command => {
      if (failures && command) failures.push(command);
      return null;
    };
    if (depth > 12) return fail('nesting');
    const result = [];
    function append(item) {
      const previous = result.at(-1);
      if (item.type === 'text' && previous?.type === 'text' && same(item.marks, previous.marks)) previous.text += item.text;
      else result.push(item);
    }
    const raw = n => slice(n.position.start.offset, n.position.end.offset);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i], next = nodes[i + 1];
      if (node.type === 'whitespace') { append({ type: 'text', text: ' ' }); continue; }
      if (node.type === 'string') {
        const text = raw(node);
        if (/[\\{}$%&#_^\x00-\x1f]/.test(text)) return fail('special character');
        if (text) append({ type: 'text', text: text.replace(/~/g, '\u00a0') });
        continue;
      }
      if (node.type === 'inlinemath') {
        append({ type: 'texToken', attrs: { latex: raw(node) } });
        continue;
      }
      if (node.type !== 'macro') return fail(node.type);
      const name = node.content;
      if (name.length === 1 && '#$%&_{}'.includes(name) && raw(node) === '\\' + name) {
        append({ type: 'text', text: name }); continue;
      }
      if (next?.type !== 'group' || node.position.end.offset !== next.position.start.offset) return fail(name);
      if (Object.hasOwn(namedEscapes, name) && !next.content.length) {
        append({ type: 'text', text: namedEscapes[name] });
      } else if (Object.hasOwn(marks, name)) {
        const children = asRich(next.content, slice, depth + 1, failures);
        if (!children?.length) return failures?.length ? null : fail(name);
        for (const child of children) {
          const existing = child.marks ?? [];
          if (existing.some(mark => mark.type === marks[name])) return fail(name);
          const mark = name === 'textit' ? { type: 'italic', attrs: { command: 'textit' } } : { type: marks[name] };
          child.marks = [...existing, mark].sort((a, b) => a.type.localeCompare(b.type));
          append(child);
        }
      } else if (inlineRefs.has(name) && /^\{[A-Za-z0-9_.:/,+\s-]+\}$/.test(raw(next))) {
        append({ type: 'texToken', attrs: { latex: slice(node.position.start.offset, next.position.end.offset) } });
      } else return fail(name);
      i++;
    }
    return result;
  }

  function serialize(rich) {
    const children = rich?.content?.[0]?.content ?? [];
    let text = '', open = [];
    for (const child of children) {
      const next = [...(child.marks ?? [])].sort((a, b) => a.type.localeCompare(b.type)).map(mark => {
        if (!Object.hasOwn(markup, mark.type)) throw new Error('Unsupported formatting.');
        return mark.type === 'italic' && mark.attrs?.command === 'textit' ? 'textit' : markup[mark.type];
      });
      let shared = 0;
      while (shared < open.length && shared < next.length && open[shared] === next[shared]) shared++;
      text += '}'.repeat(open.length - shared);
      for (const m of next.slice(shared)) text += '\\' + m + '{';
      open = next;
      if (child.type === 'text') text += encode(child.text);
      else if (child.type === 'texToken') text += child.attrs.latex;
      else throw new Error('Unsupported inline content.');
    }
    return text + '}'.repeat(open.length);
  }

  const tokens = rich => (rich.content[0].content ?? []).filter(n => n.type === 'texToken').map(n => n.attrs.latex);
  const preview = rich => (rich.content[0].content ?? []).map(n => n.text ?? n.attrs.latex).join('');
  const ambiguous = n => (n.type === 'string' && /[{}$]/.test(n.content)) ||
    (n.type === 'macro' && /^(?:begin|end|if.*|else|fi|or|begingroup|endgroup|bgroup|egroup)$/.test(n.content));
  const isSpace = node => node.type === 'whitespace' || node.type === 'parbreak';

  function parseFile(original, { root = false } = {}) {
    const blocks = [];
    function add(kind, from, to, info = {}) {
      if (from >= to || !original.slice(from, to).trim()) return;
      blocks.push({ id: blocks.length + 1, kind, from, to, ...info });
    }
    const rawFile = reason => {
      blocks.length = 0;
      add('raw', 0, original.length, { label: 'Original source', reason });
      return { original, blocks, edits: new Map() };
    };
    if (new TextEncoder().encode(original).length > 512 * 1024) return rawFile('This file exceeds the visual editor’s 512 KiB text limit.');
    const { text, at } = coordinates(original);
    const slice = (from, to) => original.slice(at(from), at(to));
    if (/\\(?:catcode|obeylines|obeyspaces|ExplSyntaxOn)\b/.test(text)) return rawFile('This file changes how TeX reads source characters.');
    let ast;
    try { ast = PaperColabLatex.LatexPegParser.parse(text); }
    catch { return rawFile('The parser could not establish editable source ranges.'); }
    const docs = ast.content.filter(n => n.type === 'environment' && n.env === 'document');
    if (docs.length > 1 || (root && docs.length !== 1)) return rawFile('A single document body could not be identified.');
    const env = docs[0];
    const nodes = env ? env.content : ast.content;
    if (nodes.some(ambiguous)) return rawFile('A conditional or unmatched delimiter makes the block boundaries uncertain.');
    const start = n => at(n.position.start.offset), end = n => at(n.position.end.offset);
    function represent(nodes) {
      const commands = [];
      const rich = asRich(nodes, slice, 0, commands);
      return { rich, commands: [...new Set(commands)] };
    }
    if (env) add('raw', 0, nodes.length ? start(nodes[0]) : end(env), { label: 'Document opening' });
    let run = [];
    function flush() {
      let first = 0, last = run.length;
      while (first < last && isSpace(run[first])) first++;
      while (last > first && isSpace(run[last - 1])) last--;
      const group = run.slice(first, last);
      run = [];
      if (!group.length) return;
      const from = start(group[0]), to = end(group.at(-1));
      const { rich, commands } = represent(group);
      if (rich?.length) add('paragraph', from, to, { rich: doc(rich), prefix: '', suffix: '' });
      else add('raw', from, to, { label: 'LaTeX source', fallback: 'paragraph', commands });
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type === 'parbreak') { flush(); continue; }
      if (n.type === 'environment' || n.type === 'verbatim' || n.type === 'mathenv' || n.type === 'displaymath') {
        flush();
        add('raw', start(n), end(n), { label: typeof n.env === 'string' ? n.env : 'Display LaTeX' });
        continue;
      }
      if (n.type === 'macro' && headingNames.has(n.content)) {
        // TeX also permits a control sequence to be an unbraced argument, e.g. in a definition.
        const previous = run.findLast(item => !isSpace(item) && item.type !== 'comment');
        const offset = n.position.start.offset;
        const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
        if ((previous && !/^[ \t]*$/.test(text.slice(lineStart, offset))) ||
            (previous?.type === 'macro' && !standalone.has(previous.content))) {
          run.push(n);
          continue;
        }
        let j = i + 1;
        if (nodes[j]?.type === 'string' && nodes[j].content === '*') j++;
        if (nodes[j]?.type === 'whitespace') j++;
        const title = nodes[j];
        if (title?.type === 'group') {
          flush();
          const { rich, commands } = represent(title.content);
          if (rich) add('heading', start(n), end(title), { rich: doc(rich),
            prefix: original.slice(start(n), start(title) + 1), suffix: '}', label: n.content });
          else add('raw', start(n), end(title), { label: 'LaTeX heading', fallback: 'heading', commands });
          i = j;
          continue;
        }
      }
      run.push(n);
    }
    flush();
    if (env && nodes.length) add('raw', end(nodes.at(-1)), original.length, { label: 'Document closing' });
    return { original, blocks, edits: new Map() };
  }

  function originalBlock(file, block) { return file.original.slice(block.from, block.to); }
  function current(file, block) { return file.edits.get(block.id)?.source ?? originalBlock(file, block); }
  function rich(file, block) { return file.edits.get(block.id)?.rich ?? block.rich; }
  function set(file, block, source, content) {
    if (source === originalBlock(file, block)) file.edits.delete(block.id);
    else file.edits.set(block.id, { source, rich: content });
  }

  function editVisual(file, block, content) {
    if (!block.rich) throw new Error('This block is preserved as original LaTeX.');
    const prior = rich(file, block);
    if (!same(tokens(prior), tokens(content))) throw new Error('Edit citation and math expressions in the LaTeX pane.');
    if (serialize(prior) === serialize(content)) return;
    if (serialize(content) === serialize(block.rich)) { file.edits.delete(block.id); return; }
    set(file, block, block.prefix + serialize(content) + block.suffix, content);
  }

  function editSource(file, block, source) {
    if (!block.rich) throw new Error('This block is preserved as original LaTeX.');
    if (source === current(file, block)) return;
    if (source === originalBlock(file, block)) { file.edits.delete(block.id); return; }
    const parsed = parseFile(source);
    const candidate = parsed.blocks[0];
    if (parsed.blocks.length !== 1 || candidate.kind !== block.kind || candidate.from !== 0 ||
        candidate.to !== source.length || (block.kind === 'heading' && candidate.prefix !== block.prefix)) {
      throw new Error('Keep one supported ' + block.kind + ' in this block. Check the LaTeX commands and delimiters.');
    }
    set(file, block, source, candidate.rich);
  }

  function exportText(file) {
    if (!file.edits.size) return file.original;
    let cursor = 0;
    const parts = [];
    for (const block of file.blocks) {
      if (!file.edits.has(block.id)) continue;
      parts.push(file.original.slice(cursor, block.from), current(file, block));
      cursor = block.to;
    }
    parts.push(file.original.slice(cursor));
    return parts.join('');
  }

  function coverage(file) {
    const report = {
      editableParagraphs: 0, editableHeadings: 0, fallbackParagraphs: 0, fallbackHeadings: 0, preservedBlocks: 0
    };
    const commands = new Map();
    for (const block of file.blocks) {
      if (block.kind === 'paragraph') report.editableParagraphs++;
      else if (block.kind === 'heading') report.editableHeadings++;
      else if (block.fallback === 'paragraph') report.fallbackParagraphs++;
      else if (block.fallback === 'heading') report.fallbackHeadings++;
      else report.preservedBlocks++;
      for (const command of block.commands ?? []) commands.set(command, (commands.get(command) ?? 0) + 1);
    }
    report.editableBlocks = report.editableParagraphs + report.editableHeadings;
    report.fallbackCommands = [...commands].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
      .map(([command, blocks]) => ({ command, blocks }));
    return report;
  }
  globalThis.PaperColabBlocks = { parseFile, current, rich, editVisual, editSource, exportText, preview, tokens, coverage };
})();
