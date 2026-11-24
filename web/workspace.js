/* global PaperColabArchive, PaperColabBlocks, PaperColabEditors */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const B = PaperColabBlocks, editors = PaperColabEditors;
  let session, files = new Map(), path, block, visual, source, pending = false, exporting = false;
  let saved = new Map(), onClose, downloadFile;
  let sourcePending = false, splitPanel = null, manuscriptRoot = '';
  let previewUrls = new Set(), previewGeneration = 0;
  let mode = 'document', mounted = new Map(), drafts = new Map(), structuralHistory = new Map();
  const checkpointChanged = (name, part) => part.original !== session.data.files.get(name).text;
  const multi = () => mode === 'document' || mode === 'cells';
  const modeButtons = () => [...$('editor-views').querySelectorAll('[data-view]')];
  const normalise = value => value.replace(/\r\n?/g, '\n');
  const file = () => files.get(path);

  function openFile(name) {
    if (!files.has(name)) {
      const record = session.data.files.get(name);
      files.set(name, B.parseFile(record.text, { root: session.data.roots.includes(name) }));
    }
    return files.get(name);
  }
  function changes() {
    const changed = new Map();
    for (const [name, part] of files) {
      const text = B.exportText(part);
      if (text !== session.data.files.get(name).text) changed.set(name, text);
    }
    return changed;
  }
  function unsaved() {
    if (pending) return true;
    const now = changes();
    return now.size !== saved.size || [...now].some(([name, value]) => saved.get(name) !== value);
  }
  function counts() {
    let n = 0;
    for (const entry of files.values()) n += entry.edits.size;
    return n;
  }
  function unmount() {
    visual?.destroy(); source?.destroy(); visual = source = null;
    previewGeneration++;
    for (const url of previewUrls) URL.revokeObjectURL(url);
    previewUrls.clear();
    for (const entry of mounted.values()) entry.destroy();
    mounted.clear(); drafts.clear(); sourcePending = false; splitPanel = null;
    $('source-surface').inert = false;
    $('visual-section').querySelector('.formatting').hidden = false;
    $('multi-surface').replaceChildren();
    $('visual-surface').replaceChildren(); $('source-surface').replaceChildren();
  }
  function navTitle(item) {
    if (item.rich) return B.preview(B.rich(file(), item)).trim().slice(0, 85) || 'Empty ' + item.kind;
    return item.label === 'LaTeX source' ? B.current(file(), item).trim().split(/\r?\n/)[0].slice(0, 75) : item.label;
  }
  function note(message = '') { $('edit-message').textContent = message; }
  function updateControls() {
    const locked = pending || exporting;
    $('editor-file').disabled = locked;
    for (const button of modeButtons()) {
      button.disabled = locked;
      button.setAttribute('aria-pressed', String(button.dataset.view === mode));
    }
    $('undo-structure').hidden = !structuralHistory.get(path)?.length && mode !== 'cells';
    $('undo-structure').disabled = locked || !structuralHistory.get(path)?.length || Boolean(file()?.edits.size);
    for (const el of $('multi-surface').querySelectorAll('[data-structure]')) el.disabled = locked;
    $('back-report').disabled = locked;
    $('export-project').disabled = locked;
    for (const el of $('block-list').children) el.disabled = locked;
    $('apply-source').hidden = $('discard-source').hidden = !sourcePending;
    if (splitPanel) {
      splitPanel.inert = sourcePending || exporting;
      $('source-surface').inert = drafts.size > 0 || exporting;
    }
    $('revert-block').hidden = !block?.rich;
    $('revert-block').disabled = locked || !file()?.edits.has(block?.id);
    if (visual) {
      $('fmt-bold').setAttribute('aria-pressed', String(visual.isActive('bold')));
      $('fmt-italic').setAttribute('aria-pressed', String(visual.isActive('italic')));
      $('fmt-bold').disabled = $('fmt-italic').disabled = locked;
      $('edit-undo').disabled = locked || !editors.canUndo(visual);
      $('edit-redo').disabled = locked || !editors.canRedo(visual);
    }
    const n = counts();
    const structure = [...files].some(([name, part]) => checkpointChanged(name, part));
    $('edit-count').textContent = exporting ? 'Exporting…' : pending ? 'Unapplied source edit' : structure ? 'Structural changes' : n ? n + (n === 1 ? ' edited block' : ' edited blocks') : 'Original manuscript';
  }
  function refreshTitle(item = block) {
    const row = [...$('block-list').children].find(el => el.dataset.id === String(item?.id));
    if (row && item) row.querySelector('.block-excerpt').textContent = navTitle(item);
  }

  function select(item) {
    block = item;
    for (const el of $('block-list').children) el.setAttribute('aria-current', String(el.dataset.id === String(item?.id)));
    for (const [id, entry] of mounted) entry.cell.classList.toggle('active-cell', id === item?.id);
  }

  function eolSource(item, value) {
    const eol = B.current(file(), item).match(/\r\n|\r|\n/)?.[0] ?? file().original.match(/\r\n|\r|\n/)?.[0] ?? '\n';
    return value.replace(/\n/g, eol);
  }

  function checkpoint(old, result) {
    if (!structuralHistory.has(path)) structuralHistory.set(path, []);
    structuralHistory.get(path).push(old);
    files.set(path, result.file);
    pending = false; sourcePending = false;
    showFile(path, result.selectedId);
  }
  function structural(part, action, options = {}) {
    if (pending || exporting) return;
    try {
      const old = file();
      const result = B.structural(old, part.id, action, {...options, root: session.data.roots.includes(path)});
      checkpoint(old, result);
      note('Cell structure updated. Use Undo structure to restore the preceding checkpoint.');
    } catch (error) { note(error.message); }
  }
  $('undo-structure').onclick = () => {
    if (pending || exporting || file()?.edits.size) return;
    const history = structuralHistory.get(path);
    if (!history?.length) return;
    const old = history.pop();
    old.nextId = Math.max(old.nextId ?? 1, file().nextId ?? 1);
    files.set(path, old);
    showFile(path, block?.id);
    note('Previous cell structure restored.');
  };

  function scientificPanel(host, part, model) {
    const {panel,inputs}=editors.scientificFields(host,model);
    if (model.type==='figure') {
      const figure=document.createElement('figure'); figure.className='local-figure';
      const caption=document.createElement('figcaption');
      const image=document.createElement('img'); image.hidden=true;
      image.alt=model.fields[1].value || 'Imported figure';
      const status=document.createElement('p'); status.className='cell-status';
      const preview=document.createElement('button'); preview.type='button'; preview.textContent='Preview local image';
      caption.textContent=model.fields[1].value;
      figure.append(image,caption,status,preview); panel.append(figure);
      preview.onclick=async()=>{
        const candidates=PaperColabArchive.rasterCandidates(session.data.files,manuscriptRoot,path,inputs[0].value);
        image.hidden=true;
        if(candidates.length!==1) {
          status.textContent=candidates.length?'Multiple matching local assets; use an explicit path and extension.':'No supported local raster asset found; TeX search paths may differ.';
          return;
        }
        const generation=previewGeneration, requestedPath=inputs[0].value, blob=session.blob;
        preview.disabled=true; status.textContent='Reading local image…';
        try {
          const data=await PaperColabArchive.readRaster(blob,candidates[0]);
          if(generation!==previewGeneration || requestedPath!==inputs[0].value) return;
          const previous=image.getAttribute('src');
          if(previous && previewUrls.has(previous)){URL.revokeObjectURL(previous);previewUrls.delete(previous);}
          const url=URL.createObjectURL(data); previewUrls.add(url);
          image.onload=()=>{image.hidden=false;status.textContent='Local preview: '+candidates[0];};
          image.onerror=()=>{image.hidden=true;status.textContent='The browser could not decode this image.';};
          image.src=url;
        } catch(error){if(generation===previewGeneration) status.textContent=error.message;}
        finally{if(generation===previewGeneration) preview.disabled=false;}
      };
      inputs[0].addEventListener('input',()=>{image.hidden=true;image.removeAttribute('src');status.textContent='Preview the revised asset path.';});
      inputs[1].addEventListener('input',()=>{caption.textContent=inputs[1].value;image.alt=inputs[1].value||'Imported figure';});
    }
    const actions=document.createElement('div'); actions.className='cell-operations';
    const apply=document.createElement('button'), discard=document.createElement('button');
    apply.type=discard.type='button'; apply.textContent='Apply scientific fields'; discard.textContent='Discard fields';
    const status=document.createElement('p'); status.className='cell-status'; status.setAttribute('role','status');
    const update=()=>{
      const dirty=inputs.some((input,i)=>input.value!==normalise(model.fields[i].value));
      if(dirty) drafts.set(part.id,true); else drafts.delete(part.id);
      pending=sourcePending || drafts.size>0; apply.disabled=discard.disabled=!dirty;
      status.textContent=dirty?'Apply or discard the scientific draft before changing views or exporting.':'';
      updateControls();
    };
    inputs.forEach(input=>input.addEventListener('input',update));
    discard.onclick=()=>{inputs.forEach((input,i)=>{input.value=model.fields[i].value; input.dispatchEvent(new Event('input'));});};
    apply.onclick=()=>{
      if(!drafts.has(part.id) || exporting || sourcePending) return;
      if(drafts.size!==1){status.textContent='Apply or discard other cell drafts first.';return;}
      // Validate while the draft is still retained. Only a successful
      // checkpoint can remove it and rebuild the view.
      try {
        const old=file();
        const values=inputs.map((input,i)=>input.value===normalise(model.fields[i].value)
          ? model.fields[i].value
          : input.value.replace(/\n/g,model.fields[i].value.match(/\r\n|\r|\n/)?.[0] ?? '\n'));
        const result=B.structural(old,part.id,'scientific',{values,root:session.data.roots.includes(path)});
        checkpoint(old,result); note('Scientific fields applied.');
      } catch(error){status.textContent=error.message;}
    };
    apply.disabled=discard.disabled=true;
    actions.append(apply,discard); panel.append(actions,status);
    return panel;
  }
  function citationPicker(header, part, area, sync) {
    if(part.kind!=='paragraph') return;
    const keys=[...new Set([...session.data.files].filter(([name,data])=>/\.bib$/i.test(name)&&data.text).flatMap(([,data])=>B.bibliographyKeys(data.text)))].sort();
    if(!keys.length) return;
    const picker=document.createElement('select');
    picker.setAttribute('aria-label','Citation key'); picker.append(new Option('Choose citation',''));
    keys.forEach(key=>picker.append(new Option(key,key)));
    const insert=document.createElement('button'); insert.type='button'; insert.textContent='Append citation';
    insert.onclick=()=>{
      if(!picker.value || pending || exporting) return;
      try {B.appendCitation(file(),part,picker.value); area.value=normalise(B.current(file(),part)); sync(); refreshTitle(part); updateControls();}
      catch(error){note(error.message);}
    };
    header.append(picker,insert);
  }

  // Both multi-cell views use the same parsed file and edit map as split view.
  // No content is copied into a second authoritative document.
  function showMulti(item) {
    unmount();
    pending = false;
    note();
    $('block-detail').hidden = true;
    $('block-empty').hidden = Boolean(file().blocks.length);
    const host = $('multi-surface');
    host.hidden = false;
    host.className = 'manuscript-surface ' + mode;
    for (const part of file().blocks) {
      const cell = document.createElement('section');
      cell.className = 'manuscript-cell cell-' + part.kind;
      cell.dataset.blockId = part.id;
      const header = document.createElement('div');
      header.className = 'cell-header';
      const label = document.createElement('span');
      label.textContent = part.kind === 'heading' ? 'Heading' : part.rich ? 'Paragraph' : part.label || 'Preserved LaTeX';
      header.append(label);
      cell.append(header);
      const content = document.createElement('div');
      content.className = 'cell-content';
      cell.append(content);
      host.append(cell);
      if (!part.rich) {
        const raw = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = (part.label || 'LaTeX') + ' · preserved source';
        const pre = document.createElement('pre');
        pre.textContent = B.current(file(), part);
        raw.append(summary, pre);
        content.append(raw);
        const model=B.scientific(B.current(file(),part));
        if(model) {
          cell.classList.add('scientific-cell');
          scientificPanel(content,part,model);
        }
        cell.addEventListener('focusin',()=>select(part));
        mounted.set(part.id, {cell, destroy() {}});
        continue;
      }

      function button(label, action) {
        const el = document.createElement('button');
        el.type = 'button'; el.textContent = label; el.onclick = action;
        return el;
      }
      let editor;
      const sourcePanel = document.createElement('div');
      sourcePanel.className = 'cell-source'; sourcePanel.hidden = true;
      const area = document.createElement('textarea');
      area.setAttribute('aria-label', 'LaTeX for block ' + part.id);
      area.spellcheck = false; area.rows = 4;
      const message = document.createElement('p');
      message.className = 'cell-status'; message.setAttribute('role', 'status');
      const updateDraft = () => {
        const dirty = area.value !== normalise(B.current(file(), part));
        if (dirty) drafts.set(part.id, area.value); else drafts.delete(part.id);
        pending = drafts.size > 0;
        editor?.setEditable(!dirty && !exporting, false);
        apply.disabled = discard.disabled = !dirty;
        toggle.disabled = revert.disabled = dirty;
        message.textContent = dirty ? 'Apply or discard this source draft before exporting or switching views.' : '';
        updateControls();
      };
      const apply = button('Apply LaTeX', () => {
        if (!drafts.has(part.id)) return;
        try {
          B.editSource(file(), part, eolSource(part, area.value));
          area.value = normalise(B.current(file(), part));
          mountVisual(); updateDraft(); refreshTitle(part);
          message.textContent = 'LaTeX applied.';
        } catch (error) { message.textContent = error.message; }
      });
      const discard = button('Discard LaTeX', () => {
        area.value = normalise(B.current(file(), part)); updateDraft();
      });
      const toggle = button('Edit LaTeX', () => {
        sourcePanel.hidden = !sourcePanel.hidden;
        toggle.textContent = sourcePanel.hidden ? 'Edit LaTeX' : 'Hide LaTeX';
        toggle.setAttribute('aria-expanded', String(!sourcePanel.hidden));
        if (!sourcePanel.hidden) { area.value = normalise(B.current(file(), part)); updateDraft(); area.focus(); }
      });
      toggle.setAttribute('aria-expanded', 'false');
      const revert = button('Revert', () => {
        if (drafts.has(part.id)) return;
        file().edits.delete(part.id);
        area.value = normalise(B.current(file(), part));
        mountVisual(); updateDraft(); refreshTitle(part);
      });
      for (const [name, mark] of [['Bold', 'bold'], ['Italic', 'italic']]) {
        const fmt = button(name, () => { if (!drafts.has(part.id)) editor?.chain().focus().toggleMark(mark).run(); });
        fmt.onmousedown = e => e.preventDefault();
        header.append(fmt);
      }
      header.append(toggle, revert);
      if (mode === 'cells') {
        const operations = document.createElement('div');
        operations.className = 'cell-operations';
        const add = (name, action, options) => {
          const control = button(name, () => structural(part, action, typeof options === 'function' ? options() : options));
          control.dataset.structure = action;
          control.onmousedown = e => e.preventDefault();
          operations.append(control);
        };
        add('Add paragraph', 'insert', {kind: 'paragraph'});
        add('Add heading', 'insert', {kind: 'heading'});
        add('Add equation', 'insert', {kind: 'equation'});
        add('Add table', 'insert', {kind: 'table'});
        add('Add list', 'insert', {kind: 'list'});
        add('Move up', 'move-up');
        add('Move down', 'move-down');
        if (part.kind === 'paragraph') {
          add('Split at caret', 'split', () => ({offset: editor.state.selection.from - 1}));
          add('Merge next', 'merge-next');
        }
        add(part.kind === 'heading' ? 'Make paragraph' : 'Make heading', 'convert');
        add('Delete cell', 'delete');
        cell.append(operations);
      }
      area.addEventListener('input', updateDraft);
      sourcePanel.append(area, apply, discard, message);
      cell.append(sourcePanel);
      function mountVisual() {
        editor?.destroy(); content.replaceChildren();
        editor = editors.visual(content, B.rich(file(), part), {
          onChange(value) {
            try {
              B.editVisual(file(), part, value);
              if (!drafts.has(part.id)) area.value = normalise(B.current(file(), part));
              refreshTitle(part); updateControls();
            } catch (error) {
              note(error.message);
            }
          },
          onState() {},
          onProtected() { note('Use the LaTeX pane to change a citation or math expression.'); }
        });
        editor.view.dom.setAttribute('aria-label', 'Visual block ' + part.id);
      }
      mountVisual();
      citationPicker(header,part,area,mountVisual);
      apply.disabled = discard.disabled = true;
      cell.addEventListener('focusin', () => select(part));
      mounted.set(part.id, {cell, destroy: () => editor?.destroy()});
    }
    select(item);
    updateControls();
  }

  function changeMode(next) {
    if (pending || exporting || mode === next) return;
    mode = next;
    if (multi()) showMulti(block);
    else showBlock(block);
  }
  for (const button of modeButtons()) button.onclick = () => changeMode(button.dataset.view);

  function showBlock(item) {
    unmount();
    $('multi-surface').hidden = true;
    block = item;
    pending = false;
    note();
    for (const el of $('block-list').children) el.setAttribute('aria-current', String(el.dataset.id === String(item?.id)));
    $('block-empty').hidden = Boolean(item);
    $('block-detail').hidden = !item;
    if (!item) { updateControls(); return; }
    const isRich = Boolean(item.rich);
    const science = !isRich && item.kind==='raw' ? B.scientific(B.current(file(),item)) : null;
    $('visual-section').hidden = (!isRich && !science) || mode === 'source';
    $('raw-explanation').hidden = isRich || Boolean(science);
    $('visual-section').querySelector('.formatting').hidden = !isRich;
    $('raw-explanation').textContent = item.reason ?? 'PaperColab preserves this block as original LaTeX.';
    $('block-title').textContent = item.kind === 'heading' ? 'Section heading' : isRich ? 'Paragraph' : item.label;
    const line = file().original.slice(0, item.from).split(/\r\n|\r|\n/).length;
    $('block-context').textContent = path.split('/').pop() + ' · line ' + line;
    if (isRich && mode !== 'source') {
      visual = editors.visual($('visual-surface'), B.rich(file(), item), {
        onChange(content) {
          B.editVisual(file(), item, content);
          source?.set(B.current(file(), item));
          refreshTitle(); updateControls(); note();
        },
        onState: () => { if (visual) updateControls(); },
        onProtected: () => note('Use the LaTeX pane to change a citation or math expression.')
      });
    }
    if (science && mode !== 'source') splitPanel=scientificPanel($('visual-surface'),item,science);
    source = editors.source($('source-surface'), B.current(file(), item), !isRich && !science, value => {
      sourcePending = value !== normalise(B.current(file(), item));
      pending = sourcePending || drafts.size > 0;
      visual?.setEditable(!pending, false);
      updateControls();
      note(pending ? 'Apply or discard your LaTeX changes before switching blocks.' : '');
    });
    updateControls();
  }
  function showFile(name, preferredId = null) {
    path = name;
    $('editor-file').value = name;
    const part = openFile(name);
    const menu = $('block-list');
    const buttons = part.blocks.map(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.id = item.id;
      const kind = document.createElement('small');
      const type = item.kind==='raw' ? B.scientific(B.current(file(),item))?.type : null;
      kind.textContent = type ? type[0].toUpperCase()+type.slice(1) : item.kind === 'raw' ? 'Preserved LaTeX' : item.kind === 'heading' ? 'Heading' : 'Paragraph';
      const excerpt = document.createElement('span');
      excerpt.className = 'block-excerpt';
      excerpt.textContent = navTitle(item);
      button.append(kind, excerpt);
      button.onclick = () => {
        if (!multi()) showBlock(item);
        else {
          select(item);
          mounted.get(item.id)?.cell.scrollIntoView({block: 'nearest'});
        }
      };
      return button;
    });
    menu.replaceChildren(...buttons);
    const first = part.blocks.find(b => b.id === preferredId) ?? part.blocks.find(b => b.kind === 'paragraph') ?? part.blocks.find(b => b.rich) ?? part.blocks[0];
    if (multi()) showMulti(first); else showBlock(first);
  }

  function open(archiveSession, selection, close, save) {
    if (session !== archiveSession) { files = new Map(); saved = new Map(); path = null; mode = 'document'; structuralHistory = new Map(); }
    session = archiveSession; onClose = close; downloadFile = save; manuscriptRoot = selection.root;
    const paths = [selection.root, ...selection.sources.filter(name => name !== selection.root)]
      .filter(name => /\.(?:tex|ltx)$/i.test(name) && session.data.files.get(name)?.text !== undefined);
    const others = [...session.data.files].filter(([name, data]) =>
      /\.(?:tex|ltx)$/i.test(name) && data.text !== undefined && !paths.includes(name)).map(([name]) => name);
    const selector = $('editor-file');
    selector.replaceChildren();
    for (const [label, names] of [['Selected manuscript', paths], ['Other LaTeX files in archive', others]]) {
      if (!names.length) continue;
      const group = document.createElement('optgroup'); group.label = label;
      for (const name of names) group.append(new Option(name, name));
      selector.append(group);
    }
    $('edit-project-name').textContent = session.name.replace(/\.zip$/i, '');
    document.body.classList.add('editing');
    $('workspace').hidden = false;
    const selected = paths.includes(path) ? path : paths.find(name => openFile(name).blocks.some(b => b.kind === 'paragraph')) ?? paths[0];
    if (selected) showFile(selected);
    $('edit-project-name').focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  $('editor-file').onchange = () => showFile($('editor-file').value);
  $('back-report').onclick = () => {
    unmount(); $('workspace').hidden = true; document.body.classList.remove('editing'); onClose();
  };
  for (const [id, mark] of [['fmt-bold', 'bold'], ['fmt-italic', 'italic']]) {
    $(id).onmousedown = e => e.preventDefault();
    $(id).onclick = () => { visual?.chain().focus().toggleMark(mark).run(); updateControls(); };
  }
  for (const [id, command] of [['edit-undo', 'undo'], ['edit-redo', 'redo']]) {
    $(id).onmousedown = e => e.preventDefault();
    $(id).onclick = () => { if (visual) { editors[command](visual); visual.commands.focus(); } updateControls(); };
  }
  $('apply-source').onclick = () => {
    if (!sourcePending || drafts.size) return;
    const eol = B.current(file(), block).match(/\r\n|\r|\n/)?.[0] ?? file().original.match(/\r\n|\r|\n/)?.[0] ?? '\n';
    const value = source.value().replace(/\n/g, eol);
    try {
      if (!block.rich && B.scientific(B.current(file(),block))) {
        const old=file();
        const result=B.structural(old,block.id,'scientific-source',{source:value,root:session.data.roots.includes(path)});
        checkpoint(old,result);
      } else {
        B.editSource(file(), block, value); showBlock(block); refreshTitle();
      }
      note('LaTeX changes applied.');
    } catch (error) { note(error.message); }
  };
  $('discard-source').onclick = () => { showBlock(block); note('Source draft discarded.'); };
  $('revert-block').onclick = () => { file().edits.delete(block.id); showBlock(block); refreshTitle(); note('Original block restored.'); };
  $('export-project').onclick = async () => {
    if (exporting || pending) return;
    exporting = true;
    visual?.setEditable(false, false);
    $('block-detail').inert = true;
    $('multi-surface').inert = true;
    updateControls();
    try {
      const snapshot = changes();
      const archive = await PaperColabArchive.exportArchive(session.blob, snapshot);
      downloadFile(archive, session.name.replace(/\.zip$/i, '') + '-papercolab.zip');
      saved = snapshot;
      note('Project ZIP exported.');
    } catch (error) { note('Export failed. ' + error.message); }
    finally { exporting = false; $('block-detail').inert = false; $('multi-surface').inert = false; visual?.setEditable(true, false); updateControls(); }
  };
  window.addEventListener('beforeunload', event => {
    if (unsaved()) { event.preventDefault(); event.returnValue = ''; }
  });
  function reset() { unmount(); session = null; files = new Map(); saved = new Map(); path = block = null; pending = false; structuralHistory = new Map(); }
  globalThis.PaperColabWorkspace = { open, unsaved, reset };
})();
