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

  // Conservative scientific adapters. Field offsets refer to the exact
  // source, so editing one field does not reserialize the rest of its cell.
  const mathCommands = new Set('frac sqrt sum prod int lim log ln sin cos tan exp alpha beta gamma delta epsilon varepsilon theta lambda mu pi rho sigma tau phi varphi omega Gamma Delta Theta Lambda Pi Sigma Phi Omega cdot times pm leq geq neq infty partial nabla left right text mathrm mathbf mathcal label ref eqref overline hat bar vec quad qquad'.split(' '));
  function safeMath(value) {
    if (!value.trim() || /[%$&#\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) return false;
    let depth = 0;
    for (const ch of value) {
      if (ch === '{') depth++;
      if (ch === '}' && --depth < 0) return false;
    }
    if (depth !== 0) return false;
    return [...value.matchAll(/\\([a-zA-Z]+|.)/g)].every(m => mathCommands.has(m[1]) || ',;! '.includes(m[1])) && !/\\$/.test(value);
  }
  const plainField = value => !/[\\{}%$&#_^~\x00-\x1f]/.test(value);
  const assetPath = value => /^[A-Za-z0-9_.\/-]+$/.test(value) && !value.startsWith('/') && !value.split('/').some(x => x === '..' || x === '');
  function scientific(source) {
    // Match only complete, independently parsed environments. The adapter
    // intentionally does not attempt to interpret arbitrary TeX macros.
    const eq = /^(\\begin\{(equation\*?)\}|\\\[|\$\$)([\s\S]*?)(\\end\{equation\*?\}|\\\]|\$\$)$/.exec(source);
    if (eq) {
      const close = eq[2] ? '\\end{' + eq[2] + '}' : eq[1] === '\\[' ? '\\]' : '$$';
      if (eq[4] !== close || !safeMath(eq[3]) || /\\(?:label|ref|eqref)\b/.test(eq[3])) return null;
      return {type:'equation', fields:[{name:'Expression', value:eq[3], from:eq[1].length,to:source.length-eq[4].length}]};
    }
    const table = /^(\\begin\{tabular\}\{([lcr]+)\})([\s\S]*?)(\\end\{tabular\})$/.exec(source);
    if (table) {
      const cols = table[2].length, rows = [], fields = [];
      if (cols > 12) return null;
      const body = table[3], base = table[1].length;
      let pos = 0;
      while (pos < body.length) {
        const skip = /^(?:\s+|\\(?:toprule|midrule|bottomrule|hline)(?![A-Za-z]))+/.exec(body.slice(pos));
        if (skip) pos += skip[0].length;
        if (pos === body.length) break;
        const end = body.indexOf('\\\\',pos);
        if (end === -1) return null;
        const row = body.slice(pos,end), values = row.split('&');
        if (values.length !== cols || rows.length >= 100) return null;
        let offset = base + pos, indices = [];
        for (const value of values) {
          const trimmed = value.trim();
          if (!trimmed || !plainField(trimmed)) return null;
          const from = offset + value.indexOf(trimmed);
          indices.push(fields.length);
          fields.push({name:'Row '+(rows.length+1)+', column '+(indices.length),value:trimmed,from,to:from+trimmed.length});
          offset += value.length+1;
        }
        rows.push(indices);
        pos = end+2;
      }
      if (!rows.length) return null;
      return {type:'table',columns:cols,rows,fields};
    }
    const figure = /^(\\begin\{figure\*?\}(?:\[[htbp!H]+\])?\s*(?:\\centering\s*)?\\includegraphics(?:\[[A-Za-z0-9.,=\\ \t+-]+\])?\{)([^{}]+)(\}\s*\\caption\{)([^{}]*)(\}(?:\s*\\label\{[A-Za-z0-9:_.-]+\})?\s*\\end\{figure\*?\})$/.exec(source);
    if (figure && figure[1].includes('figure*') === figure[5].includes('figure*') && assetPath(figure[2]) && plainField(figure[4])) {
      const from = figure[1].length, cap = from + figure[2].length + figure[3].length;
      return {type:'figure',fields:[{name:'Asset path',value:figure[2],from,to:from+figure[2].length},
        {name:'Caption',value:figure[4],from:cap,to:cap+figure[4].length}]};
    }
    const list = /^(\\begin\{(itemize|enumerate)\})([\s\S]*?)(\\end\{\2\})$/.exec(source);
    if (list) {
      const body=list[3], starts=[...body.matchAll(/\\item(?![A-Za-z])\s+/g)], fields=[];
      if (!starts.length || body.slice(0,starts[0].index).trim() || starts.length>100) return null;
      for (let i=0;i<starts.length;i++) {
        const at=starts[i].index+starts[i][0].length;
        const value=body.slice(at,starts[i+1]?.index ?? body.length).trimEnd();
        if (!value || !plainField(value)) return null;
        fields.push({name:'Item '+(i+1),value,from:list[1].length+at,to:list[1].length+at+value.length});
      }
      return {type:'list',ordered:list[2]==='enumerate',fields};
    }
    return null;
  }
  function scientificEdit(source, values) {
    const model=scientific(source);
    if (!model || !Array.isArray(values) || values.length!==model.fields.length)
      throw new Error('Unsupported scientific cell.');
    let candidate=source;
    for (let i=model.fields.length-1;i>=0;i--) {
      const field=model.fields[i], value=values[i];
      if (value===field.value) continue;
      if (typeof value!=='string' || value.length>16000 ||
          !(model.type==='equation' ? safeMath(value) : model.type==='figure' && i===0 ? assetPath(value) : plainField(value)) ||
          (model.type==='table' || model.type==='list') && (!value.trim() || value!==value.trim()))
        throw new Error('Invalid '+field.name+'. Use supported plain text or LaTeX math.');
      candidate=candidate.slice(0,field.from)+value+candidate.slice(field.to);
    }
    const next=scientific(candidate);
    if (!next || next.type!==model.type || next.fields.length!==model.fields.length)
      throw new Error('Scientific edit changes the supported structure.');
    return candidate;
  }
  function bibliographyKeys(text) {
    return [...text.matchAll(/^[ \t]*@(?!comment\b|string\b|preamble\b)[A-Za-z]+\s*[{(]\s*([A-Za-z0-9_.:/+-]+)\s*,/gmi)].map(m=>m[1]);
  }
  function appendCitation(file, block, key) {
    if (block.kind!=='paragraph' || !/^[A-Za-z0-9_.:/+-]+$/.test(key)) throw new Error('Choose a supported citation key.');
    editSource(file,block,current(file,block)+'~\\cite{'+key+'}');
  }

  // Validate structural edits against exact expected source ranges; identities
  // follow content, not parse order. No mutation occurs until validation passes.
  function structural(file, id, action, options = {}) {
    const text = exportText(file);
    let shift = 0;
    const rows = file.blocks.map(block => {
      const source = current(file, block);
      const from = block.from + shift, to = from + source.length;
      shift += source.length - (block.to - block.from);
      return { id: block.id, kind: block.kind, rich: rich(file, block), source, from, to };
    });
    const i = rows.findIndex(row => row.id === id), row = rows[i];
    if (!row || (!row.rich && !(['scientific','scientific-source'].includes(action) && scientific(row.source)))) throw new Error('Select an editable cell; preserved LaTeX cannot be changed structurally.');
    const eol = text.match(/\r\n|\r|\n/)?.[0] ?? '\n', sep = eol + eol;
    let nextId = rows.reduce((n, r) => Math.max(n, r.id + 1), file.nextId ?? 1);
    const fresh = () => nextId++;
    const piece = (id, kind, source) => ({ id, kind, source });
    let start = row.from, end = row.to, items = [], selectedId = id;
    let prefix = '', suffix = '', gap = sep;
    const neighbour = index => {
      const other = rows[index];
      if (!other?.rich) throw new Error('Adjacent editable cells are required. Preserved LaTeX is a boundary.');
      return other;
    };
    switch (action) {
      case 'insert': {
        start = end = row.to;
        const templates = {
          heading:['heading','\\section{New section}'],
          paragraph:['paragraph','New paragraph.'],
          equation:['raw','\\begin{equation}'+eol+'x = y'+eol+'\\end{equation}'],
          table:['raw','\\begin{tabular}{ll}'+eol+'A & B \\\\'+eol+'1 & 2 \\\\'+eol+'\\end{tabular}'],
          list:['raw','\\begin{itemize}'+eol+'\\item New item'+eol+'\\end{itemize}']
        };
        const [kind, source] = Object.hasOwn(templates,options.kind) ? templates[options.kind] : templates.paragraph;
        selectedId = fresh();
        items = [piece(selectedId, kind, source)];
        prefix = suffix = sep;
        break;
      }
      case 'scientific':
      case 'scientific-source': {
        const model = scientific(row.source);
        if (!model || row.kind !== 'raw') throw new Error('Unsupported scientific cell.');
        const source = action === 'scientific' ? scientificEdit(row.source, options.values) : options.source;
        const next = typeof source === 'string' && source.length <= 512 * 1024 && scientific(source);
        if (!next || next.type !== model.type)
          throw new Error('Keep one supported ' + model.type + ' cell. The source draft has not been applied.');
        items = [piece(id, 'raw', source)];
        break;
      }
      case 'delete':
        selectedId = rows[i+1]?.id ?? rows[i-1]?.id ?? null;
        break;
      case 'move-up':
      case 'move-down': {
        const other = neighbour(i + (action === 'move-up' ? -1 : 1));
        const [first, second] = action === 'move-up' ? [other, row] : [row, other];
        start = first.from; end = second.to;
        gap = text.slice(first.to, second.from);
        if (!/^\s*$/.test(gap)) throw new Error('The gap contains source that must be preserved.');
        if (!/\n[ \t\r]*\n|\r[ \t]*\r/.test(gap)) gap += sep;
        items = [second, first];
        prefix = suffix = sep;
        break;
      }
      case 'merge-next': {
        const other = neighbour(i+1);
        if (row.kind !== 'paragraph' || other.kind !== 'paragraph')
          throw new Error('Only adjacent paragraphs can be merged.');
        end = other.to;
        if (!/^\s*$/.test(text.slice(row.to, other.from)))
          throw new Error('The gap contains source that must be preserved.');
        items = [piece(id, 'paragraph', row.source + ' ' + other.source)];
        break;
      }
      case 'split': {
        if (row.kind !== 'paragraph') throw new Error('Only paragraphs can be split.');
        const offset = options.offset;
        const left = [], right = [];
        let cursor = 0;
        for (const node of row.rich.content[0].content ?? []) {
          const size = node.type === 'text' ? node.text.length : 1;
          if (cursor + size <= offset) left.push(node);
          else if (cursor >= offset) right.push(node);
          else {
            const at = offset - cursor;
            if (node.type !== 'text' || /[\uD800-\uDBFF]/.test(node.text[at-1]) && /[\uDC00-\uDFFF]/.test(node.text[at]))
              throw new Error('Choose a text boundary outside a protected token or Unicode character.');
            left.push({...node, text: node.text.slice(0, at)});
            right.push({...node, text: node.text.slice(at)});
          }
          cursor += size;
        }
        if (!Number.isInteger(offset) || offset <= 0 || offset >= cursor)
          throw new Error('Place the caret inside a paragraph to split it.');
        const a = serialize(doc(left)).replace(/[ \t\r\n]+$/, '');
        const c = serialize(doc(right)).replace(/^[ \t\r\n]+/, '');
        if (!a.trim() || !c.trim()) throw new Error('Both new paragraphs must contain content.');
        selectedId = fresh();
        items = [piece(id, 'paragraph', a), piece(selectedId, 'paragraph', c)];
        break;
      }
      case 'convert': {
        const kind = row.kind === 'paragraph' ? 'heading' : 'paragraph';
        const content = serialize(row.rich);
        if (!content.trim()) throw new Error('Enter content before changing the cell type.');
        items = [piece(id, kind, kind === 'heading' ? '\\section{' + content + '}' : content)];
        prefix = suffix = sep;
        break;
      }
      default: throw new Error('Unknown structural operation.');
    }
    let replacement = prefix;
    const expected = [];
    for (const item of items) {
      if (expected.length) replacement += gap;
      const from = start + replacement.length;
      replacement += item.source;
      expected.push({...item, from, to: start + replacement.length});
    }
    replacement += suffix;
    const candidate = text.slice(0, start) + replacement + text.slice(end);
    const delta = replacement.length - (end - start);
    for (const old of rows) {
      if (old.to <= start) expected.push(old);
      else if (old.from >= end) expected.push({...old, from: old.from + delta, to: old.to + delta});
      else if (old.from < start || old.to > end) throw new Error('The operation overlaps another cell.');
    }
    expected.sort((a, b) => a.from - b.from);
    const parsed = parseFile(candidate, {root: Boolean(options.root)});
    if (parsed.blocks.length !== expected.length || parsed.blocks.some((block, j) => {
      const want = expected[j];
      return block.kind !== want.kind || block.from !== want.from || block.to !== want.to ||
        current(parsed, block) !== want.source;
    })) throw new Error('The operation changes an unexpected LaTeX boundary. No changes were made.');
    for (let j = 0; j < parsed.blocks.length; j++) parsed.blocks[j].id = expected[j].id;
    parsed.nextId = nextId;
    return {file: parsed, selectedId};
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
  globalThis.PaperColabBlocks = { parseFile, current, rich, editVisual, editSource, exportText, preview, tokens, coverage, structural, scientific, scientificEdit, bibliographyKeys, appendCitation };
})();
