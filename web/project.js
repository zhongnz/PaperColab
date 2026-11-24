/* global PaperColabBlocks, PaperColabEditors */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const demo = [['Ada', 'demo-ada'], ['Bao', 'demo-bao'], ['Iris', 'demo-iris'], ['Quill', 'demo-quill']];
  let token = sessionStorage.getItem('papercolab-token') || 'demo-ada';
  let me, projects = [], detail, fileText = '', selected, visual, source, draft = null, sourceDraft = '';
  let dirty = false, busy = false, polling = false, sourceDirty = false;
  const normalise = value => value.replace(/\r\n?/g,'\n');
  function directAllowed() { return me?.kind === 'human' && ['author','lead'].includes(role()); }
  function draftState(value) {
    dirty=value;
    $('discard-local').disabled=!value;
    $('refresh-manuscript').disabled=value;
  }

  function say(message) { $('status').textContent = message || ''; }
  function fail(error) { $('error').hidden = false; $('error').textContent = error.message || String(error); }
  function clear() { $('error').hidden = true; $('error').textContent = ''; }

  async function api(method, path, body, raw) {
    const headers = { authorization: 'Bearer ' + token };
    if (!raw && body) headers['content-type'] = 'application/json';
    if (raw) headers['content-type'] = 'application/zip';
    const response = await fetch(path, { method, headers, body: raw || (body ? JSON.stringify(body) : undefined) });
    const payload = await response.json();
    if (!response.ok) { const error=new Error(payload.error || 'The request failed.'); error.status=response.status; throw error; }
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

  function destroyEditors() {
    visual?.destroy(); source?.destroy(); visual = source = null; draft = null; sourceDraft = '';
    $('visual-host').replaceChildren(); $('source-host').replaceChildren();
    sourceDirty=false; draftState(false);
  }

  async function refresh() {
    clear();
    me = await api('GET', '/api/me');
    $('who').textContent = me.name + (me.workspace_role ? ' · ' + me.workspace_role : '') + ' · ' + me.kind;
    projects = await api('GET', '/api/projects');
    const list = $('project-list');
    list.replaceChildren();
    for (const project of projects) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'text-button';
      button.textContent = project.title + ' · ' + project.role;
      button.onclick = () => { if(!dirty || window.confirm('Discard your local cell draft?')) act(()=>openProject(project.id)); };
      list.append(button);
    }
    $('operator-tools').hidden = me.workspace_role !== 'operator';
    if (detail) await openProject(detail.id);
  }

  async function openProject(id) {
    const incoming = await api('GET', '/api/projects/' + id);
    detail = incoming;
    $('open').hidden = false;
    $('project-title').textContent = detail.title;
    $('project-title').dataset.id = detail.id;
    const ready = detail.readiness;
    $('readiness').textContent = ready.ready ? 'Ready for release.' :
      ready.pending_suggestions + ' pending suggestions, ' + ready.unresolved_anchors + ' unresolved anchors, ' + ready.open_decisions + ' open decisions.';
    const members = $('members');
    members.replaceChildren();
    for (const member of detail.members) {
      const row = document.createElement('div');
      row.className = 'person';
      row.textContent = member.name + ' · ' + member.kind + ' · ' + member.role;
      members.append(row);
    }
    const files = detail.files.filter(file => file.is_text && /\.(tex|ltx)$/i.test(file.path));
    const select = $('file');
    const previous = select.value;
    select.replaceChildren();
    for (const file of files) select.append(new Option(file.path, file.path));
    select.value = files.some(file => file.path === previous) ? previous : (files.find(file => /methods/.test(file.path)) || files[0])?.path || '';
    renderQueue();
    renderLibrary();
    renderDecisions();
    renderReleases();
    if (select.value) await showFile(select.value);
    else destroyEditors();
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
      const change = document.createElement('p');
      change.className = 'muted';
      change.textContent = item.after.slice(0, 180);
      row.append(title, change);
      if (item.status === 'pending' && canDecide() && me.kind === 'human') {
        const accept = document.createElement('button');
        accept.type = 'button'; accept.className = 'primary'; accept.textContent = 'Accept';
        accept.onclick = () => act(() => api('POST', '/api/projects/' + detail.id + '/suggestions/' + item.id + '/accept').then(refresh).then(() => say('Suggestion accepted.')));
        const reject = document.createElement('button');
        reject.type = 'button'; reject.className = 'secondary'; reject.textContent = 'Reject';
        reject.onclick = () => act(() => api('POST', '/api/projects/' + detail.id + '/suggestions/' + item.id + '/reject').then(refresh).then(() => say('Suggestion rejected.')));
        row.append(accept, reject);
      }
      queue.append(row);
    }
  }

  function renderLibrary() {
    const library = $('library');
    library.replaceChildren();
    const evidence = $('evidence');
    evidence.replaceChildren();
    for (const object of detail.objects) {
      const row = document.createElement('p');
      row.textContent = object.kind + ' · ' + object.title + (object.external.identifier ? ' · ' + object.external.system + ':' + object.external.identifier : '');
      library.append(row);
      if (object.kind !== 'claim') evidence.append(new Option(object.title, object.id));
    }
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

  async function showFile(path) {
    const payload = await api('GET', '/api/projects/' + detail.id + '/file?path=' + encodeURIComponent(path));
    fileText = payload.text;
    const host = $('blocks');
    host.replaceChildren();
    const blocks = detail.blocks.filter(block => block.path === path);
    for (const block of blocks) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'secondary';
      button.textContent = (block.kind === 'heading' ? 'Heading' : block.rich ? 'Paragraph' : 'Preserved') + ' · ' + block.quote.replace(/\s+/g, ' ').slice(0, 80);
      button.onclick = () => { if(!dirty || window.confirm('Discard your local cell draft?')) selectBlock(block); };
      host.append(button);
    }
    const current = blocks.find(block => block.stableId === selected?.stableId) || blocks.find(block => block.rich && block.kind === 'paragraph') || blocks[0];
    if (current) selectBlock(current);
  }

  function selectBlock(block) {
    selected = block;
    destroyEditors();
    const root = Boolean(detail.files.find(file => file.path === block.path)?.is_root);
    const parsed = PaperColabBlocks.parseFile(fileText, { root });
    const local = parsed.blocks.find(item => item.from === block.from && item.to === block.to);
    const line = fileText.slice(0, block.from).split(/\r\n|\r|\n/).length;
    $('block-label').textContent = block.path + ' · line ' + line + ' · ' + (block.rich ? 'editable' : 'preserved LaTeX') + (block.owner_id ? ' · owned' : '');
    $('propose-visual').hidden = !block.rich;
    $('propose-source').hidden = !block.rich;
    const scientific = !block.rich && PaperColabBlocks.scientific(block.quote);
    $('save-direct').hidden = !directAllowed() || (!block.rich && !scientific);
    $('sync-state').textContent = 'Revision ' + detail.revision + ' · cell version ' + block.version;
    if (!local) { $('block-label').textContent += ' · the stored range no longer matches this text'; return; }
    if (block.rich) {
      visual = PaperColabEditors.visual($('visual-host'), PaperColabBlocks.rich(parsed, local), {
        onChange(content) {
          draft = content;
          try {
            PaperColabBlocks.editVisual(parsed,local,content);
            const after=PaperColabBlocks.current(parsed,local);
            source?.set(after);
            sourceDraft=after; sourceDirty=false; draftState(after!==block.quote);
          } catch(error) {fail(error);}
        },
        onState() {},
        onProtected() { say('Change citations and maths from the source proposal.'); }
      });
    } else $('visual-host').textContent = 'This block stays as original LaTeX.';
    source = PaperColabEditors.source($('source-host'), PaperColabBlocks.current(parsed, local), (!block.rich && !scientific) || (!directAllowed() && !block.rich), value => {
      sourceDraft = value; sourceDirty=true;
      visual?.setEditable(false,false);
      draftState(value!==normalise(block.quote));
    });
    sourceDraft = PaperColabBlocks.current(parsed, local);
  }

  async function saveDirect() {
    if (!selected || !directAllowed() || !dirty) return;
    const eol=selected.quote.match(/\r\n|\r|\n/)?.[0] ?? fileText.match(/\r\n|\r|\n/)?.[0] ?? '\n';
    const after=sourceDirty ? source.value().replace(/\n/g,eol) : sourceDraft;
    await api('POST','/api/projects/'+detail.id+'/blocks/'+selected.stableId+'/edit',{
      version:selected.version,before:selected.quote,after,mode:sourceDirty?'source':'visual'
    });
    draftState(false);
    await openProject(detail.id);
    say('Cell saved directly. Other sessions will receive the revision.');
  }
  async function poll() {
    if(!detail || busy || polling || document.hidden) return;
    const id=detail.id, revision=detail.revision, credential=token;
    polling=true;
    try {
      const state=await api('GET','/api/projects/'+id+'/revision');
      if(busy || detail?.id!==id || token!==credential || detail.revision!==revision) return;
      if(state.revision!==revision) {
        if(dirty) $('sync-state').textContent='Remote revision '+state.revision+' available. Your local draft is retained; save checks its cell version.';
        else await openProject(id);
      }
    } catch(error) {
      $('sync-state').textContent=error.status===403?'Access revoked or unavailable. Local draft retained.':'Sync unavailable. Local draft retained.';
    } finally {polling=false;}
  }
  async function propose(mode) {
    if (!selected?.rich) return;
    const root = Boolean(detail.files.find(file => file.path === selected.path)?.is_root);
    const parsed = PaperColabBlocks.parseFile(fileText, { root });
    const local = parsed.blocks.find(item => item.from === selected.from && item.to === selected.to);
    let after = selected.quote;
    if (mode === 'visual') {
      if (!draft || sourceDirty) throw new Error('Change the visual text first, or submit the source draft.');
      PaperColabBlocks.editVisual(parsed, local, draft);
      after = PaperColabBlocks.current(parsed, local);
    } else {
      const value = source ? source.value() : sourceDraft;
      PaperColabBlocks.editSource(parsed, local, value);
      after = PaperColabBlocks.current(parsed, local);
    }
    await api('POST', '/api/projects/' + detail.id + '/suggestions', {
      block_id: selected.stableId, base_revision: detail.revision, before: selected.quote, after, mode
    });
    draftState(false);
    say(mode === 'visual' ? 'Visual suggestion recorded.' : 'Source suggestion recorded.');
    await openProject(detail.id);
  }

  function act(work) {
    clear();
    if(busy || polling) {say('Synchronisation in progress; try again.'); return;}
    busy=true;
    Promise.resolve().then(work).catch(fail).finally(()=>{busy=false;});
  }

  $('actor').replaceChildren(...demo.map(([name, value]) => new Option(name, value)));
  $('actor').value = token;
  $('token').value = token;
  $('actor').onchange = () => { if(dirty && !window.confirm('Discard your local cell draft?')) {$('actor').value=token;return;} token = $('actor').value; sessionStorage.setItem('papercolab-token', token); $('token').value = token; act(refresh); };
  $('use-token').onclick = () => { if(dirty && !window.confirm('Discard your local cell draft?')) return; token = $('token').value.trim(); sessionStorage.setItem('papercolab-token', token); act(refresh); };
  $('create').onclick = () => act(() => api('POST', '/api/projects', { title: $('new-title').value }).then(project => openProject(project.id)).then(refresh));
  $('example').onclick = () => act(() => api('POST', '/api/projects', { title: 'Estuary field notes', example: true }).then(project => openProject(project.id)));
  $('zip').onchange = event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    act(async () => {
      const project = await api('POST', '/api/projects', { title: file.name.replace(/\.zip$/i, '') });
      await api('POST', '/api/projects/' + project.id + '/import', null, file);
      await openProject(project.id);
    });
  };
  $('file').onchange = () => {
    if(dirty && !window.confirm('Discard your local cell draft?')) {$('file').value=selected.path;return;}
    act(()=>showFile($('file').value));
  };
  $('save-direct').onclick=()=>act(saveDirect);
  $('discard-local').onclick=()=>act(()=>openProject(detail.id));
  $('refresh-manuscript').onclick=()=>act(()=>openProject(detail.id));
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  setInterval(poll,2500);
  $('propose-visual').onclick = () => act(() => propose('visual'));
  $('propose-source').onclick = () => act(() => propose('source'));
  $('comment').onclick = () => act(async () => {
    const anchor = await api('POST', '/api/projects/' + detail.id + '/anchors', { block_id: selected.stableId });
    await api('POST', '/api/projects/' + detail.id + '/comments', { anchor_id: anchor.id, body: $('comment-body').value });
    say('Comment anchored to this block.');
    await openProject(detail.id);
  });
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
  $('allow-ai').checked = true;
  act(refresh);
})();
