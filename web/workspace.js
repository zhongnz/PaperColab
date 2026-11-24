/* global PaperColabArchive, PaperColabBlocks, PaperColabEditors */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const B = PaperColabBlocks, editors = PaperColabEditors;
  let session, files = new Map(), path, block, visual, source, pending = false, exporting = false;
  let saved = new Map(), onClose, downloadFile;
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
      if (part.edits.size) changed.set(name, B.exportText(part));
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
    $('back-report').disabled = locked;
    $('export-project').disabled = locked;
    for (const el of $('block-list').children) el.disabled = locked;
    $('apply-source').hidden = $('discard-source').hidden = !pending;
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
    $('edit-count').textContent = exporting ? 'Exporting…' : pending ? 'Unapplied source edit' : n ? n + (n === 1 ? ' edited block' : ' edited blocks') : 'Original manuscript';
  }
  function refreshTitle() {
    const row = $('block-list').querySelector('[aria-current="true"] .block-excerpt');
    if (row && block) row.textContent = navTitle(block);
  }
  function showBlock(item) {
    unmount();
    block = item;
    pending = false;
    note();
    for (const el of $('block-list').children) el.setAttribute('aria-current', String(el.dataset.id === String(item?.id)));
    $('block-empty').hidden = Boolean(item);
    $('block-detail').hidden = !item;
    if (!item) { updateControls(); return; }
    const isRich = Boolean(item.rich);
    $('visual-section').hidden = !isRich;
    $('raw-explanation').hidden = isRich;
    $('raw-explanation').textContent = item.reason ?? 'PaperColab preserves this block as original LaTeX.';
    $('block-title').textContent = item.kind === 'heading' ? 'Section heading' : isRich ? 'Paragraph' : item.label;
    const line = file().original.slice(0, item.from).split(/\r\n|\r|\n/).length;
    $('block-context').textContent = path.split('/').pop() + ' · line ' + line;
    if (isRich) {
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
    source = editors.source($('source-surface'), B.current(file(), item), !isRich, value => {
      pending = value !== normalise(B.current(file(), item));
      visual?.setEditable(!pending, false);
      updateControls();
      note(pending ? 'Apply or discard your LaTeX changes before switching blocks.' : '');
    });
    updateControls();
  }
  function showFile(name) {
    path = name;
    $('editor-file').value = name;
    const part = openFile(name);
    const menu = $('block-list');
    const buttons = part.blocks.map(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.id = item.id;
      const kind = document.createElement('small');
      kind.textContent = item.kind === 'raw' ? 'Preserved LaTeX' : item.kind === 'heading' ? 'Heading' : 'Paragraph';
      const excerpt = document.createElement('span');
      excerpt.className = 'block-excerpt';
      excerpt.textContent = navTitle(item);
      button.append(kind, excerpt);
      button.onclick = () => showBlock(item);
      return button;
    });
    menu.replaceChildren(...buttons);
    showBlock(part.blocks.find(b => b.kind === 'paragraph') ?? part.blocks.find(b => b.rich) ?? part.blocks[0]);
  }

  function open(archiveSession, selection, close, save) {
    if (session !== archiveSession) { files = new Map(); saved = new Map(); path = null; }
    session = archiveSession; onClose = close; downloadFile = save;
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
    if (!pending) return;
    const eol = B.current(file(), block).match(/\r\n|\r|\n/)?.[0] ?? file().original.match(/\r\n|\r|\n/)?.[0] ?? '\n';
    const value = source.value().replace(/\n/g, eol);
    try { B.editSource(file(), block, value); showBlock(block); refreshTitle(); note('LaTeX changes applied.'); }
    catch (error) { note(error.message); }
  };
  $('discard-source').onclick = () => { showBlock(block); note('Source draft discarded.'); };
  $('revert-block').onclick = () => { file().edits.delete(block.id); showBlock(block); refreshTitle(); note('Original block restored.'); };
  $('export-project').onclick = async () => {
    if (exporting || pending) return;
    exporting = true;
    visual?.setEditable(false, false);
    $('block-detail').inert = true;
    updateControls();
    try {
      const snapshot = changes();
      const archive = await PaperColabArchive.exportArchive(session.blob, snapshot);
      downloadFile(archive, session.name.replace(/\.zip$/i, '') + '-papercolab.zip');
      saved = snapshot;
      note('Project ZIP exported.');
    } catch (error) { note('Export failed. ' + error.message); }
    finally { exporting = false; $('block-detail').inert = false; visual?.setEditable(true, false); updateControls(); }
  };
  window.addEventListener('beforeunload', event => {
    if (unsaved()) { event.preventDefault(); event.returnValue = ''; }
  });
  function reset() { unmount(); session = null; files = new Map(); saved = new Map(); path = block = null; pending = false; }
  globalThis.PaperColabWorkspace = { open, unsaved, reset };
})();
