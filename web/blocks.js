/* global PaperColabLatex */
(() => {
  'use strict';
  const headingNames = new Set(['section', 'subsection', 'subsubsection']);
  const standalone = new Set(['maketitle', 'tableofcontents', 'appendix', 'clearpage', 'newpage', 'frontmatter', 'mainmatter', 'backmatter']);
  // Keep recognised single-brace reference commands as opaque, ordered
  // tokens. Do not expand project macros or infer optional arguments.
  const inlineRefs = new Set(['cite', 'citep', 'citet', 'citealt', 'citealp',
    'citeauthor', 'citeyear', 'citeyearpar', 'citetalias', 'citepalias',
    'ref', 'eqref', 'pageref', 'autoref', 'nameref', 'cref', 'Cref']);
  const opaqueText = new Set(['footnote', 'texttt', 'textsc', 'underline', 'mbox']);
  const explicitZeroArg = new Set(['TeX','LaTeX','LaTeXe','ldots','dots','textregistered','textcopyright']);
  const optionalCitations = new Set(['cite', 'citep', 'citet', 'citealt', 'citealp', 'citeauthor', 'citeyear', 'citeyearpar']);
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

  // File-local registry, deliberately not a TeX expansion engine. Accept
  // only top-level, complete, literal newcommand declarations in the
  // preamble of a single document. No cross-file inference.
  function declaredMacros(ast, env, text) {
    const registry = new Map();
    if (!env) return registry;
    const preamble = text.slice(0, env.position.start.offset);
    const declarations = new Set(ast.content.filter(n => n.type === 'macro' && n.content === 'newcommand')
      .map(n => n.position.start.offset));
    const reserved = new Set([...headingNames, ...standalone, ...inlineRefs, ...opaqueText,
      ...explicitZeroArg, ...Object.keys(marks), ...Object.keys(namedEscapes), 'label','url',
      'begin','end','input','include','def','let','newcommand','renewcommand','providecommand','par','item']);
    const definition = /^[ \t]*\\newcommand\*?\{\\([A-Za-z]{1,40})\}(?:\[([12])\])?\{([A-Za-z0-9 .,:;!?()/'-]*(?:#[12][A-Za-z0-9 .,:;!?()/'-]*)*)\}[ \t]*(?=\r?$)/gm;
    const seen = new Set();
    for (const match of preamble.matchAll(definition)) {
      if (seen.size >= 100) break;
      const offset = match.index + match[0].indexOf('\\newcommand');
      const [, name, arityText, replacement] = match, arity = Number(arityText || 0);
      if (!declarations.has(offset) || reserved.has(name) || /^(?:if|end|begin)/.test(name)) continue;
      if (seen.has(name)) { registry.delete(name); continue; }
      seen.add(name);
      if (!replacement || replacement.length > 300 ||
          [...replacement.matchAll(/#([12])/g)].some(m => Number(m[1]) > arity) ||
          Array.from({length:arity},(_,i)=>'#'+(i+1)).some(arg=>!replacement.includes(arg))) continue;
      // Reject visible redefinitions/aliases of the same name, including
      // declarations outside the preamble. This is a conservative lexical
      // check, not proof about package code or dynamic TeX execution.
      const changes = new RegExp(String.raw`\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef|edef|xdef|let|futurelet)\*?\s*(?:\{\s*)?\\` + name + String.raw`(?![A-Za-z@])`, 'g');
      if ([...text.matchAll(changes)].length !== 1) continue;
      registry.set(name, arity);
    }
    return registry;
  }

  // Static, bounded cross-file context, not a TeX interpreter. Only a
  // unique root with directly loaded literal declaration files and
  // directly included leaf sections is eligible. Any uncertain include
  // graph disables this optional extension; ordinary parsing remains.
  function projectContexts(entries, roots) {
    const empty=()=>Object.create(null);
    if(!Array.isArray(entries)||!Array.isArray(roots)||roots.length!==1||entries.length>128)return empty();
    const files=new Map(entries.filter(([p,t])=>/\.(tex|ltx|sty|cls)$/i.test(p)&&typeof t==='string'));
    if([...files.values()].reduce((n,t)=>n+t.length,0)>2*1024*1024)return empty();
    const root=roots[0],original=files.get(root);
    if(typeof original!=='string')return empty();
    const {text}=coordinates(original);
    const unsafe=/\\(?:if[A-Za-z]*|else|fi|catcode|csname|expandafter|scantokens|obeylines|obeyspaces|ExplSyntaxOn)\b/;
    if(unsafe.test(text))return empty();
    let ast;
    try{ast=PaperColabLatex.LatexPegParser.parse(text);}catch{return empty();}
    const docs=ast.content.filter(n=>n.type==='environment'&&n.env==='document');
    if(docs.length!==1)return empty();
    const env=docs[0], top=ast.content.filter(n=>n.position.end.offset<=env.position.start.offset);
    const dir=root.includes('/')?root.slice(0,root.lastIndexOf('/')+1):'';
    function resolve(target){
      if(!/^[A-Za-z0-9_.\/-]{1,200}$/.test(target)||target.startsWith('/')||
         target.split('/').some(p=>!p||p==='.'||p==='..'))return null;
      const names=/\.(tex|ltx)$/i.test(target)?[target]:[target,target+'.tex'];
      const found=names.map(n=>dir+n).filter(n=>files.has(n)&&/\.(tex|ltx)$/i.test(n));
      return found.length===1?found[0]:null;
    }
    function includes(nodes,allowed){
      const list=[];
      for(let i=0;i<nodes.length;i++){
        const node=nodes[i];
        if(node.type!=='macro'||!['input','include'].includes(node.content))continue;
        const next=nodes[i+1];
        if(!allowed.includes(node.content)||next?.type!=='group'||
           node.position.end.offset!==next.position.start.offset)return null;
        const source=text.slice(node.position.start.offset,next.position.end.offset);
        const match=/^\\(?:input|include)\{([A-Za-z0-9_.\/-]+)\}$/.exec(source);
        const path=match&&resolve(match[1]);
        if(!path)return null;
        list.push(path);
      }
      return list;
    }
    const preamble=includes(top,['input']),leaves=includes(env.content,['input','include']);
    if(!preamble||!leaves||!preamble.length||
       [...text.matchAll(/\\(?:input|include)\b/g)].length!==preamble.length+leaves.length||
       /\\(?:subfile|import|subimport|InputIfFileExists|includeonly)\b/.test(text))return empty();
    const all=[...preamble,...leaves];
    if(all.includes(root)||new Set(all).size!==all.length)return empty();
    const registry=declaredMacros(ast,env,text);
    const pure=/^[ \t]*\\newcommand\*?\{\\[A-Za-z]{1,40}\}(?:\[[12]\])?\{[A-Za-z0-9 .,:;!?()/'#-]+\}[ \t]*$/;
    for(const path of preamble){
      const definitions=coordinates(files.get(path)).text;
      const lines=definitions.split('\n').filter(l=>l.trim()&&!/^[ \t]*%/.test(l));
      if(!lines.length||lines.some(l=>!pure.test(l)))return empty();
      const wrapped=definitions+'\n\\begin{document}\n\\end{document}';
      let parsed;
      try{parsed=PaperColabLatex.LatexPegParser.parse(wrapped);}catch{return empty();}
      const body=parsed.content.find(n=>n.type==='environment'&&n.env==='document');
      if(!body)return empty();
      const signatures=declaredMacros(parsed,body,wrapped);
      if(signatures.size!==lines.length)return empty();
      for(const [name,arity] of signatures){
        if(registry.has(name))return empty();
        registry.set(name,arity);
      }
      if(registry.size>100)return empty();
    }
    for(const path of leaves){
      const source=files.get(path);
      if(unsafe.test(source)||/\\(?:documentclass|input|include|subfile|import|subimport|InputIfFileExists|newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef|edef|xdef|let|futurelet)\b/.test(source))return empty();
    }
    // Reject any visible competing declaration, even in an unreachable
    // local source. External packages and dynamic TeX are not interpreted.
    for(const name of [...registry.keys()]){
      const re=new RegExp(String.raw`\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef|edef|xdef|let|futurelet)\*?\s*(?:\{\s*)?\\`+name+String.raw`(?![A-Za-z@])`,'g');
      let count=0;
      for(const source of files.values())count += [...source.matchAll(re)].length;
      if(count!==1)registry.delete(name);
    }
    if(!registry.size)return empty();
    const signatures=[...registry].sort(([a],[b])=>a.localeCompare(b));
    const result=empty();
    for(const path of [root,...leaves].sort())result[path]=signatures;
    return result;
  }

  function asRich(nodes, slice, depth = 0, failures = null, macros = new Map(), trace = null) {
    const fail = command => {
      if (failures && command) failures.push(command);
      return null;
    };
    if (depth > 12) return fail('nesting');
    const result = [];
    function append(item, spans = null) {
      const previous = result.at(-1);
      if (trace && spans) trace.map.set(item,spans);
      if (item.type === 'text' && previous?.type === 'text' && same(item.marks, previous.marks)) {
        if(trace) {
          const existing=trace.map.get(previous)??[];
          for(const span of trace.map.get(item)??[])existing.push(span);
          trace.map.set(previous,existing);
        }
        previous.text += item.text;
      } else result.push(item);
    }
    const range = n => [{from:trace?.at(n.position.start.offset),to:trace?.at(n.position.end.offset)}];
    const raw = n => slice(n.position.start.offset, n.position.end.offset);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i], next = nodes[i + 1];
      if (node.type === 'whitespace') { append({ type: 'text', text: ' ' },range(node)); continue; }
      if (node.type === 'string') {
        const text = raw(node);
        if (/[\\{}$%&#_^\x00-\x1f]/.test(text)) return fail('special character');
        if (text) {
          let offset=node.position.start.offset;
          const spans=trace ? Array.from(text,ch=>{
            const from=trace.at(offset);offset+=ch.length;return {from,to:trace.at(offset)};
          }) : null;
          append({ type: 'text', text: text.replace(/~/g, '\u00a0') },spans);
        }
        continue;
      }
      if (node.type === 'inlinemath') {
        append({ type: 'texToken', attrs: { latex: raw(node) } });
        continue;
      }
      if (node.type === 'comment' && depth === 0) {
        // A comment can consume the physical newline. Treat the entire
        // comment and its single line ending as one protected token.
        // Never guess a missing delimiter, join a paragraph break, or
        // reconstruct a comment from the parser's normalised content.
        const from = node.position.start.offset, end = node.position.end.offset;
        let value = raw(node);
        if (!/\r?\n|\r/.test(value)) {
          if (!next || next.type !== 'whitespace' ||
              next.position.start.offset !== end) return fail('comment');
          const gap = raw(next);
          if (!/^(?:\r\n|\r|\n)[ \t]*$/.test(gap)) return fail('comment');
          value = slice(from,next.position.end.offset);
          i++;
        }
        if (!/^[ \t]*%[^\r\n]*(?:\r\n|\r|\n)[ \t]*$/.test(value)) return fail('comment');
        append({type:'texToken',attrs:{latex:value}});
        continue;
      }
      if (node.type !== 'macro') return fail(node.type);
      const name = node.content;
      if (name.length === 1 && '#$%&_{}'.includes(name) && raw(node) === '\\' + name) {
        append({ type: 'text', text: name },range(node)); continue;
      }
      if (macros.has(name)) {
        const arity = macros.get(name);
        // Zero-argument aliases require an explicit empty delimiter;
        // one/two-argument aliases require adjacent literal groups.
        const count = Math.max(1,arity);
        const args = nodes.slice(i+1,i+1+count);
        if (args.length !== count || args.some((arg,j) =>
          arg.type !== 'group' || arg.position.start.offset !== nodes[i+j].position.end.offset ||
          (arity === 0 ? raw(arg) !== '{}' : !/^\{[A-Za-z0-9 .,:;!?()/'-]{1,200}\}$/.test(raw(arg)))))
          return fail(name);
        append({type:'texToken',attrs:{latex:slice(node.position.start.offset,args.at(-1).position.end.offset)}});
        i += count; continue;
      }
      // A bounded run of adjacent AST nodes may encode natbib optional
      // notes before the key group. Only literal notes are recognised.
      // Keep the entire expression opaque and byte-exact.
      if (optionalCitations.has(name) && next?.type !== 'group') {
        const after = node.position.end.offset;
        let j = i + 1;
        while (j < nodes.length && j <= i + 32 && nodes[j].type !== 'group' &&
               ['string','whitespace'].includes(nodes[j].type) &&
               nodes[j].position.start.offset === nodes[j-1].position.end.offset) j++;
        const key = nodes[j];
        if (j > i + 1 && j <= i + 32 && key?.type === 'group' &&
            key.position.start.offset === nodes[j-1].position.end.offset &&
            /^\{[A-Za-z0-9_.:/,+\s-]+\}$/.test(raw(key)) &&
            /^(?:\[[A-Za-z0-9 .,:;!?()~+/'-]{1,120}\]){1,2}$/.test(slice(after,key.position.start.offset))) {
          append({type:'texToken',attrs:{latex:slice(node.position.start.offset,key.position.end.offset)}});
          i = j; continue;
        }
      }
      if (next?.type !== 'group' || node.position.end.offset !== next.position.start.offset) return fail(name);
      if (Object.hasOwn(namedEscapes, name) && !next.content.length) {
        append({ type: 'text', text: namedEscapes[name] },[{from:trace?.at(node.position.start.offset),to:trace?.at(next.position.end.offset)}]);
      } else if (Object.hasOwn(marks, name)) {
        const children = asRich(next.content, slice, depth + 1, failures, macros, trace);
        if (!children?.length) return failures?.length ? null : fail(name);
        for (const child of children) {
          const existing = child.marks ?? [];
          if (existing.some(mark => mark.type === marks[name])) return fail(name);
          const mark = name === 'textit' ? { type: 'italic', attrs: { command: 'textit' } } : { type: marks[name] };
          child.marks = [...existing, mark].sort((a, b) => a.type.localeCompare(b.type));
          append(child);
        }
      } else if (explicitZeroArg.has(name) && raw(next) === '{}') {
        append({type:'texToken',attrs:{latex:slice(node.position.start.offset,next.position.end.offset)}});
      } else if ((inlineRefs.has(name) && /^\{[A-Za-z0-9_.:/,+\s-]+\}$/.test(raw(next))) ||
                 (name === 'label' && /^\{[A-Za-z0-9_.:/+-]+\}$/.test(raw(next))) ||
                 (opaqueText.has(name) && /^\{[^\\{}$%&#_^~\r\n\x00-\x1f]{1,500}\}$/.test(raw(next))) ||
                 (name === 'url' && /^\{https?:\/\/[A-Za-z0-9.\-/:?=+_~#]+\}$/.test(raw(next)))) {
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

  function parseFile(original, { root = false, macros: inheritedMacros = null, trackSpans = false } = {}) {
    const blocks = [], textSpans=new WeakMap();
    function add(kind, from, to, info = {}) {
      if (from >= to || !original.slice(from, to).trim()) return;
      blocks.push({ id: blocks.length + 1, kind, from, to, ...info });
    }
    const rawFile = reason => {
      blocks.length = 0;
      add('raw', 0, original.length, { label: 'Original source', reason });
      return { original, blocks, edits: new Map(), macros: new Map(), textSpans };
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
    const macros = inheritedMacros ?? (env ? declaredMacros(ast,env,text) : new Map());
    const nodes = env ? env.content : ast.content;
    if (nodes.some(ambiguous)) return rawFile('A conditional or unmatched delimiter makes the block boundaries uncertain.');
    const start = n => at(n.position.start.offset), end = n => at(n.position.end.offset);
    function represent(nodes) {
      const commands = [];
      const rich = asRich(nodes, slice, 0, commands, macros, trackSpans ? {map:textSpans,at} : null);
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
      // Do not advertise comment-only or label-only ranges as prose.
      if (rich?.some(n => n.type === 'text' && n.text.trim() || n.type === 'texToken' && !/^[ \t]*%/.test(n.attrs.latex) && !/^\\label\{/.test(n.attrs.latex))) add('paragraph', from, to, { rich: doc(rich), prefix: '', suffix: '' });
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
    return { original, blocks, edits: new Map(), macros, textSpans };
  }

  function originalBlock(file, block) { return file.original.slice(block.from, block.to); }
  function current(file, block) { return file.edits.get(block.id)?.source ?? originalBlock(file, block); }
  function rich(file, block) { return file.edits.get(block.id)?.rich ?? block.rich; }
  function set(file, block, source, content) {
    if (source === originalBlock(file, block)) file.edits.delete(block.id);
    else file.edits.set(block.id, { source, rich: content });
  }

  // Map a single changed visual text run back to exact source offsets.
  // Compare a reparse with the intended visual representation; never
  // substitute a source patch on ambiguous/non-contiguous boundaries.
  function patchText(source, kind, macros, content) {
    const parsed=parseFile(source,{macros,trackSpans:true}), block=parsed.blocks[0];
    if(parsed.blocks.length!==1||block?.kind!==kind||!block.rich||
       block.from!==0||block.to!==source.length)return null;
    const before=block.rich.content[0].content??[], after=content.content[0].content??[];
    if(before.length!==after.length)return null;
    let changed=-1;
    const markKey=node=>serialize(doc([{type:'text',text:'',marks:node.marks}]));
    for(let i=0;i<before.length;i++){
      const a=before[i],b=after[i];
      if(a.type!==b.type||markKey(a)!==markKey(b))return null;
      if(a.type==='texToken'){if(a.attrs.latex!==b.attrs.latex)return null;}
      else if(a.type==='text'&&a.text!==b.text){if(changed!==-1)return null;changed=i;}
    }
    if(changed<0)return null;
    const a=Array.from(before[changed].text),b=Array.from(after[changed].text);
    const spans=parsed.textSpans.get(before[changed]);
    if(!spans||spans.length!==a.length||!spans.length)return null;
    let prefix=0,suffix=0;
    while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
    while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
    const stop=a.length-suffix;
    const from=prefix===a.length?spans.at(-1).to:spans[prefix].from;
    const to=stop===prefix?from:spans[stop-1].to;
    for(let i=prefix+1;i<stop;i++)if(spans[i-1].to!==spans[i].from)return null;
    // A gap can contain formatting wrappers invisible in the visual run.
    // Insertion at such a boundary has no uniquely safe source position.
    if(stop===prefix&&prefix>0&&prefix<a.length&&spans[prefix-1].to!==from)return null;
    const patched=source.slice(0,from)+encode(b.slice(prefix,b.length-suffix).join(''))+source.slice(to);
    const checked=parseFile(patched,{macros}), next=checked.blocks[0];
    if(checked.blocks.length!==1||next?.kind!==kind||next.from!==0||next.to!==patched.length||
       !next.rich||serialize(next.rich)!==serialize(content))return null;
    return patched;
  }

  function editVisual(file, block, content) {
    if (!block.rich) throw new Error('This block is preserved as original LaTeX.');
    const prior = rich(file, block);
    if (!same(tokens(prior), tokens(content))) throw new Error('Edit citation and math expressions in the LaTeX pane.');
    if (serialize(prior) === serialize(content)) return;
    if (serialize(content) === serialize(block.rich)) { file.edits.delete(block.id); return; }
    const source = patchText(current(file,block),block.kind,file.macros,content) ??
      (block.prefix + serialize(content) + block.suffix);
    // Comments are not formatting: prevent wrapping one inside a visual
    // mark, and require reparse to establish a single identical token
    // sequence before accepting an edit. Exact comment bytes survive.
    if (file.macros?.size || tokens(content).some(t => /^[ \t]*%/.test(t))) {
      const marked = (content.content[0].content ?? []).some(n =>
        n.type === 'texToken' && /^[ \t]*%/.test(n.attrs.latex) && n.marks?.length);
      const parsed = parseFile(source,{macros:file.macros}), candidate = parsed.blocks[0];
      if (marked || parsed.blocks.length !== 1 || candidate.kind !== block.kind ||
          candidate.from !== 0 || candidate.to !== source.length || !candidate.rich ||
          !same(tokens(content),tokens(candidate.rich)))
        throw new Error('Keep protected comments and macro expressions intact. Edit complex expressions in LaTeX.');
    }
    set(file, block, source, content);
  }

  function editSource(file, block, source) {
    if (!block.rich) throw new Error('This block is preserved as original LaTeX.');
    if (source === current(file, block)) return;
    if (source === originalBlock(file, block)) { file.edits.delete(block.id); return; }
    const parsed = parseFile(source,{macros:file.macros});
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
    // Splitting/merging or converting comment-bearing prose may change
    // the meaning of the comment's line ending. Keep these explicit
    // structural actions unavailable until a comment-aware transform.
    const hasComment = r => r?.rich && tokens(r.rich).some(t=>/^[ \t]*%/.test(t));
    if (['split','convert'].includes(action)&&hasComment(row) ||
        action==='merge-next'&&(hasComment(row)||hasComment(rows[i+1])))
      throw new Error('Keep protected comments intact; this structural operation is not supported.');
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
    const parsed = parseFile(candidate, {root: Boolean(options.root),macros:file.macros});
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
      if (block.reason) {
        report.fullFileFallback = true;
        report.fullFileReason = block.reason;
      }
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
  globalThis.PaperColabBlocks = { projectContexts, parseFile, current, rich, editVisual, editSource, exportText, preview, tokens, coverage, structural, scientific, scientificEdit, bibliographyKeys, appendCitation };
})();
