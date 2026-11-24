/* global PaperColabBlocks, PaperColabEditors */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const demo = [['Ada', 'demo-ada'], ['Bao', 'demo-bao'], ['Iris', 'demo-iris'], ['Quill', 'demo-quill']];
  let token = sessionStorage.getItem('papercolab-token') || 'demo-ada';
  let me, projects = [], detail, fileText = '', selected, visual, source, draft = null, sourceDraft = '';
  let dirty = false, busy = false, polling = false, sourceDirty = false;
  let viewMode='focused', cellViews=new Map(), multiDrafts=new Map();
  const B=PaperColabBlocks, E=PaperColabEditors;
  const isMulti=()=>viewMode!=='focused';
  function freeze(value) {
    $('visual-host').inert=$('source-host').inert=$('hosted-cells').inert=value;
  }
  const normalise = value => value.replace(/\r\n?/g,'\n');
  function directAllowed() { return me?.kind === 'human' && ['author','lead'].includes(role()); }
  function draftState(value) {
    dirty=value;
    $('discard-local').disabled=!value;
    $('refresh-manuscript').disabled=value;
    $('hosted-draft-count').textContent=isMulti() ? multiDrafts.size+' unsaved cell'+(multiDrafts.size===1?'':'s') : '';
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
    for(const entry of cellViews.values()) entry.destroy();
    cellViews.clear();multiDrafts.clear();$('hosted-cells').replaceChildren();
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
      button.onclick = () => { if(!dirty || window.confirm('Discard your local cell draft?')) act(()=>openProject(project.id),true); };
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
    // Text and catalogue come from one server-side snapshot.
    detail.blocks=detail.blocks.filter(b=>b.path!==path).concat(payload.blocks);
    const host = $('blocks');
    host.replaceChildren();
    const blocks = detail.blocks.filter(block => block.path === path);
    for (const block of blocks) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'secondary';
      button.textContent = (block.kind === 'heading' ? 'Heading' : block.rich ? 'Paragraph' : 'Preserved') + ' · ' + block.quote.replace(/\s+/g, ' ').slice(0, 80);
      button.onclick = () => {
        if(busy) return;
        if(isMulti()) {selected=block;cellViews.get(block.stableId)?.element.scrollIntoView({block:'nearest'});}
        else if(!dirty || window.confirm('Discard your local cell draft?')) selectBlock(block);
      };
      host.append(button);
    }
    const current = blocks.find(block => block.stableId === selected?.stableId) || blocks.find(block => block.rich && block.kind === 'paragraph') || blocks[0];
    if(isMulti()) {selected=current;renderMulti(blocks);}
    else if (current) selectBlock(current); else {selected=null;destroyEditors();}
  }

  function updateView() {
    $('hosted-cells').hidden=!isMulti();
    $('focused-cell').hidden=isMulti();
    for(const button of $('hosted-views').querySelectorAll('[data-view]'))
      button.setAttribute('aria-pressed',String(button.dataset.view===viewMode));
  }

  function mountHostedCell(base) {
    const element=document.createElement('section');element.className='manuscript-cell cell-'+base.kind;
    element.dataset.stableId=base.stableId;
    const header=document.createElement('div');header.className='cell-header';
    const label=document.createElement('span'), status=document.createElement('p');
    status.className='cell-status';status.setAttribute('role','status');
    const model=base.kind==='raw'?B.scientific(base.quote):null;
    label.textContent=(model?.type??base.kind)+' · version '+base.version+(base.owner_id?' · owned':'');
    header.append(label);element.append(header);
    const content=document.createElement('div');content.className='cell-content';element.append(content);
    const controls=document.createElement('div');controls.className='cell-operations';element.append(controls,status);
    const allowed=['author','lead'].includes(role());
    const editable=allowed&&(base.rich||Boolean(model&&directAllowed()));
    let editor=null, fields=null, after=base.quote, mode='visual', valid=true;
    const area=document.createElement('textarea');area.className='hosted-source';
    area.setAttribute('aria-label','LaTeX cell '+base.stableId);area.value=normalise(base.quote);area.rows=4;area.hidden=true;
    area.readOnly=!editable;area.spellcheck=false;element.append(area);
    const make=(name,click)=>{const button=document.createElement('button');button.type='button';button.textContent=name;button.onclick=click;controls.append(button);return button;};
    const toggle=make('LaTeX',()=>{area.hidden=!area.hidden;toggle.setAttribute('aria-expanded',String(!area.hidden));});
    toggle.setAttribute('aria-expanded','false');
    const save=make('Save cell',()=>act(()=>commitHostedCell(base,'direct'),true));
    const propose=make('Propose cell',()=>act(()=>commitHostedCell(base,'proposal'),true));
    const discard=make('Discard cell draft',()=>act(async()=>{
      multiDrafts.delete(base.stableId);
      if(!multiDrafts.size) {draftState(false);await openProject(detail.id);}
      else {replaceHostedCell(base);draftState(true);}
    },true));
    save.hidden=!directAllowed()||!editable;propose.hidden=!allowed||!base.rich;discard.hidden=!editable;
    function changed(value,kind,error='') {
      after=value;mode=kind;valid=!error;
      if(error||value!==base.quote) multiDrafts.set(base.stableId,{base,after,mode,valid});
      else multiDrafts.delete(base.stableId);
      const has=multiDrafts.has(base.stableId);
      save.disabled=propose.disabled=!has||!valid;discard.disabled=!has;
      status.textContent=error||(has?'Local draft · not saved':'');
      element.classList.toggle('has-draft',has);
      draftState(multiDrafts.size>0);
    }
    function renderContent(value) {
      editor?.destroy();editor=null;fields=null;content.replaceChildren();
      const parsed=B.parseFile(value), local=parsed.blocks[0];
      if(base.rich&&local?.rich) {
        editor=E.visual(content,B.rich(parsed,local),{
          onChange(json){
            try {
              B.editVisual(parsed,local,json);
              const next=B.current(parsed,local);
              // If a source draft was applied locally first, retain source
              // attribution (protected tokens may have intentionally changed).
              area.value=normalise(next);changed(next,mode==='source'?'source':'visual');
            } catch(error){changed(after,mode,error.message);}
          },onState(){},onProtected(){status.textContent='Edit protected tokens in LaTeX.';}
        });
        editor.view.dom.setAttribute('aria-label','Visual cell '+base.stableId);
        editor.setEditable(editable,false);
      } else if(model&&B.scientific(value)) {
        const spec=B.scientific(value);
        fields=E.scientificFields(content,spec);
        for(const input of fields.inputs) {
          input.readOnly=!editable;
          input.addEventListener('input',()=>{
            try {
              const values=fields.inputs.map((el,i)=>el.value===normalise(spec.fields[i].value)?spec.fields[i].value:
                el.value.replace(/\n/g,spec.fields[i].value.match(/\r\n|\r|\n/)?.[0]??'\n'));
              const next=B.scientificEdit(value,values);
              area.value=normalise(next);changed(next,'source');
            } catch(error){changed(after,'source',error.message);}
          });
        }
      } else {
        const pre=document.createElement('pre');pre.textContent=value;content.append(pre);
      }
    }
    renderContent(base.quote);
    const apply=make('Apply LaTeX draft',()=>{
      const eol=base.quote.match(/\r\n|\r|\n/)?.[0]??fileText.match(/\r\n|\r|\n/)?.[0]??'\n';
      const next=area.value.replace(/\n/g,eol);
      try {
        if(base.rich) {
          const parsed=B.parseFile(base.quote);B.editSource(parsed,parsed.blocks[0],next);
        } else if(!model||B.scientific(next)?.type!==model.type) throw new Error('Keep the same supported scientific cell type.');
        mode='source';renderContent(next);changed(next,'source');apply.disabled=true;
      } catch(error){changed(next,'source',error.message);}
    });
    apply.hidden=!editable;apply.disabled=true;
    area.addEventListener('input',()=>{
      editor?.setEditable(false,false);
      if(fields) for(const input of fields.inputs) input.readOnly=true;
      apply.disabled=false;changed(area.value,'source','Apply or discard the LaTeX draft first.');
    });
    save.disabled=propose.disabled=discard.disabled=true;
    element.addEventListener('focusin',()=>{selected=base;});
    return {element,destroy:()=>editor?.destroy()};
  }
  function replaceHostedCell(base) {
    const old=cellViews.get(base.stableId), next=mountHostedCell(base);
    old.element.replaceWith(next.element);old.destroy();cellViews.set(base.stableId,next);
  }
  function renderMulti(blocks) {
    destroyEditors();updateView();
    const host=$('hosted-cells');host.className='manuscript-surface '+viewMode;
    $('sync-state').textContent='Revision '+detail.revision+' · '+blocks.length+' cells';
    for(const base of blocks) {
      const entry=mountHostedCell(base);cellViews.set(base.stableId,entry);host.append(entry.element);
    }
  }
  async function commitHostedCell(base, action) {
    const entry=multiDrafts.get(base.stableId);
    if(!entry?.valid) return;
    if(action==='direct'&&!directAllowed()) return;
    let next=base;
    if(action==='direct') {
      const result=await api('POST','/api/projects/'+detail.id+'/blocks/'+base.stableId+'/edit',
        {version:base.version,before:base.quote,after:entry.after,mode:entry.mode});
      next=result.block;
    } else {
      const result=await api('POST','/api/projects/'+detail.id+'/suggestions',
        {block_id:base.stableId,base_revision:detail.revision,before:base.quote,after:entry.after,mode:entry.mode});
      if(result.status!=='pending') throw new Error('Proposal is stale; your cell draft is retained.');
    }
    multiDrafts.delete(base.stableId);
    if(!multiDrafts.size) {draftState(false);await openProject(detail.id);}
    else {
      detail.blocks=detail.blocks.map(b=>b.stableId===next.stableId?next:b);
      replaceHostedCell(next);draftState(true);
    }
    say(action==='direct'?'Cell saved; other local drafts retained.':'Cell proposal recorded; other local drafts retained.');
  }
  for(const button of $('hosted-views').querySelectorAll('[data-view]')) button.onclick=()=>{
    if(busy||button.dataset.view===viewMode) return;
    if(dirty&&!window.confirm('Discard all local cell drafts and switch view?')) return;
    act(async()=>{viewMode=button.dataset.view;updateView();await showFile($('file').value);},true);
  };

  function selectBlock(block) {
    selected = block;
    destroyEditors();updateView();
    const root = Boolean(detail.files.find(file => file.path === block.path)?.is_root);
    const parsed = PaperColabBlocks.parseFile(fileText, { root });
    const local = parsed.blocks.find(item => item.from === block.from && item.to === block.to && PaperColabBlocks.current(parsed,item)===block.quote);
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
      draftState(true);
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
    if(!detail || busy || polling) return;
    const id=detail.id, revision=detail.revision, credential=token;
    polling=true;
    try {
      const state=await api('GET','/api/projects/'+id+'/revision');
      if(busy || detail?.id!==id || token!==credential || detail.revision!==revision) return;
      if(state.revision!==revision) {
        if(dirty) $('sync-state').textContent='Remote revision '+state.revision+' available. Your local draft is retained; save checks its cell version.';
        else {
          // Lock editing during the refresh, after checking for any draft
          // created while the revision request was in flight.
          busy=true;
          freeze(true);
          try {await openProject(id);}
          finally {busy=false;freeze(false);}
        }
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
      const eol=selected.quote.match(/\r\n|\r|\n/)?.[0] ?? fileText.match(/\r\n|\r|\n/)?.[0] ?? '\n';
      const value = sourceDirty ? source.value().replace(/\n/g,eol) : sourceDraft;
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

  function act(work, allowDraft=false) {
    clear();
    if(busy) {say('Synchronisation in progress; try again.'); return;}
    if(dirty && !allowDraft) {say('Save, propose or discard the local cell draft before this action.');return;}
    busy=true;
    freeze(true);
    Promise.resolve().then(work).catch(fail).finally(()=>{
      busy=false;freeze(false);
    });
  }

  $('actor').replaceChildren(...demo.map(([name, value]) => new Option(name, value)));
  $('actor').value = token;
  $('token').value = token;
  function changeToken(next) {
    if(busy || (dirty && !window.confirm('Discard your local cell draft?'))) {$('actor').value=token;return;}
    act(async()=>{
      const previous=detail?.id;
      destroyEditors(); detail=null; selected=null; fileText='';
      $('open').hidden=true;
      token=next;sessionStorage.setItem('papercolab-token',token);$('token').value=token;$('actor').value=token;
      await refresh();
      if(projects.some(p=>p.id===previous)) await openProject(previous);
    },true);
  }
  $('actor').onchange = () => changeToken($('actor').value);
  $('use-token').onclick = () => changeToken($('token').value.trim());
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
    if(busy || (dirty && !window.confirm('Discard your local cell drafts?'))) {$('file').value=selected?.path??'';return;}
    act(()=>showFile($('file').value),true);
  };
  $('save-direct').onclick=()=>act(saveDirect,true);
  $('discard-local').onclick=()=>act(()=>openProject(detail.id),true);
  $('refresh-manuscript').onclick=()=>act(()=>openProject(detail.id));
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  setInterval(poll,2500);
  $('propose-visual').onclick = () => act(() => propose('visual'),true);
  $('propose-source').onclick = () => act(() => propose('source'),true);
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
  updateView();
  $('allow-ai').checked = true;
  act(refresh);
})();
