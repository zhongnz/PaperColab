(() => {
  'use strict';

  const base = path => path.split('/').pop();
  const dir = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const TEX = /\.(tex|ltx)$/i;
  const SOURCE = /\.(tex|ltx|cls|sty)$/i;
  const graphics = ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.mps', '.jbig2', '.jb2'];
  const extensions = {
    input: ['.tex'], include: ['.tex'], subfile: ['.tex'], includegraphics: graphics,
    bibliography: ['.bib'], addbibresource: ['.bib'], usepackage: ['.sty'],
    RequirePackage: ['.sty'], documentclass: ['.cls'], LoadClass: ['.cls'], bibliographystyle: ['.bst']
  };
  const systemCommands = new Set(['documentclass', 'LoadClass', 'usepackage', 'RequirePackage', 'bibliographystyle']);
  const lists = new Set(['bibliography', 'usepackage', 'RequirePackage']);
  const skipSpaces = (s, i) => { while (i < s.length && /\s/.test(s[i])) i++; return i; };

  // Keep offsets intact so each reported line still refers to the original source.
  function maskLiterals(source) {
    return source.replace(/\\begin\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}[\s\S]*?(?:\\end\{\1\}|$)|\\verb\*?([^\sA-Za-z])([^\r\n]*?)\2|\\[^\r\nA-Za-z@]|%[^\r\n]*/g,
      match => match.length === 2 && match[0] === '\\' ? match : match.replace(/[^\n]/g, ' '));
  }

  function group(source, start, open, close) {
    if (source[start] !== open) return null;
    let depth = 1;
    for (let i = start + 1; i < source.length; i++) {
      if (source[i] === '\\') { i++; continue; }
      if (source[i] === open) depth++;
      if (source[i] === close && --depth === 0) return { value: source.slice(start + 1, i), end: i + 1 };
    }
    return { value: null, end: source.length };
  }

  function scan(source) {
    const clean = maskLiterals(source);
    let document = false, hasClass = false, hasBody = false;
    const titles = [];
    const commands = /\\([a-zA-Z@]+|[^\n])/g;
    const refs = [], paths = [];
    let match, line = 1, cursor = 0, truncated = false;
    while ((match = commands.exec(clean))) {
      const name = match[1];
      if (name === 'begin' && /^\s*\{document\}/.test(clean.slice(commands.lastIndex, commands.lastIndex + 80))) document = hasBody = true;
      if (name === 'title' && titles.length < 8) {
        const t = group(clean, skipSpaces(clean,commands.lastIndex), '{','}');
        // A title is evidence for root selection only when it is literal.
        // Do not strip arbitrary macros or infer their expansion.
        if (t?.value && t.value.length <= 300 && /^[\p{L}\p{N}\s:;,.'’()?!&–—-]+$/u.test(t.value)) titles.push(t.value.replace(/\s+/g,' ').trim());
      }
      if (!Object.hasOwn(extensions, name) && name !== 'graphicspath') continue;
      if (refs.length + paths.length >= 4000) { truncated = true; break; }
      for (; cursor < match.index; cursor++) if (clean[cursor] === '\n') line++;
      let i = skipSpaces(clean, commands.lastIndex);
      if (clean[i] === '*') i = skipSpaces(clean, i + 1);
      let option;
      while ((option = group(clean, i, '[', ']'))) i = skipSpaces(clean, option.end);
      let arg = group(clean, i, '{', '}');
      if (!arg && name === 'input') {
        const token = /^[^\s%{}\\]+/.exec(clean.slice(i, i + 1024));
        if (token) arg = { value: token[0], end: i + token[0].length };
      }
      if (arg) commands.lastIndex = Math.max(commands.lastIndex, arg.end);
      if (name === 'documentclass' && arg?.value) document = hasClass = true;
      if (name === 'graphicspath') {
        if (arg?.value) {
          for (const item of arg.value.matchAll(/\{([^{}]*)\}/g)) {
            if (paths.length >= 128) { truncated = true; break; }
            paths.push(item[1].trim());
          }
        }
        continue;
      }
      const values = lists.has(name) ? (arg?.value ?? '').split(',') : [arg?.value ?? ''];
      for (const value of values) {
        if (refs.length >= 4000) { truncated = true; break; }
        refs.push({ command: name, target: value.trim().replace(/^"([^"]+)"$/, '$1').slice(0, 1024), line });
      }
    }
    return { document, hasClass, hasBody, titles, refs, paths, truncated };
  }

  function join(directory, relative) {
    if (relative.startsWith('/') || relative.includes(':') || relative.includes('\\')) return null;
    const parts = directory ? directory.split('/') : [];
    for (const part of relative.split('/')) {
      if (part === '..') { if (!parts.length) return null; parts.pop(); }
      else if (part && part !== '.') parts.push(part);
    }
    return parts.join('/');
  }

  function inventory(files) {
    const roots = [], notes = [], metadata = [], parsed = new Map();
    let conversations = 0, parsedReferences = 0;
    for (const [path, file] of files) {
      if (path.startsWith('__MACOSX/') || base(path).startsWith('._')) continue;
      if (PaperColabArchive.isConversation(path) && /\.json$/i.test(path)) { conversations++; continue; }
      if (file.skipped) notes.push({ level: 'review', path, message: file.skipped });
      if (file.text !== undefined && SOURCE.test(path)) {
        const parsedFile = scan(file.text);
        parsedReferences += parsedFile.refs.length;
        if (parsedReferences > 100000) throw new Error('This archive exceeds 100,000 source references. Check one project at a time.');
        parsed.set(path, parsedFile);
        if (TEX.test(path) && parsedFile.document) roots.push(path);
      }
      if (/\.zip$/i.test(path)) notes.push({ level: 'review', path, message: 'Nested archive. Open this ZIP separately to inspect its contents.' });
      if (!/\.json$/i.test(path) || file.text === undefined) continue;
      let value;
      try { value = JSON.parse(file.text); }
      catch {
        notes.push({ level: 'review', path, message: 'Invalid JSON. Inspect this file in the original export.' });
        continue;
      }
      if (base(path).toLowerCase() === 'export-errors.json') {
        const errors = Array.isArray(value) ? value : value?.errors;
        const count = Array.isArray(errors) ? errors.length : null;
        metadata.push({ path, kind: 'Export log', detail: count === null ? 'Unrecognised format' : count + ' recorded errors' });
        if (count === null || count > 0) notes.push({
          level: count === null ? 'review' : 'missing', path,
          message: count === null ? 'Check the original export log. Its format is unrecognised.' :
            count + ' export error' + (count === 1 ? '' : 's') + ' recorded. Re-export the affected project from Prism.'
        });
      } else {
        const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
        const detail = Array.isArray(value) ? value.length + ' records' : (keys.length ? keys.length + ' fields' : 'Valid JSON');
        const known = ['title', 'name', 'mainFile', 'rootDocument', 'files', 'projects'].filter(key => keys.includes(key));
        metadata.push({ path, kind: 'JSON file', detail: detail + (known.length ? ' · ' + known.join(', ') : '') });
      }
    }
    roots.sort();
    if (!roots.length) notes.push({ level: 'missing', path: '', message: 'No LaTeX root was detected. Look for a .tex file containing a document class or document environment.' });
    return { files, parsed, roots, notes, metadata, conversations };
  }

  function findTarget(files, root, source, ref, graphicPaths) {
    const { command, target } = ref;
    if (!target || /[\\#{}~%*$\x00-\x1f]/.test(target) || target.length >= 1024 ||
        target.startsWith('/') || target.includes(':')) {
      return { status: 'review', reason: 'Computed, external or incomplete path. Verify with a build.' };
    }
    const endings = extensions[command];
    const names = [target];
    if (!endings.some(ext => target.toLowerCase().endsWith(ext))) names.push(...endings.map(ext => target + ext));
    const rootDir = dir(root), sourceDir = dir(source);
    const locations = [rootDir];
    if (command === 'includegraphics') {
      for (const path of graphicPaths) {
        const location = join(rootDir, path);
        if (location !== null) locations.push(location);
      }
    }
    for (const location of locations) {
      for (const name of names) {
        const resolved = join(location, name);
        if (resolved !== null && files.has(resolved)) return { status: 'found', resolved };
      }
    }
    if (sourceDir !== rootDir) {
      for (const name of names) {
        const resolved = join(sourceDir, name);
        if (resolved !== null && files.has(resolved)) return { status: 'review', resolved, reason: 'File exists beside the included source. Confirm the TeX search path.' };
      }
    }
    if (systemCommands.has(command) && !target.includes('/')) {
      return { status: 'toolchain', reason: 'Looked up in the installed TeX distribution at build time.' };
    }
    if (command === 'includegraphics' && graphicPaths.some(path => /[\\#{}$]/.test(path))) {
      return { status: 'review', reason: 'The graphics search path depends on a macro.' };
    }
    if (['bibliography','addbibresource'].includes(command) && files.has(root.replace(TEX, '.bbl'))) {
      return { status: 'review', reason: 'Bibliography source is missing. A prebuilt .bbl is present.' };
    }
    return { status: 'missing', reason: 'Referenced file was not found at the checked paths.' };
  }

  function inspectRoot(data, root) {
    if (!data.roots.includes(root)) throw new Error('Unknown LaTeX root.');
    const visited = new Set(), queue = [root], references = [], notes = [];
    while (queue.length) {
      const source = queue.pop();
      if (visited.has(source)) continue;
      visited.add(source);
      const parsed = data.parsed.get(source);
      if (!parsed) continue;
      if (parsed.truncated) notes.push({ level: 'review', path: source, message: 'A source inspection limit was reached. Check the remaining references with a build.' });
      // Graphics paths can be declared in a separate preamble. Resolve these after walking includes.
      for (const ref of parsed.refs) {
        if (references.length >= 16000) {
          notes.push({ level: 'review', path: root, message: 'The root exceeds 16,000 references. Additional references require a build.' });
          queue.length = 0;
          break;
        }
        const result = ref.command === 'includegraphics' ? {} : findTarget(data.files, root, source, ref, []);
        references.push({ source, ...ref, ...result });
        if (result.resolved && SOURCE.test(result.resolved) && !visited.has(result.resolved)) queue.push(result.resolved);
      }
    }
    const prefixes = new Set();
    for (const path of visited) for (const prefix of data.parsed.get(path)?.paths ?? []) prefixes.add(prefix);
    const graphicPaths = [...prefixes].slice(0, 128);
    if (prefixes.size > graphicPaths.length) notes.push({ level: 'review', path: root, message: 'Graphics search is limited to the first 128 directories.' });
    for (const ref of references) {
      if (ref.command === 'includegraphics') Object.assign(ref, findTarget(data.files, root, ref.source, ref, graphicPaths));
    }
    return { root, sources: [...visited].sort(), references, notes };
  }

  globalThis.PaperColabInspect = { inventory, inspectRoot };
})();
