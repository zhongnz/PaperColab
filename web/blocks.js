/* global PaperColabLatex */
(() => {
  'use strict';
  const headingNames = new Set(['section', 'subsection', 'subsubsection']);
  const runInHeadings = new Set(['paragraph', 'subparagraph']);
  const standalone = new Set(['maketitle', 'tableofcontents', 'appendix', 'clearpage', 'newpage', 'frontmatter', 'mainmatter', 'backmatter']);
  const citationNotes = new Map([['cite', 1], ['citep', 2], ['citet', 2], ['citealt', 2], ['citealp', 2]]);
  const inlineRefs = new Set(['citepalias', 'citetalias', 'ref', 'eqref', 'pageref', 'cref', 'Cref']);
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

  const isString = (node, value) => node?.type === 'string' && node.content === value;
  const skipWhitespace = (nodes, index) => nodes[index]?.type === 'whitespace' ? index + 1 : index;

  function optionalArgumentEnd(nodes, start) {
    for (let i = start + 1; i < nodes.length; i++) {
      const node = nodes[i];
      if (isString(node, ']')) return i;
      if (isString(node, '[') || node.type === 'parbreak' || node.type === 'comment') break;
    }
    return null;
  }

  function protectedInlineEnd(nodes, index, slice, depth) {
    const name = nodes[index].content;
    const citation = citationNotes.has(name);
    const footnote = name === 'footnote';
    if (!citation && !footnote && name !== 'url' && !inlineRefs.has(name)) return null;

    let end = skipWhitespace(nodes, index + 1);
    if (citation && isString(nodes[end], '*')) end = skipWhitespace(nodes, end + 1);
    const maxOptional = citationNotes.get(name) ?? Number(footnote);
    for (let count = 0; count < maxOptional && isString(nodes[end], '['); count++) {
      const close = optionalArgumentEnd(nodes, end);
      if (close === null) return null;
      const valid = footnote
        ? /^[ \t]*[0-9]+[ \t]*$/.test(slice(nodes[end].position.end.offset, nodes[close].position.start.offset))
        : asRich(nodes.slice(end + 1, close), slice, depth + 1);
      if (!valid) return null;
      end = skipWhitespace(nodes, close + 1);
    }

    const argument = nodes[end];
    if (argument?.type !== 'group') return null;
    const source = slice(argument.position.start.offset, argument.position.end.offset);
    if (footnote) return asRich(argument.content, slice, depth + 1) ? end : null;
    // Keep only literal URLs. A command, TeX comment or delimiter may have
    // effects the generic parser cannot model inside a verbatim URL argument.
    if (name === 'url') return /^\{[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=-]+\}$/.test(source) ? end : null;
    return /^\{[A-Za-z0-9_.:/,+\s-]+\}$/.test(source) ? end : null;
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
      const protectedEnd = protectedInlineEnd(nodes, i, slice, depth);
      if (protectedEnd !== null) {
        append({ type: 'texToken', attrs: { latex: slice(node.position.start.offset, nodes[protectedEnd].position.end.offset) } });
        i = protectedEnd;
        continue;
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
  const quarantineClosers = new Map([['iffalse', 'fi'], ['begingroup', 'endgroup']]);

  function commandOnOwnLine(node, text) {
    const from = node.position.start.offset, to = node.position.end.offset;
    const left = text.lastIndexOf('\n', from - 1) + 1;
    const nextNewline = text.indexOf('\n', to);
    const right = nextNewline < 0 ? text.length : nextNewline;
    return /^[ \t]*$/.test(text.slice(left, from)) && /^[ \t]*$/.test(text.slice(to, right));
  }

  function containsAmbiguousControl(node, conditional) {
    const pending = [node];
    while (pending.length) {
      const child = pending.pop();
      if (ambiguous(child) || (conditional && child.type === 'verbatim')) return true;
      if (Array.isArray(child.content)) for (const item of child.content) pending.push(item);
    }
    return false;
  }

  function quarantineEnd(nodes, index, text, slice) {
    const opening = nodes[index];
    const closing = quarantineClosers.get(opening.content);
    if (!closing || !commandOnOwnLine(opening, text)) return null;
    // An unsupported command before the start may take the opening command
    // as an argument. Only separate it from a blank line or supported prose.
    let start = index;
    while (start > 0 && nodes[start - 1].type !== 'parbreak') start--;
    if (!asRich(nodes.slice(start, index), slice)) return null;

    let depth = 1;
    for (let end = index + 1; end < nodes.length; end++) {
      const node = nodes[end];
      if (node.type === 'macro' && node.content === opening.content) { depth++; continue; }
      if (node.type === 'macro' && node.content === closing) {
        if (--depth) continue;
        const after = nodes[end + 1];
        const isolated = !after || after.type === 'parbreak' || (after.type === 'whitespace' && end + 2 === nodes.length);
        return isolated && commandOnOwnLine(node, text) ? end : null;
      }
      if (containsAmbiguousControl(node, opening.content === 'iffalse')) break;
    }
    return null;
  }

  function quarantineRegions(nodes, text, slice) {
    const regions = new Map();
    for (let i = 0; i < nodes.length; i++) {
      if (!ambiguous(nodes[i])) continue;
      const end = quarantineEnd(nodes, i, text, slice);
      if (end === null) return null;
      regions.set(i, end);
      i = end;
    }
    return regions;
  }

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
    const regions = quarantineRegions(nodes, text, slice);
    if (!regions) return rawFile('A conditional or unmatched delimiter makes the block boundaries uncertain.');
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
      const leadingNoindent = group[0].type === 'macro' && group[0].content === 'noindent' && group[1]?.type === 'whitespace';
      const body = leadingNoindent ? group.slice(2) : group;
      const prefix = leadingNoindent ? original.slice(from, start(body[0])) : '';
      const { rich, commands } = represent(body);
      if (rich?.length) add('paragraph', from, to, { rich: doc(rich), prefix, suffix: '' });
      else add('raw', from, to, { label: 'LaTeX source', fallback: 'paragraph', commands });
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (regions.has(i)) {
        flush();
        const last = regions.get(i);
        const label = n.content === 'iffalse' ? 'TeX conditional' : 'TeX group';
        add('raw', start(n), end(nodes[last]), { label });
        i = last;
        continue;
      }
      if (n.type === 'parbreak') { flush(); continue; }
      if (n.type === 'environment' || n.type === 'verbatim' || n.type === 'mathenv' || n.type === 'displaymath') {
        flush();
        add('raw', start(n), end(n), { label: typeof n.env === 'string' ? n.env : 'Display LaTeX' });
        continue;
      }
      if (n.type === 'macro' && (headingNames.has(n.content) || runInHeadings.has(n.content))) {
        // TeX also permits a control sequence to be an unbraced argument, e.g. in a definition.
        const previous = run.findLast(item => !isSpace(item) && item.type !== 'comment');
        const offset = n.position.start.offset;
        const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
        if ((previous && (runInHeadings.has(n.content) || !/^[ \t]*$/.test(text.slice(lineStart, offset)))) ||
            (previous?.type === 'macro' && !standalone.has(previous.content))) {
          run.push(n);
          continue;
        }
        let j = i + 1;
        if (isString(nodes[j], '*')) j++;
        j = skipWhitespace(nodes, j);
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
    if (!same(tokens(prior), tokens(content))) throw new Error('Edit protected LaTeX tokens in the source pane.');
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
        candidate.to !== source.length || coordinates(candidate.prefix).text !== coordinates(block.prefix).text) {
      throw new Error('Keep one supported ' + block.kind + ' in this block. Check the LaTeX commands and delimiters.');
    }
    set(file, block, block.prefix + source.slice(candidate.prefix.length), candidate.rich);
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
