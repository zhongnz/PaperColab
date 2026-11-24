/* global PaperColabBlocks, PaperColabEditors, PaperColabAccess, PaperColabPreview */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const demo = [['Ada', 'demo-ada'], ['Bao', 'demo-bao'], ['Iris', 'demo-iris'], ['Quill', 'demo-quill']];
  const draftMemory = new Map();
  const submitting = new Set();
  let demoMode = false, demoToken = '', me, detail, activeProject, selected, visual, source;
  let projectRequest = 0, identityRequest = 0, loading = false, polling = false, activityVersion, replyAnchor, draft;
  let storageUnavailable = false;
  const preview = PaperColabPreview.create(api, () => ({ project: detail, loadDrafts: previewDrafts }));

  function say(message) { $('status').textContent = message || ''; }
  function fail(error) { $('error').hidden = false; $('error').textContent = error.message || String(error); }
  function clear() { $('error').hidden = true; $('error').textContent = ''; }

  async function api(method, path, body, raw) {
    const headers = {};
    if (demoToken) headers.authorization = 'Bearer ' + demoToken;
    if (me && !['/api/me', '/api/session', '/api/health'].includes(path)) headers['x-papercolab-actor'] = me.id;
    if (!raw && body) headers['content-type'] = 'application/json';
    if (raw) headers['content-type'] = 'application/zip';
    const response = await fetch(path, { method, headers, body: raw || (body ? JSON.stringify(body) : undefined) });
    const payload = await response.json();
    if (!response.ok) throw Object.assign(new Error(payload.error || 'The request failed.'), {
      status: response.status, diagnostics: payload.diagnostics
    });
    return payload;
  }

  function download(bytes, name, type) {
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function role() {
    return detail?.members.find(member => member.id === me?.id)?.role || '';
  }
  function canDecide() { return role() === 'lead' || role() === 'reviewer'; }
  function canComment() { return ['lead', 'reviewer', 'author'].includes(role()); }
  function canPropose(block) { return block.can_propose ?? ['lead', 'author'].includes(role()); }
  function equal(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

  function addButton(host, label, action, className = 'text-button') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.onclick = () => act(async () => {
      button.disabled = true;
      try { await action(); }
      finally { button.disabled = false; }
    });
    host.append(button);
    return button;
  }

  function destroyEditors() {
    visual?.destroy(); source?.destroy(); visual = source = null;
    $('visual-host').replaceChildren(); $('source-host').replaceChildren();
  }

  function closeProject() {
    projectRequest++;
    loading = false;
    detail = activeProject = selected = activityVersion = null;
    draft = null;
    destroyEditors();
    preview.reset();
    endReply();
    $('comment-body').value = '';
    $('new-cell').reset();
    $('add-cell').open = false;
    $('open').hidden = true;
  }

  function signedOut() {
    identityRequest++;
    closeProject();
    me = null;
    $('who').textContent = '';
    $('projects').hidden = true;
    $('token-label').hidden = $('use-token').hidden = false;
    $('sign-out').hidden = true;
  }

  async function refresh(preferred = activeProject || sessionStorage.getItem('papercolab-project')) {
    const request = ++identityRequest;
    const actor = await api('GET', '/api/me');
    if (request !== identityRequest) return;
    if (actor.id !== me?.id) closeProject();
    me = actor;
    const [projects, policy] = await Promise.all([
      api('GET', '/api/projects'),
      me.workspace_role === 'operator' ? api('GET', '/api/admin/policy') : null
    ]);
    if (request !== identityRequest) return;
    $('projects').hidden = false;
    $('token-label').hidden = $('use-token').hidden = true;
    $('sign-out').hidden = false;
    if (demoMode) $('actor').value = demo.find(([name]) => name === me.name)?.[1] || '';
    $('who').textContent = me.name + (me.workspace_role ? ' · ' + me.workspace_role : '') + ' · ' + me.kind;
    const list = $('project-list');
    list.replaceChildren();
    for (const project of projects) {
      const button = addButton(list, project.title + ' · ' + project.role, () => openProject(project.id));
      button.dataset.project = project.id;
    }
    $('operator-tools').hidden = me.workspace_role !== 'operator';
    if (policy) {
      $('allow-ai').checked = policy.allow_ai;
      $('retention').value = policy.retention_days;
    }
    const target = projects.find(project => project.id === preferred) ||
      (demoMode && !preferred ? projects.find(project => project.title === 'Estuary field notes') : null);
    if (target) await openProject(target.id);
    else closeProject();
  }

  async function openProject(id) {
    if (activeProject !== id) closeProject();
    activeProject = id;
    for (const button of $('project-list').children) button.setAttribute('aria-current', String(button.dataset.project === id));
    await refreshCurrent();
  }

  async function refreshCurrent() {
    if (!activeProject) return;
    const request = ++projectRequest;
    loading = true;
    try {
      const next = await api('GET', '/api/projects/' + activeProject);
      if (request !== projectRequest) return;
      $('sync-status').textContent = '';
      if (equal(detail, next)) return;
      const previous = detail;
      detail = next;
      sessionStorage.setItem('papercolab-project', detail.id);
      renderProject(previous);
    } finally {
      if (request === projectRequest) loading = false;
    }
  }

  async function syncCurrent() {
    if (!activeProject || loading || polling) return;
    const project = activeProject;
    const actor = me?.id;
    polling = true;
    try {
      const { version } = await api('GET', '/api/projects/' + project + '/activity');
      if (activeProject !== project || me?.id !== actor) return;
      if (version !== activityVersion || !detail) {
        await refreshCurrent();
        if (activeProject === project && me?.id === actor) activityVersion = version;
      } else {
        $('sync-status').textContent = '';
      }
    } catch (error) {
      if (activeProject !== project || me?.id !== actor) return;
      if (error.status === 401) {
        signedOut();
        say('Sign in again to reopen your project.');
      } else if (error.status === 409) {
        try { await refresh(project); }
        catch (loginError) { signedOut(); fail(loginError); }
      } else if (error.status === 403 || error.status === 404) {
        closeProject();
        say(error.message);
      } else {
        $('sync-status').textContent = 'Updates paused. Your editor and drafts are still available.';
      }
    } finally {
      polling = false;
    }
  }

  function renderProject(previous) {
    $('open').hidden = false;
    $('project-title').textContent = detail.title;
    $('project-title').dataset.id = detail.id;
    const ready = detail.readiness;
    $('readiness').textContent = ready.ready ? 'Ready for release.' :
      ready.pending_suggestions + ' pending suggestions, ' + ready.unresolved_anchors + ' unresolved anchors, ' + ready.open_decisions + ' open decisions.';
    const membersChanged = !equal(previous?.members, detail.members);
    const blocksChanged = !equal(previous?.blocks, detail.blocks);
    if (membersChanged) {
      const members = $('members');
      members.replaceChildren();
      for (const member of detail.members) {
        const row = document.createElement('div');
        row.className = 'person';
        row.textContent = member.name + ' · ' + member.kind + ' · ' + member.role;
        members.append(row);
      }
      globalThis.PaperColabAccess?.render($('project-access'), detail, me, api, refreshCurrent);
    }
    const files = detail.files.filter(file => file.is_text && /\.(tex|ltx)$/i.test(file.path));
    const select = $('file');
    const choice = detail.blocks.find(block => block.stableId === (selected?.stableId || sessionStorage.getItem(selectionKey())));
    const path = choice?.path || (previous && select.value);
    if (!previous || !equal([...select.options].map(option => option.value), files.map(file => file.path))) {
      select.replaceChildren(...files.map(file => new Option(file.path, file.path)));
    }
    select.value = files.find(file => file.path === path)?.path || (files.find(file => /methods/.test(file.path)) || files[0])?.path || '';
    if (blocksChanged || !equal(previous?.suggestions, detail.suggestions)) renderQueue();
    if (!equal(previous?.objects, detail.objects) || !equal(previous?.links, detail.links)) renderLibrary();
    if (!equal(previous?.decisions, detail.decisions)) renderDecisions();
    if (!equal(previous?.releases, detail.releases)) renderReleases();
    if (blocksChanged || membersChanged || !equal(previous?.comments, detail.comments) || !equal(previous?.anchors, detail.anchors)) renderThreads();
    if (blocksChanged) showFile(select.value, choice);
    else {
      renderDraftTools();
      if (membersChanged) renderBlockPolicy();
    }
  }

  function renderQueue() {
    const queue = $('queue');
    queue.replaceChildren();
    const rows = detail.suggestions.filter(item => item.status !== 'rejected');
    if (!rows.length) { queue.textContent = 'No suggestions yet.'; return; }
    for (const item of rows) {
      const row = document.createElement('article');
      const title = document.createElement('p');
      title.textContent = item.actor_name + ' · ' + item.actor_kind + ' · ' + item.mode + ' · ' + item.status;
      const change = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Compare before and after';
      const beforeLabel = document.createElement('p');
      beforeLabel.textContent = 'Original LaTeX';
      const before = document.createElement('pre');
      before.textContent = item.before;
      const afterLabel = document.createElement('p');
      afterLabel.textContent = 'Proposed LaTeX';
      const content = document.createElement('pre');
      content.textContent = item.after;
      change.append(summary, beforeLabel, before, afterLabel, content);
      row.append(title, change);
      const block = detail.blocks.find(block => block.stableId === item.block_id);
      if (block) addButton(row, 'Show block', () => openBlock(block));
      if (item.status === 'pending' && (item.can_decide ?? (canDecide() && me.kind === 'human'))) {
        addButton(row, 'Accept', () => decideSuggestion(item, 'accept'), 'primary');
        addButton(row, 'Reject', () => decideSuggestion(item, 'reject'), 'secondary');
      }
      if (['stale', 'needs-review'].includes(item.status) && block?.rich && canPropose(block)) {
        addButton(row, 'Recover as source draft', () => recoverSuggestion(item, block));
      }
      queue.append(row);
    }
  }

  async function decideSuggestion(item, decision) {
    try {
      await api('POST', '/api/projects/' + detail.id + '/suggestions/' + item.id + '/' + decision);
      say(decision === 'accept' ? 'Suggestion accepted.' : 'Suggestion rejected.');
    } finally {
      await refreshCurrent();
    }
  }

  function renderThreads() {
    const host = $('threads');
    host.replaceChildren();
    const authors = new Map(detail.members.map(member => [member.id, member.name]));
    const comments = new Map();
    for (const comment of detail.comments) {
      if (!comments.has(comment.anchor_id)) comments.set(comment.anchor_id, []);
      comments.get(comment.anchor_id).push(comment);
    }
    if (!comments.size) host.textContent = 'No comments yet.';
    for (const anchor of detail.anchors) {
      const thread = comments.get(anchor.id);
      if (!thread) continue;
      const row = document.createElement('article');
      const location = document.createElement('p');
      location.className = 'muted';
      location.textContent = (anchor.path || 'Block location unavailable') + ' · ' + anchor.status;
      const quote = document.createElement('p');
      quote.textContent = anchor.quote;
      row.append(location, quote);
      const block = detail.blocks.find(block => block.stableId === anchor.block_id);
      if (block) addButton(row, 'Show block', () => openBlock(block));
      if (block && canComment() && !anchor.dismissed) addButton(row, 'Reply to thread', () => beginReply(anchor, block));
      for (const comment of thread) {
        const meta = document.createElement('p');
        meta.className = 'muted';
        meta.textContent = (authors.get(comment.actor_id) || 'Former collaborator') + ' · ' + comment.status;
        const body = document.createElement('p');
        body.textContent = comment.body;
        row.append(meta, body);
        if (comment.status === 'open' && canDecide() && me.kind === 'human') {
          addButton(row, 'Resolve comment', async () => {
            await api('POST', '/api/projects/' + detail.id + '/comments/' + comment.id + '/resolve');
            await refreshCurrent();
          }, 'secondary');
        }
      }
      host.append(row);
    }
  }

  function renderLibrary() {
    const library = $('library');
    library.replaceChildren();
    const evidence = $('evidence');
    const selectedEvidence = evidence.value;
    evidence.replaceChildren();
    for (const object of detail.objects) {
      const row = document.createElement('p');
      row.textContent = object.kind + ' · ' + object.title + (object.external.identifier ? ' · ' + object.external.system + ':' + object.external.identifier : '');
      library.append(row);
      if (object.kind !== 'claim') evidence.append(new Option(object.title, object.id));
    }
    if ([...evidence.options].some(option => option.value === selectedEvidence)) evidence.value = selectedEvidence;
    const links = $('links');
    links.replaceChildren();
    for (const link of detail.links) {
      const row = document.createElement('p');
      row.textContent = 'Claim link' + (link.changed ? ' · evidence has a newer revision; the recorded revision stays ' + link.evidence_revision : ' · revision ' + link.evidence_revision) +
        (link.anchor_status ? ' · anchor ' + link.anchor_status : '');
      links.append(row);
    }
  }

  function renderDecisions() {
    const host = $('decisions');
    host.replaceChildren();
    for (const decision of detail.decisions) {
      const row = document.createElement('p');
      row.textContent = decision.status + ' · ' + decision.text;
      host.append(row);
      if (decision.status === 'open' && role() === 'lead') {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'text-button'; button.textContent = 'Accept decision';
        button.onclick = () => act(() => api('POST', '/api/projects/' + detail.id + '/decisions/' + decision.id, { status: 'accepted' }).then(refresh));
        host.append(button);
      }
    }
  }

  function renderReleases() {
    const host = $('releases');
    host.replaceChildren();
    for (const release of detail.releases) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'text-button';
      button.textContent = 'Download release ' + release.revision;
      button.onclick = () => act(async () => {
        const payload = await api('GET', '/api/projects/' + detail.id + '/releases/' + release.id);
        download(Uint8Array.from(atob(payload.zip_b64), char => char.charCodeAt(0)), detail.title + '-release.zip', 'application/zip');
      });
      host.append(button);
    }
  }

  function selectionKey() { return 'papercolab-selection:' + me.id + ':' + detail.id; }
  function draftPrefix() { return 'papercolab-draft:' + me.id + ':' + detail.id + ':'; }
  function draftKey(blockId, kind = 'cell') { return draftPrefix() + blockId + ':' + kind; }

  function readDraft(key) {
    if (draftMemory.has(key)) return draftMemory.get(key);
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  }

  function storeDraft(key, record) {
    try {
      if (record) localStorage.setItem(key, JSON.stringify(record));
      else localStorage.removeItem(key);
      draftMemory.delete(key);
      storageUnavailable = false;
      return true;
    } catch {
      draftMemory.set(key, record);
      storageUnavailable = true;
      return false;
    }
  }

  function baseFor(block) {
    return { blockId: block.stableId, path: block.path, before: block.quote, projectRevision: detail.revision,
      blockRevision: block.revision };
  }

  function isStale(record, block = selected) {
    return Boolean(record && (!block?.rich || record.before !== block.quote ||
      (record.blockRevision != null && record.blockRevision !== block.revision)));
  }

  function saveDraft(record) {
    draft = record;
    const stored = storeDraft(draftKey(selected.stableId), record);
    updateDraftIndicator();
    renderDraftTools();
    return stored;
  }

  function editableCell(latex) {
    const file = PaperColabBlocks.parseFile(latex);
    const block = file.blocks[0];
    if (!block?.rich || file.blocks.length !== 1 || block.from !== 0 || block.to !== latex.length) {
      throw new Error('Keep one supported LaTeX block in this cell.');
    }
    return { file, block };
  }

  function candidateRecord(base, mode, latex, visualContent) {
    const next = { ...base, latex, mode };
    delete next.error;
    delete next.visualContent;
    try {
      const { file, block } = editableCell(base.before);
      PaperColabBlocks.editSource(file, block, latex);
      next.latex = next.lastValid = PaperColabBlocks.current(file, block);
    } catch (error) {
      next.lastValid = base.lastValid ?? base.before;
      next.error = error.message;
      if (mode === 'visual') next.visualContent = visualContent;
    }
    return next;
  }

  function editDraft(mode, content) {
    const base = draft || baseFor(selected);
    let latex = content;
    if (mode === 'visual') {
      const { file, block } = editableCell(base.lastValid ?? base.before);
      PaperColabBlocks.editVisual(file, block, content);
      latex = PaperColabBlocks.current(file, block);
    }
    const record = candidateRecord(base, mode, latex, content);
    const reverted = !record.error && !isStale(record) && record.latex === record.before;
    saveDraft(reverted ? null : record);
    syncEditors(mode);
  }

  function legacyDraft(record, mode) {
    const { content, ...base } = record;
    if (mode === 'source') return candidateRecord(base, mode, content);
    const { file, block } = editableCell(base.before);
    PaperColabBlocks.editVisual(file, block, content);
    return candidateRecord(base, mode, PaperColabBlocks.current(file, block), content);
  }

  function loadCellDraft(blockId) {
    const key = draftKey(blockId);
    const existing = readDraft(key);
    if (existing) return existing;
    const savedSource = readDraft(draftKey(blockId, 'source'));
    const savedVisual = readDraft(draftKey(blockId, 'visual'));
    if (!savedSource && !savedVisual) return null;
    const fromSource = savedSource && legacyDraft(savedSource, 'source');
    let fromVisual;
    try {
      fromVisual = savedVisual && legacyDraft(savedVisual, 'visual');
    } catch {
      fromVisual = { ...savedVisual, invalidLegacy: true };
    }
    const primary = fromSource || (fromVisual?.invalidLegacy ? null : fromVisual);
    const alternate = fromVisual && (fromVisual.invalidLegacy || (fromSource && (
      fromSource.latex !== fromVisual.latex || fromSource.before !== fromVisual.before || fromSource.blockRevision !== fromVisual.blockRevision)));
    if ((!alternate || storeDraft(draftKey(blockId, 'alternate'), fromVisual)) && storeDraft(key, primary)) {
      storeDraft(draftKey(blockId, 'source'), null);
      storeDraft(draftKey(blockId, 'visual'), null);
    }
    return primary;
  }

  function previewDrafts() {
    const drafts = [];
    let skipped = 0;
    for (const block of detail.blocks) {
      const record = block.stableId === selected?.stableId ? draft : loadCellDraft(block.stableId);
      if (!record) continue;
      if (record.error || isStale(record, block) || !canPropose(block)) {
        skipped++;
      } else {
        drafts.push({ block_id: block.stableId, base_block_revision: block.revision, source: record.latex });
      }
    }
    return { drafts, skipped };
  }

  function showFile(path, choice) {
    const host = $('blocks');
    host.replaceChildren();
    const blocks = detail.blocks.filter(block => block.path === path);
    for (const [index, block] of blocks.entries()) {
      const type = block.kind === 'heading' ? 'Heading' : block.rich ? 'Paragraph' : 'Preserved LaTeX';
      const saved = ['cell', 'source', 'visual'].some(kind => readDraft(draftKey(block.stableId, kind)));
      const button = addButton(host, '', () => selectBlock(block), 'secondary');
      button.dataset.block = block.stableId;
      const kind = document.createElement('small');
      kind.className = 'cell-kind';
      kind.textContent = 'Cell ' + (index + 1) + ' · ' + type;
      const excerpt = document.createElement('span');
      excerpt.className = 'block-excerpt';
      excerpt.textContent = block.quote.replace(/\s+/g, ' ').slice(0, 115);
      const draftLabel = document.createElement('small');
      draftLabel.className = 'cell-draft-indicator';
      draftLabel.textContent = 'Draft';
      draftLabel.hidden = !saved;
      button.append(kind, excerpt, draftLabel);
    }
    selectBlock(choice?.path === path ? choice : blocks.find(block => block.rich && block.kind === 'paragraph') || blocks[0]);
    renderDetachedDrafts();
  }

  function openBlock(block) {
    const current = detail.blocks.find(candidate => candidate.stableId === block.stableId);
    if (!current) throw new Error('This block is no longer available.');
    $('file').value = current.path;
    showFile(current.path, current);
    $('block-label').scrollIntoView({ block: 'center' });
  }

  function selectBlock(block) {
    const previous = selected;
    selected = block;
    if (!block) {
      destroyEditors();
      draft = null;
      $('block-label').textContent = 'No manuscript blocks yet.';
      renderDraftTools();
      renderBlockPolicy();
      return;
    }
    const sameBlock = previous?.stableId === block.stableId;
    if (!sameBlock) {
      draft = loadCellDraft(block.stableId);
      endReply();
      $('comment-body').value = '';
      sessionStorage.setItem(selectionKey(), block.stableId);
    }
    for (const button of $('blocks').children) {
      const current = button.dataset.block === block.stableId;
      button.setAttribute('aria-current', String(current));
      button.classList.toggle('is-selected', current);
    }
    const owner = detail.members.find(member => member.id === block.owner_id);
    const labels = [block.path, block.rich ? 'Editable' : 'Preserved LaTeX'];
    if (block.revision != null) labels.push('Revision ' + block.revision);
    if (owner) labels.push(owner.name);
    $('block-label').textContent = labels.join(' · ');
    const accessChanged = !sameBlock || block.rich !== previous.rich || canPropose(block) !== canPropose(previous);
    if (accessChanged || (previous.quote !== block.quote && !draft)) mountEditors();
    renderDraftTools();
    renderBlockPolicy();
  }

  function renderBlockPolicy() {
    const allowed = selected && role() === 'lead' && me.kind === 'human';
    $('block-policy').hidden = !allowed;
    renderCellStructure(allowed);
    if (!allowed) return;
    const owners = detail.members.filter(member => member.kind === 'human' && ['lead', 'author'].includes(member.role));
    $('block-owner').replaceChildren(new Option('No owner', ''), ...owners.map(member => new Option(member.name, member.id)));
    $('block-owner').value = selected.owner_id || '';
    $('block-ai').checked = Boolean(selected.allow_ai);
  }

  function adjacentCell(offset) {
    const cells = detail.blocks.filter(block => block.path === selected.path);
    return cells[cells.findIndex(block => block.stableId === selected.stableId) + offset];
  }

  function canPlace(direction, neighbor) {
    if (!neighbor) return false;
    return !(direction === 'before' ? neighbor.label === 'Document opening' : neighbor.label === 'Document closing');
  }

  function renderCellStructure(allowed) {
    const selectedBoundary = ['Document opening', 'Document closing'].includes(selected?.label);
    $('cell-position').hidden = !allowed || selectedBoundary;
    $('add-cell').hidden = !allowed;
    if (!allowed) return;
    $('move-cell-up').disabled = !canPlace('before', adjacentCell(-1));
    $('move-cell-down').disabled = !canPlace('after', adjacentCell(1));
    const placement = $('new-cell-placement');
    for (const option of placement.options) option.disabled = !canPlace(option.value, selected);
    if (placement.selectedOptions[0]?.disabled) placement.value = canPlace('after', selected) ? 'after' : 'before';
  }

  async function moveCell(offset) {
    const neighbor = adjacentCell(offset);
    const direction = offset < 0 ? 'before' : 'after';
    if (!canPlace(direction, neighbor)) return;
    const project = detail.id;
    const cell = selected;
    await api('POST', `/api/projects/${project}/blocks/${cell.stableId}/move`, {
      neighbor_id: neighbor.stableId, direction,
      base_block_revision: cell.revision, base_neighbor_revision: neighbor.revision
    });
    if (activeProject !== project) return;
    await refreshCurrent();
    say('Cell moved.');
  }

  async function addCell() {
    const input = $('new-cell-source');
    const text = input.value.trim();
    const cells = PaperColabBlocks.parseFile(text).blocks;
    if (cells.length !== 1 || !cells[0].rich) throw Error('Enter one editable paragraph or LaTeX section heading.');
    const project = detail.id;
    const submit = $('new-cell').querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const created = await api('POST', `/api/projects/${project}/blocks`, {
        neighbor_id: selected.stableId, direction: $('new-cell-placement').value,
        kind: cells[0].kind, source: text, base_neighbor_revision: selected.revision
      });
      if (activeProject !== project) return;
      await refreshCurrent();
      $('add-cell').open = false;
      input.value = '';
      openBlock(created);
      say('Cell added.');
    } finally {
      submit.disabled = false;
    }
  }

  async function setBlockPolicy(action, body) {
    const block = selected;
    try {
      await api('POST', '/api/projects/' + detail.id + '/blocks/' + block.stableId + '/' + action, body);
      await refreshCurrent();
    } finally {
      renderBlockPolicy();
    }
  }

  function cellVisual() {
    if (!draft && !selected.rich) return null;
    return draft?.visualContent || editableCell(draft?.lastValid ?? selected.quote).block.rich;
  }

  function syncEditors(from) {
    if (from !== 'visual') {
      const content = visual && cellVisual();
      if (content) visual.setFromSource(content);
    }
    if (from !== 'source') source?.set(draft?.latex ?? selected.quote);
    const visualEditable = selected.rich && canPropose(selected) && !(draft?.error && draft.mode === 'source');
    if (visual && visual.isEditable !== Boolean(visualEditable)) visual.setEditable(Boolean(visualEditable), false);
    renderFormatting();
  }

  function mountEditors() {
    destroyEditors();
    const editable = selected.rich && canPropose(selected);
    const host = $('visual-host');
    const content = cellVisual();
    if (content) {
      visual = PaperColabEditors.visual(host, content, {
        onChange: content => editDraft('visual', content),
        onState: renderFormatting,
        onProtected() { say('Change protected LaTeX tokens in the source pane.'); }
      });
    } else {
      const preview = document.createElement('div');
      preview.className = 'math-preview';
      if (PaperColabEditors.renderMath(preview, selected.quote)) host.append(preview);
      else host.textContent = 'This cell preserves its original LaTeX.';
    }
    source = PaperColabEditors.source($('source-host'), draft?.latex ?? selected.quote, !editable,
      content => editDraft('source', content));
    syncEditors();
  }

  function renderFormatting() {
    const enabled = Boolean(visual?.isEditable);
    $('cell-format').hidden = !visual;
    for (const mark of ['bold', 'italic']) {
      const button = $('cell-' + mark);
      button.disabled = !enabled;
      button.setAttribute('aria-pressed', String(Boolean(visual?.isActive(mark))));
    }
  }

  function renderDraftTools() {
    const editable = selected?.rich && canPropose(selected);
    const stale = isStale(draft);
    $('propose-cell').hidden = !editable;
    $('propose-cell').disabled = !draft || stale || Boolean(draft.error) || submitting.has(draftKey(draft.blockId));
    $('discard-cell').hidden = !draft;
    $('recover-cell').hidden = !(editable && (stale || draft?.error));
    $('recover-cell').textContent = draft?.error ? 'Restore last valid LaTeX' : 'Use current revision as base';
    let status = '';
    if (draft && !editable) status = 'This cell is read-only. Your draft remains available.';
    else if (draft?.error) status = draft.error + (draft.mode === 'source' ? ' The visual pane shows the last valid version.' : '');
    else if (stale) status = 'The accepted cell changed while you were drafting.';
    else if (draft?.reconciling) status = 'Reconcile your draft with the current accepted LaTeX before proposing it.';
    else if (draft) status = 'Draft saved in this browser.';
    if (draft && storageUnavailable) status = (status === 'Draft saved in this browser.' ? '' : status + ' ') + 'Draft saved in this tab only.';
    $('cell-draft-status').textContent = status;
    $('comment-compose').hidden = !selected || !canComment();
    const compare = stale || Boolean(draft?.reconciling);
    $('draft-comparison').hidden = !compare;
    const comparison = compare ? selected?.quote || '' : '';
    if ($('current-source').textContent !== comparison) $('current-source').textContent = comparison;
    preview.refresh();
  }

  function updateDraftIndicator() {
    const button = [...$('blocks').children].find(button => button.dataset.block === selected?.stableId);
    if (button) button.querySelector('.cell-draft-indicator').hidden = !draft;
  }

  function renderDetachedDrafts() {
    const host = $('detached-drafts');
    const prefix = draftPrefix();
    const keys = new Set(draftMemory.keys());
    try {
      for (let index = 0; index < localStorage.length; index++) keys.add(localStorage.key(index));
    } catch { /* The current tab can still recover its drafts. */ }
    host.replaceChildren();
    for (const key of keys) {
      if (!key?.startsWith(prefix)) continue;
      const record = readDraft(key);
      if (!record) continue;
      const block = detail.blocks.find(block => block.stableId === record.blockId);
      if (block && !key.endsWith(':alternate')) continue;
      const row = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = block ? 'Earlier draft · ' + record.path : 'Saved draft · removed cell in ' + record.path;
      const content = document.createElement('pre');
      try {
        content.textContent = record.latex ?? (key.endsWith(':visual') ? legacyDraft(record, 'visual').latex : record.content);
        if (record.invalidLegacy) content.textContent = JSON.stringify(record.content, null, 2);
      } catch {
        content.textContent = JSON.stringify(record.content, null, 2);
      }
      row.append(summary, content);
      if (block?.rich && canPropose(block) && !record.invalidLegacy) {
        addButton(row, 'Open earlier draft', () => {
          openBlock(block);
          if (draft) throw new Error('Finish or discard the current cell draft before opening the earlier draft.');
          if (saveDraft(record)) storeDraft(key, null);
          mountEditors();
          renderDetachedDrafts();
        });
      }
      addButton(row, 'Discard saved draft', () => { storeDraft(key, null); renderDetachedDrafts(); });
      host.append(row);
    }
    host.hidden = !host.childElementCount;
  }

  function recoverSuggestion(item, block) {
    openBlock(block);
    if (draft) throw new Error('Finish or discard the current cell draft before recovering this suggestion.');
    saveDraft(candidateRecord({ ...baseFor(selected), before: item.before,
      projectRevision: item.base_revision, blockRevision: item.base_block_revision,
      reconciling: true }, 'source', item.after));
    mountEditors();
  }

  async function propose() {
    const record = draft;
    if (!record || record.error || isStale(record) || !canPropose(selected)) return;
    const key = draftKey(record.blockId);
    if (submitting.has(key)) return;
    const project = detail.id;
    const actor = me.id;
    submitting.add(key);
    renderDraftTools();
    try {
      const item = await api('POST', '/api/projects/' + project + '/suggestions', {
        block_id: record.blockId, base_revision: record.projectRevision, base_block_revision: record.blockRevision,
        before: record.before, after: record.latex, mode: record.mode
      });
      if (item.status === 'pending') {
        if (detail?.id === project && me?.id === actor && selected?.stableId === record.blockId && draft === record) {
          draft = null;
          mountEditors();
          updateDraftIndicator();
        }
        if (equal(readDraft(key), record)) storeDraft(key, null);
        say('Cell suggestion recorded.');
      } else {
        say('The suggestion could not be applied to its original revision. Your local draft was kept.');
      }
      await refreshCurrent();
    } finally {
      submitting.delete(key);
      if (detail) renderDraftTools();
    }
  }

  function endReply() {
    replyAnchor = null;
    $('comment').textContent = 'Comment on this cell';
    $('cancel-reply').hidden = true;
  }

  function beginReply(anchor, block) {
    openBlock(block);
    replyAnchor = anchor.id;
    $('comment').textContent = 'Post reply';
    $('cancel-reply').hidden = false;
    $('comment-body').focus();
  }

  async function sendComment() {
    const body = $('comment-body').value.trim();
    if (!body) throw new Error('Enter a comment first.');
    const project = detail.id;
    const block = selected;
    const replying = replyAnchor;
    $('comment').disabled = true;
    try {
      await api('POST', '/api/projects/' + project + '/comments', replying ?
        { anchor_id: replying, body } : { block_id: block.stableId, body });
      if (project === detail?.id && block.stableId === selected?.stableId && replying === replyAnchor) {
        if ($('comment-body').value.trim() === body) $('comment-body').value = '';
        endReply();
      }
      say(replying ? 'Reply posted.' : 'Comment anchored to this block.');
      await refreshCurrent();
    } finally {
      $('comment').disabled = false;
    }
  }

  async function signIn(token) {
    const desired = activeProject || requestedProject();
    if (demoMode && token === 'demo-quill') {
      await api('DELETE', '/api/session');
      demoToken = token;
      sessionStorage.setItem('papercolab-token', token);
    } else {
      await api('POST', '/api/session', { token });
      demoToken = '';
      sessionStorage.removeItem('papercolab-token');
      $('token').value = '';
    }
    await refresh(desired);
  }

  async function start() {
    const health = await api('GET', '/api/health');
    demoMode = health.demo === true;
    if (!demoMode) sessionStorage.removeItem('papercolab-token');
    try {
      await refresh(requestedProject());
    } catch (error) {
      if (error.status !== 401) throw error;
      if (demoMode) await signIn(sessionStorage.getItem('papercolab-token') || 'demo-ada');
      else signedOut();
    }
    $('demo-actor').hidden = !demoMode;
  }

  function requestedProject() {
    return new URLSearchParams(location.search).get('project') || sessionStorage.getItem('papercolab-project');
  }

  function act(work) {
    clear();
    Promise.resolve().then(work).catch(fail);
  }

  $('actor').replaceChildren(...demo.map(([name, value]) => new Option(name, value)));
  $('actor').onchange = () => act(() => signIn($('actor').value));
  $('use-token').onclick = () => act(() => signIn($('token').value.trim()));
  $('token').onkeydown = event => { if (event.key === 'Enter') $('use-token').click(); };
  $('sign-out').onclick = () => act(async () => {
    await api('DELETE', '/api/session');
    demoToken = '';
    sessionStorage.removeItem('papercolab-token');
    signedOut();
  });
  $('create').onclick = () => act(() => api('POST', '/api/projects', { title: $('new-title').value, starter: true }).then(project => refresh(project.id)));
  $('example').onclick = () => act(() => api('POST', '/api/projects', { title: 'Estuary field notes', example: true }).then(project => refresh(project.id)));
  $('import-zip').onclick = () => $('zip').click();
  $('zip').onchange = event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    act(async () => {
      const project = await api('POST', '/api/projects', { title: file.name.replace(/\.zip$/i, '') });
      await api('POST', '/api/projects/' + project.id + '/import', null, file);
      await refresh(project.id);
    });
  };
  $('file').onchange = () => act(() => showFile($('file').value));
  $('block-owner').onchange = () => act(() => setBlockPolicy('owner', { owner_id: $('block-owner').value || null }));
  $('block-ai').onchange = () => act(() => setBlockPolicy('ai', { allow_ai: $('block-ai').checked }));
  $('move-cell-up').onclick = () => act(() => moveCell(-1));
  $('move-cell-down').onclick = () => act(() => moveCell(1));
  $('new-cell').onsubmit = event => { event.preventDefault(); act(addCell); };
  for (const mark of ['bold', 'italic']) $('cell-' + mark).onclick = () => visual?.chain().focus().toggleMark(mark).run();
  $('propose-cell').onclick = () => act(propose);
  $('discard-cell').onclick = () => act(() => { saveDraft(null); mountEditors(); });
  $('recover-cell').onclick = () => act(() => {
    if (!draft) return;
    if (draft.error) editDraft('source', draft.lastValid);
    else if (isStale(draft)) saveDraft(candidateRecord({ ...baseFor(selected), reconciling: true }, 'source', draft.latex));
    syncEditors();
    $('source-host').querySelector('.cm-content')?.focus();
  });
  $('comment').onclick = () => act(sendComment);
  $('cancel-reply').onclick = endReply;
  $('link-claim').onclick = () => act(async () => {
    const claim = await api('POST', '/api/projects/' + detail.id + '/objects', { kind: 'claim', title: $('claim').value, body: $('claim').value });
    await api('POST', '/api/projects/' + detail.id + '/links', { claim_id: claim.id, evidence_id: $('evidence').value });
    say('Claim linked to the current evidence revision.');
    await openProject(detail.id);
  });
  $('add-object').onclick = () => act(async () => {
    const identifier = $('object-id').value.trim();
    const external = identifier ? { system: 'external', identifier, version: '1', access: 'as recorded', holding: 'reference' } : null;
    await api('POST', '/api/projects/' + detail.id + '/objects', { kind: $('object-kind').value, title: $('object-title').value, body: '', external });
    await openProject(detail.id);
  });
  $('add-decision').onclick = () => act(() => api('POST', '/api/projects/' + detail.id + '/decisions', { text: $('decision').value }).then(() => openProject(detail.id)));
  $('save-collection').onclick = () => act(async () => {
    await api('POST', '/api/collections', { name: $('collection-name').value, projects: [detail.id] });
    say('Collection saved.');
  });
  $('export').onclick = () => act(async () => {
    const payload = await api('GET', '/api/projects/' + detail.id + '/export');
    download(Uint8Array.from(atob(payload.zip_b64), char => char.charCodeAt(0)), detail.title + '.zip', 'application/zip');
  });
  $('release').onclick = () => act(() => api('POST', '/api/projects/' + detail.id + '/release').then(() => openProject(detail.id)).then(() => say('Release approved.')));
  $('save-policy').onclick = () => act(() => api('POST', '/api/admin/policy', { allow_ai: $('allow-ai').checked, retention_days: Number($('retention').value) }).then(policy => { $('allow-ai').checked = policy.allow_ai; say('Policy saved.'); }));
  $('backup').onclick = () => act(async () => {
    const payload = await api('GET', '/api/admin/backup');
    download(Uint8Array.from(atob(payload.zip_b64), char => char.charCodeAt(0)), 'papercolab-backup.sqlite', 'application/octet-stream');
  });
  $('run-search').onclick = () => act(async () => {
    const rows = await api('GET', '/api/search?q=' + encodeURIComponent($('search').value));
    const host = $('search-results');
    host.replaceChildren();
    for (const row of rows) {
      const item = document.createElement('p');
      item.textContent = row.project + ' · ' + row.kind + ' · ' + row.title;
      host.append(item);
    }
    if (!rows.length) host.textContent = 'No matching research objects.';
  });
  $('cost').onclick = () => act(async () => {
    const cost = await api('GET', '/api/admin/cost');
    $('cost-out').hidden = false;
    $('cost-out').textContent = JSON.stringify(cost, null, 2);
  });
  setInterval(() => { if (!document.hidden) syncCurrent(); }, 5000);
  window.addEventListener('online', syncCurrent);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncCurrent(); });
  act(start);
})();
