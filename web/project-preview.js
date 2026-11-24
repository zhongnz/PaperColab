/* global PaperColabBlocks, PaperColabEditors, PaperColabLatex */
(() => {
  'use strict';

  const cellLimit = 4000;
  const includeCommands = new Set(['input', 'include', 'subfile']);
  const $ = id => document.getElementById(id);

  function element(tag, text) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  }

  function renderInline(item) {
    if (item.type === 'texToken') {
      const math = element('span');
      const latex = item.attrs.latex;
      return PaperColabEditors.renderMath(math, latex) ? math : element('code', latex);
    }
    let content = document.createTextNode(item.text || '');
    for (const mark of item.marks || []) {
      const formatted = element(mark.type === 'bold' ? 'strong' : 'em');
      formatted.append(content);
      content = formatted;
    }
    return content;
  }

  function includedPaths(latex) {
    const source = latex.replace(/\r\n?/g, '\n');
    try {
      const nodes = PaperColabLatex.LatexPegParser.parse(source).content;
      return nodes.flatMap((node, index) => {
        if (node.type !== 'macro' || !includeCommands.has(node.content)) return [];
        let next = index + 1;
        while (nodes[next]?.type === 'whitespace') next++;
        const arg = nodes[next];
        if (arg?.type !== 'group') return [];
        const path = source.slice(arg.position.start.offset + 1, arg.position.end.offset - 1).trim();
        return path && !/^\/|[\\{}#$%~:*?\x00-\x1f]/.test(path) ? [path] : [];
      });
    } catch {
      return [];
    }
  }

  function resolveFile(files, root, current, target) {
    for (const path of new Set([root, current])) {
      const parts = path.split('/').slice(0, -1);
      let safe = true;
      for (const part of target.split('/')) {
        if (part === '..') {
          if (!parts.length) { safe = false; break; }
          parts.pop();
        } else if (part && part !== '.') parts.push(part);
      }
      if (!safe) continue;
      const resolved = parts.join('/');
      if (files.has(resolved)) return resolved;
      if (files.has(resolved + '.tex')) return resolved + '.tex';
    }
    return null;
  }

  function renderCell(host, block, latex) {
    const rich = block.rich && PaperColabBlocks.parseFile(latex).blocks[0]?.rich;
    if (rich) {
      const text = element(block.kind === 'heading' ? 'h4' : 'p');
      text.append(...(rich.content[0].content || []).map(renderInline));
      host.append(text);
      return;
    }
    const math = element('div');
    if (PaperColabEditors.renderMath(math, latex)) {
      math.className = 'math-preview';
      host.append(math);
      return;
    }
    const retained = element('details');
    retained.append(element('summary', block.label || 'Preserved LaTeX'), element('pre', latex));
    host.append(retained);
  }

  function combined(project, root, drafts) {
    const page = document.createDocumentFragment();
    const title = element('h3', project.title);
    const caption = element('p', 'Screen preview of manuscript cells. Build a PDF for TeX layout, figures, and references.');
    caption.className = 'preview-description';
    page.append(title, caption);
    const overlays = new Map(drafts.map(draft => [draft.block_id, draft.source]));
    const files = new Map();
    for (const block of project.blocks) {
      if (!files.has(block.path)) files.set(block.path, []);
      files.get(block.path).push(block);
    }
    if (!files.size) {
      page.append(element('p', 'Import a manuscript to preview its cells.'));
      return page;
    }
    let renderedCells = 0, truncated = false;
    const stack = new Set(), visited = new Set();
    function renderFile(path, host) {
      if (stack.size >= 48 || stack.has(path)) return;
      stack.add(path);
      visited.add(path);
      for (const block of files.get(path) || []) {
        if (renderedCells >= cellLimit) { truncated = true; break; }
        renderedCells++;
        const latex = overlays.get(block.stableId) ?? block.quote;
        renderCell(host, block, latex);
        if (!block.rich && block.label === 'LaTeX source') {
          for (const input of includedPaths(latex)) {
            const included = resolveFile(files, root, path, input);
            if (included) renderFile(included, host);
          }
        }
      }
      stack.delete(path);
    }
    renderFile(root, page);
    const otherFiles = [...files.keys()].filter(path => !visited.has(path));
    if (otherFiles.length && !truncated) {
      const retained = element('details');
      retained.append(element('summary', 'Other LaTeX source files'));
      for (const path of otherFiles) {
        if (visited.has(path)) continue;
        retained.append(element('h4', path));
        renderFile(path, retained);
      }
      page.append(retained);
    }
    if (truncated) page.append(element('p', 'Screen preview reached its cell limit. The PDF build uses the complete source.'));
    return page;
  }

  function create(api, context) {
    let shown = false, pdfView = false, pending = false, result = null, error = null, sequence = 0, timer;
    const panel = $('manuscript-preview');
    const frame = $('preview-pdf');
    const link = $('open-preview-pdf');
    const mainFile = $('preview-root');
    const includeDrafts = $('preview-drafts');

    function rootFiles(project) {
      return project.files.filter(file => file.is_text && file.is_root && /\.(tex|ltx)$/i.test(file.path)).map(file => file.path);
    }

    function request(drafts) {
      return { root: mainFile.value, engine: $('preview-engine').value, drafts: includeDrafts.checked ? drafts : [] };
    }

    function showFormat() {
      const showPdf = Boolean(pdfView && result);
      frame.hidden = !showPdf;
      $('preview-manuscript').hidden = showPdf;
      $('show-manuscript').setAttribute('aria-pressed', String(!showPdf));
      $('show-preview-pdf').setAttribute('aria-pressed', String(showPdf));
      $('show-preview-pdf').disabled = !result;
    }

    function clearPdf() {
      frame.removeAttribute('src');
      link.removeAttribute('href');
      link.hidden = true;
      if (result) URL.revokeObjectURL(result.url);
      result = null;
    }

    function render() {
      if (!shown) return;
      const { project, loadDrafts } = context();
      if (!project) return;
      const roots = rootFiles(project);
      if (JSON.stringify([...mainFile.options].map(option => option.value)) !== JSON.stringify(roots)) {
        const old = mainFile.value;
        mainFile.replaceChildren(...roots.map(path => new Option(path, path)));
        mainFile.value = roots.includes(old) ? old : roots.find(path => /(?:^|\/)main\.tex$/i.test(path)) || roots[0] || '';
      }
      mainFile.disabled = !roots.length;
      const { drafts, skipped } = loadDrafts();
      includeDrafts.disabled = !drafts.length;
      const options = request(drafts);
      const stale = result && (result.revision !== project.revision || JSON.stringify(result.options) !== JSON.stringify(options));
      let status = roots.length ? '' : 'No main LaTeX file was detected.';
      if (pending) status = 'Building the complete manuscript…';
      else if (error) status = error.message + (result ? ' The previous PDF is available.' : ' The screen preview is available.');
      else if (stale) status = 'The PDF is out of date. Build it again to include the latest changes.';
      else if (result) status = 'PDF built from revision ' + result.revision + (result.draftCount ? ` with ${result.draftCount} saved ${result.draftCount === 1 ? 'draft' : 'drafts'}.` : '.');
      $('preview-status').textContent = status;
      $('preview-draft-status').textContent = skipped && includeDrafts.checked ?
        `${skipped} ${skipped === 1 ? 'draft needs' : 'drafts need'} attention. The preview uses the accepted source for those cells.` : '';
      $('build-preview').disabled = !roots.length || pending;
      $('preview-error').hidden = !error;
      $('preview-error-log').textContent = error?.diagnostics || error?.message || '';
      const paper = $('preview-manuscript');
      const scroll = paper.scrollTop;
      paper.replaceChildren(combined(project, options.root || project.blocks[0]?.path || '', options.drafts));
      paper.scrollTop = scroll;
      showFormat();
    }

    function refresh() {
      if (!shown) return;
      clearTimeout(timer);
      timer = setTimeout(render, 90);
    }

    function toggle(open) {
      shown = open;
      panel.hidden = !shown;
      $('editing-workspace').classList.toggle('preview-open', shown);
      $('toggle-preview').setAttribute('aria-expanded', String(shown));
      $('toggle-preview').textContent = shown ? 'Hide manuscript preview' : 'Preview manuscript';
      if (!open) {
        clearTimeout(timer);
        discardBuild();
        return;
      }
      render();
      if (matchMedia('(max-width: 1219px)').matches) panel.scrollIntoView({ block: 'start' });
    }

    async function build() {
      const { project, loadDrafts } = context();
      if (!project || pending || !mainFile.value) return;
      const attempt = ++sequence;
      const options = request(loadDrafts().drafts);
      pending = true;
      error = null;
      render();
      try {
        const pdf = await api('POST', '/api/projects/' + project.id + '/preview', options);
        if (attempt !== sequence) return;
        const decoded = atob(pdf.pdf_b64);
        if (!decoded.startsWith('%PDF-')) throw new Error('The build did not return a PDF.');
        clearPdf();
        const blob = new Blob([Uint8Array.from(decoded, character => character.charCodeAt(0))], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        result = { url, revision: pdf.revision, draftCount: pdf.draft_count, options };
        frame.src = url + '#navpanes=0&view=FitH';
        link.href = url;
        link.hidden = false;
        pdfView = true;
      } catch (problem) {
        if (attempt !== sequence) return;
        const diagnostics = problem.diagnostics;
        error = { message: problem.message, diagnostics: Array.isArray(diagnostics) ? diagnostics.join('\n') : diagnostics };
        $('preview-error').open = true;
        if (!result) pdfView = false;
      } finally {
        if (attempt === sequence) {
          pending = false;
          render();
        }
      }
    }

    function discardBuild() {
      sequence++;
      pending = pdfView = false;
      error = null;
      clearPdf();
      showFormat();
    }

    function reset() {
      toggle(false);
      mainFile.replaceChildren();
      $('preview-manuscript').replaceChildren();
      $('preview-error-log').textContent = '';
    }

    $('toggle-preview').onclick = () => toggle(!shown);
    $('close-preview').onclick = () => { toggle(false); $('toggle-preview').focus(); };
    $('show-manuscript').onclick = () => { pdfView = false; showFormat(); };
    $('show-preview-pdf').onclick = () => { pdfView = true; showFormat(); };
    $('build-preview').onclick = build;
    mainFile.onchange = () => { discardBuild(); render(); };
    $('preview-engine').onchange = includeDrafts.onchange = render;
    return { refresh, reset };
  }

  globalThis.PaperColabPreview = { create };
})();
