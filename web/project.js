/* global PaperColabBlocks, PaperColabEditors */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const demo = [['Ada', 'demo-ada'], ['Bao', 'demo-bao'], ['Iris', 'demo-iris'], ['Quill', 'demo-quill']];
  let token = sessionStorage.getItem('papercolab-token') || '';
  let workspaceView='manuscript';
  function setWorkspaceView(view){
    workspaceView=view;
    $('open').dataset.workspaceView=view;
    for(const button of $('workspace-nav').querySelectorAll('[data-workspace-tab]'))
      button.setAttribute('aria-pressed',String(button.dataset.workspaceTab===view));
  }
  for(const button of $('workspace-nav').querySelectorAll('[data-workspace-tab]')){
    button.onclick=()=>{
      if(busy)return;
      if((dirty||recovery)&&button.dataset.workspaceTab!=='manuscript'){
        say('Save or keep your local draft, or close the comparison, before switching workspace views.');return;
      }
      setWorkspaceView(button.dataset.workspaceTab);
    };
  }
  function clearProvision(){
    $('provision-id').value=$('provision-token').value='';
    $('show-provision-token').checked=false;$('provision-token').type='password';
    $('provision-result').hidden=true;
  }
  let me, projects = [], detail, fileText = '', selected, visual, source, draft = null, sourceDraft = '';
  let dirty = false, busy = false, polling = false, sourceDirty = false;
  let viewMode='focused', cellViews=new Map(), multiDrafts=new Map(), fileRevision=null;
  const B=PaperColabBlocks, E=PaperColabEditors;
  const isMulti=()=>viewMode!=='focused';
  let crdtModule=null;
  // Each page instance owns distinct records, even when a tab is duplicated.
  // A reload discovers prior records through the actor/project index.
  const draftSession=crypto.randomUUID(), localRecords=new Map();
  let writes=Promise.resolve(), storageFailed=false, recovery=null, recoveryGeneration=0;
  const store=globalThis.PaperColabDrafts;
  function storageMessage(message){$('draft-storage-status').textContent=message;}
  function enqueue(work){
    writes=writes.then(work).catch(error=>{
      storageFailed=true;
      storageMessage('Local draft storage failed. Keep this tab open and copy your work. '+error.message);
    });
    return writes;
  }
  function remember(base,after,mode,valid=true,extra=null){
    if(!$('durable-drafts').checked||!me||!detail||!base)return;
    const id=[me.id,detail.id,draftSession,base.stableId].join(':');
    if(after===base.quote&&valid&&!extra){forget(base);return;}
    const row={id:localRecords.get(id)?.id??crypto.randomUUID(),actor:me.id,project:detail.id,cell:base.stableId,path:base.path,
      version:base.version,before:base.quote,after,mode,valid,extra,
      updated:Date.now(),stamp:crypto.randomUUID()};
    localRecords.set(id,row);
    storageMessage('Saving draft on this browser…');
    enqueue(async()=>{await store.put(row);if(!storageFailed)storageMessage('Draft stored on this browser.');});
  }
  function forget(base){
    if(!me||!detail||!base)return Promise.resolve();
    const id=[me.id,detail.id,draftSession,base.stableId].join(':');
    const row=localRecords.get(id);
    if(!row)return Promise.resolve();
    localRecords.delete(id);
    return enqueue(async()=>{if(!await store.remove(row.id,row.stamp))throw Error('Draft record changed in another session.');});
  }
  async function discardCurrent(){
    const bases=isMulti()?[...multiDrafts.values()].map(x=>x.base):[selected];
    await Promise.all(bases.map(forget));
  }
  function closeRecovery(){
    recoveryGeneration++;recovery=null;
    $('recovery-detail').hidden=true;$('recovery-list').replaceChildren();
    $('recovery-base').textContent=$('recovery-local').textContent=$('recovery-remote').textContent='';
    $('recovery-result').value='';
    if(!busy)$('visual-host').inert=$('source-host').inert=$('hosted-cells').inert=false;
  }
  function mayCloseRecovery(){
    return !recovery||$('recovery-result').value===normalise(recovery.row.after)||
      window.confirm('Close this comparison and discard the reconciliation text? The original stored draft remains.');
  }
  async function listRecovery(){
    if(!me||!detail||!mayCloseRecovery())return;
    closeRecovery();
    const actor=me.id,project=detail.id,generation=++recoveryGeneration;
    await writes;
    const rows=await store.list(actor,project);
    if(generation!==recoveryGeneration||me?.id!==actor||detail?.id!==project)return;
    const host=$('recovery-list');host.replaceChildren();
    for(const row of rows){
      const button=document.createElement('button');button.type='button';button.className='secondary';
      button.textContent=row.path+' · cell '+row.cell.slice(0,8)+' · v'+row.version+' · '+new Date(row.updated).toLocaleString();
      button.onclick=()=>act(()=>compareRecovery(row),true,true);host.append(button);
    }
    if(!rows.length)host.textContent='No stored drafts for this project and signed-in account.';
  }
  async function compareRecovery(row,keepResult=false){
    if(!keepResult&&!mayCloseRecovery())return;
    const previous=keepResult?$('recovery-result').value:null;
    if(dirty)throw Error('Keep and close your active drafts, or save them, before reconciling a stored draft.');
    if(row.actor!==me.id||row.project!==detail.id)throw Error('Draft scope changed.');
    const latest=await api('GET','/api/projects/'+detail.id);
    const current=latest.blocks.find(b=>b.stableId===row.cell);
    recovery={row,current};
    $('recovery-base').textContent=row.before;
    $('recovery-local').textContent=row.extra?row.after+'\n\nUnapplied fields:\n'+JSON.stringify(row.extra,null,2):row.after;
    $('recovery-remote').textContent=current?.quote??'Cell missing from the current manuscript.';
    const matches=current&&current.version===row.version&&current.quote===row.before;
    $('recovery-note').textContent=!current?'Cell missing. Copy the draft or download it; it cannot be saved here.':
      matches?'Original version still matches. Review your local draft.':
      'Conflict: current version '+current.version+' differs from original version '+row.version+'. Reconcile explicitly; no automatic merge.';
    $('recovery-result').value=previous??normalise(row.after);
    const member=latest.members.find(m=>m.id===me.id);
    const allowed=Boolean(current&&['author','lead'].includes(member?.role));
    $('recovery-save').hidden=!allowed||me.kind!=='human'||(!current.rich&&!B.scientific(current.quote));
    $('recovery-propose').hidden=!allowed||!current.rich;
    $('recovery-detail').hidden=false;
  }
  async function resolveRecovery(action){
    if(!recovery||dirty)throw Error('Close active drafts before resolving.');
    const {row,current}=recovery;
    if(row.actor!==me.id||row.project!==detail.id||!current)throw Error('Draft is not in this project.');
    if(!window.confirm('Submit the reconciled text against the displayed current version?'))return;
    const eol=current.quote.match(/\r\n|\r|\n/)?.[0]??'\n';
    const typed=$('recovery-result').value;
    const after=typed===normalise(row.after)?row.after:typed.replace(/\n/g,eol);
    if(after===current.quote)throw Error('No change to the current manuscript. Discard the stored draft if finished.');
    const endpoint='/api/projects/'+detail.id;
    if(action==='direct'){
      if(!directAllowed())throw Error('Direct saves require a human author.');
      await saveCell(current,after,'source');
    }else{
      const latest=await api('GET',endpoint);
      const base=latest.blocks.find(b=>b.stableId===current.stableId);
      if(!base||base.version!==current.version||base.quote!==current.quote)throw Error('Cell changed again. Compare the draft again.');
      const response=await api('POST',endpoint+'/suggestions',{block_id:current.stableId,
        base_revision:latest.revision,before:current.quote,after,mode:'source'});
      if(response.status!=='pending')throw Error('Proposal is stale. Stored draft retained.');
    }
    // A failed deletion cannot undo an accepted server mutation. Report it
    // and leave the stored record available for explicit cleanup.
    try{if(!await store.remove(row.id,row.stamp))throw Error('Stored record changed; retained.');}
    catch(error){storageMessage('Server accepted the change, but local cleanup failed: '+error.message);}
    closeRecovery();await openProject(detail.id);await listRecovery();
    say(action==='direct'?'Reconciled cell saved.':'Reconciled cell submitted for review.');
  }
  let live=null, liveRetry=0, presenceTimer=null;
  function stopLive(){
    const old=live; live=null;
    old?.controller.abort();
    clearTimeout(presenceTimer);presenceTimer=null;
    $('live-status').textContent='';
    $('presence-list').replaceChildren();
  }
  function liveControl(){
    const supported=Boolean(me?.experimental_live&&detail);
    $('live-option').hidden=!supported;
    if(!supported){$('live-enabled').checked=false;stopLive();return;}
    if($('live-enabled').checked)ensureLive();
  }
  function renderPresence(rows){
    const host=$('presence-list');host.replaceChildren();
    for(const row of rows){
      const item=document.createElement('li');
      const block=detail?.blocks.find(b=>b.stableId===row.cell);
      item.textContent=row.name+' · '+(row.editing?'editing': 'viewing')+
        (block?' · '+block.kind+' · '+block.quote.replace(/\s+/g,' ').slice(0,55):'');
      host.append(item);
    }
    if(!rows.length){const item=document.createElement('li');item.textContent='No other connected sessions.';host.append(item);}
  }
  function presenceChanged(){
    if(!live?.session)return;
    clearTimeout(presenceTimer);
    presenceTimer=setTimeout(async()=>{
      const current=live;
      if(!current?.session||detail?.id!==current.project||token!==current.token)return;
      const cell=selected?.stableId??null;
      const editing=isMulti()?multiDrafts.has(cell):dirty;
      try{await api('POST','/api/projects/'+current.project+'/presence',{session:current.session,cell,editing});}
      catch(error){if(live===current)$('live-status').textContent='Live presence unavailable; revision sync remains available.';}
    },150);
  }
  function ensureLive(){
    if(!detail||!me?.experimental_live||!$('live-enabled').checked)return;
    if(live?.project===detail.id&&live.token===token)return;
    if(Date.now()<liveRetry)return;
    stopLive();
    const current={project:detail.id,token,controller:new AbortController(),session:null,connected:false,latest:null};
    live=current;
    $('live-status').textContent='Connecting live stream…';
    (async()=>{
      try{
        const res=await fetch('/api/projects/'+current.project+'/live',{
          headers:{authorization:'Bearer '+current.token},signal:current.controller.signal
        });
        if(res.status===401||res.status===403){current.denied=true;throw Error('Live access denied.');}
        if(!res.ok||!res.body)throw Error('Live stream unavailable.');
        const reader=res.body.getReader(),decoder=new TextDecoder();
        let pending='';
        for(;;){
          const {done,value}=await reader.read();
          if(done)break;
          if(live!==current)return;
          pending+=decoder.decode(value,{stream:true});
          if(pending.length>256000)throw Error('Live message exceeds limit.');
          let end;
          while((end=pending.indexOf('\n'))!==-1){
            const event=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);
            if(event.type==='hello'){
              current.session=event.session;current.connected=true;
              $('live-status').textContent='Live revision stream connected';
              presenceChanged();
            }else if(event.type==='state'){
              current.latest=event;renderPresence(event.presence);
              await applyLiveRevision();
            }else if(event.type==='closed'){
              current.denied=event.status===401||event.status===403||event.status===404;
              throw Error('Live session closed.');
            }
          }
        }
      }catch(error){
        if(live===current&&!current.controller.signal.aborted)$('live-status').textContent='Live stream interrupted; using revision polling.';
      }finally{
        if(live===current){
          live=null;liveRetry=Date.now()+1500;$('presence-list').replaceChildren();
          if(current.denied){
            $('live-enabled').checked=false;
            $('live-status').textContent='Live access revoked or unavailable. Local drafts retained.';
          }else $('live-status').textContent='Reconnecting; revision polling available.';
        }
      }
    })();
  }
  async function applyLiveRevision(){
    const current=live;
    if(!current?.connected||!current.latest||busy||polling||detail?.id!==current.project||token!==current.token)return;
    const revision=current.latest.revision;
    if(revision===detail.revision)return;
    if(recovery){$('sync-state').textContent='Remote revision '+revision+' available. Refresh the server comparison before reconciling.';return;}
    if(dirty){$('sync-state').textContent='Remote revision '+revision+' available. Your local draft is retained; save checks its cell version.';return;}
    busy=true;freeze(true);
    try{await openProject(current.project);}
    catch(error){fail(error);}
    finally{busy=false;freeze(false);}
  }
  function updateTransportControl(){
    const supported=Boolean(me?.experimental_crdt&&directAllowed());
    $('crdt-option').hidden=!supported;
    $('crdt-enabled').disabled=busy||!supported;
    if(!supported)$('crdt-enabled').checked=false;
  }
  function freeze(value) {
    $('visual-host').inert=$('source-host').inert=$('hosted-cells').inert=value||Boolean(recovery);
    for(const button of $('hosted-views').querySelectorAll('[data-view]'))button.disabled=value;
    $('file').disabled=value;
    $('actor').disabled=$('use-token').disabled=$('sign-out').disabled=value;
    $('workspace-nav').inert=value;
    $('provision-panel').inert=value;
    $('project-settings').inert=value;
    $('create-agent-task').disabled=value||!$('delegate-cell').options.length||!$('delegate-assistant').options.length;
    $('refresh-agent-tasks').disabled=value;
    $('workflow-panel').inert=value;
    $('experiment-panel').inert=value;
    $('durable-drafts').disabled=value||dirty;
    $('local-recovery').inert=value;
    updateTransportControl();
  }
  const normalise = value => value.replace(/\r\n?/g,'\n');
  function directAllowed() { return me?.kind === 'human' && ['author','lead'].includes(role()); }
  function draftState(value) {
    dirty=value;
    $('discard-local').disabled=!value;
    $('refresh-manuscript').disabled=value;
    $('hosted-draft-count').textContent=isMulti() ? multiDrafts.size+' unsaved cell'+(multiDrafts.size===1?'':'s') : '';
    $('durable-drafts').disabled=busy||dirty;
    $('keep-drafts').disabled=!dirty||!$('durable-drafts').checked;
    for(const button of $('hosted-cells').querySelectorAll('[data-structure]'))button.disabled=dirty;
    presenceChanged();
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
    cellViews.clear();multiDrafts.clear();localRecords.clear();$('hosted-cells').replaceChildren();
    $('visual-host').replaceChildren(); $('source-host').replaceChildren();
    sourceDirty=false; draftState(false);
  }

  async function refresh() {
    clear();
    me = await api('GET', '/api/me');
    $('project-create-tools').hidden=me.kind!=='human';
    $('project-search-tools').hidden=false;
    $('provision-panel').hidden=me.workspace_role!=='operator';
    $('welcome-message').textContent='Choose a project from the sidebar, create a new project, or import a LaTeX ZIP.';
    $('who').textContent = me.name + (me.workspace_role ? ' · ' + me.workspace_role : '') + ' · ' + me.kind;
    projects = await api('GET', '/api/projects');
    const list = $('project-list');
    list.replaceChildren();
    for (const project of projects) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'project-choice';
      button.dataset.projectId=project.id;
      button.textContent = project.title + ' · ' + project.role;
      button.onclick = () => { if(!dirty || window.confirm($('durable-drafts').checked?'Leave active drafts in local recovery and switch project?':'Discard your local cell draft?')) act(()=>openProject(project.id),true); };
      list.append(button);
    }
    $('operator-tools').hidden = me.workspace_role !== 'operator';
    if (detail) await openProject(detail.id);
  }

  async function openProject(id) {
    if(live&&live.project!==id)stopLive();
    if(detail?.id!==id){
      setWorkspaceView('manuscript');
      $('member-id').value='';
      clearProvision();
      $('delegate-instructions').value='';
      for(const key of ['experiment-title','experiment-objective','experiment-image','object-body'])$(key).value='';
      for(const key of ['workflow-title','workflow-objective','workflow-step-title','workflow-instructions','workflow-criteria'])$(key).value='';
      $('delegated-token').value='';$('delegated-credential').hidden=true;
      for(const option of $('delegate-context').options)option.selected=false;
    }
    closeRecovery();
    const incoming = await api('GET', '/api/projects/' + id);
    detail = incoming;
    updateTransportControl();
    $('open').hidden = false;
    $('workspace-welcome').hidden=true;
    for(const button of $('project-list').querySelectorAll('[data-project-id]'))
      button.setAttribute('aria-current',button.dataset.projectId===id?'true':'false');
    $('project-title').textContent = detail.title;
    $('project-title').dataset.id = detail.id;
    const ready = detail.readiness;
    $('review-count').textContent=ready.pending_suggestions?'('+ready.pending_suggestions+')':'';
    $('release').hidden=role()!=='lead'||me.kind!=='human';
    $('membership-form').hidden=role()!=='lead'||me.kind!=='human';
    $('readiness').textContent = ready.ready ? 'Ready for release.' :
      ready.pending_suggestions + ' pending suggestions, ' + ready.unresolved_anchors + ' unresolved anchors, ' + ready.open_decisions + ' open decisions.';
    const members = $('members');
    members.replaceChildren();
    for (const member of detail.members) {
      const row = document.createElement('div');
      row.className = 'person';
      row.textContent = member.name + ' · ' + member.kind + ' · ' + member.role;
      if(role()==='lead'&&me.kind==='human'&&member.id!==me.id){
        const remove=document.createElement('button');remove.type='button';remove.textContent='Remove';remove.className='text-button';
        remove.setAttribute('aria-label','Remove '+member.name+' from project');
        remove.onclick=()=>act(async()=>{
          if(!window.confirm('Remove this member from the project?'))return;
          await api('DELETE','/api/projects/'+detail.id+'/members/'+member.id);
          await openProject(detail.id);say('Project membership removed.');
        });row.append(remove);
      }
      members.append(row);
    }
    const files = detail.files.filter(file => file.is_text && /\.(tex|ltx)$/i.test(file.path));
    const select = $('file');
    const previous = select.value;
    select.replaceChildren();
    for (const file of files) select.append(new Option(file.path, file.path));
    select.value = files.some(file => file.path === previous) ? previous : (files.find(file => /methods/.test(file.path)) || files[0])?.path || '';
    renderQueue();
    renderAgentTasks();
    renderWorkflows();
    renderLibrary();
    renderExperiments();
    renderDecisions();
    renderReleases();
    if (select.value) await showFile(select.value);
    else destroyEditors();
    liveControl();presenceChanged();
  }

  function workflowOptions(){
    const chosen=(detail.workflows??[]).find(w=>w.id===$('workflow-select').value);
    const deps=$('workflow-dependencies'), prior=[...deps.selectedOptions].map(o=>o.value);
    deps.replaceChildren();
    for(const step of chosen?.steps??[])deps.append(new Option(step.position+'. '+step.title,step.id));
    for(const o of deps.options)o.selected=prior.includes(o.value);
    $('workflow-step-form').hidden=!chosen;
  }
  function renderWorkflows(){
    const host=$('workflow-list'), selector=$('workflow-select'), prior=selector.value;
    $('workflow-panel').hidden=me.kind!=='human';
    $('workflow-form').hidden=role()!=='lead'||me.kind!=='human';
    host.replaceChildren();selector.replaceChildren();
    for(const w of detail.workflows??[])selector.append(new Option(w.title,w.id));
    if([...selector.options].some(o=>o.value===prior))selector.value=prior;
    for(const [dest,src] of [['workflow-cell','delegate-cell'],['workflow-assistant','delegate-assistant'],['workflow-context','delegate-context']]){
      const target=$(dest),selected=[...target.selectedOptions].map(o=>o.value);
      target.replaceChildren(...[...$(src).options].map(o=>new Option(o.textContent,o.value)));
      if(selected.length)for(const option of target.options)option.selected=selected.includes(option.value);
    }
    workflowOptions();
    for(const w of detail.workflows??[]){
      const card=document.createElement('article'),title=document.createElement('h3'),objective=document.createElement('p');
      title.textContent=w.title+' · '+w.completed+'/'+w.steps.length+' evaluated';
      objective.textContent=w.objective;card.append(title,objective);
      for(const step of w.steps){
        const row=document.createElement('section');row.className='workflow-step';row.dataset.stepId=step.id;row.dataset.status=step.status;
        const heading=document.createElement('strong'),meta=document.createElement('p'),criteria=document.createElement('p');
        heading.textContent=step.position+'. '+step.title+' · '+step.status;
        meta.textContent='Depends on: '+(step.dependencies.map(id=>w.steps.find(s=>s.id===id)?.title??id).join(', ')||'None');
        criteria.textContent='Acceptance criteria: '+step.criteria;
        row.append(heading,meta,criteria);
        for(const attempt of step.attempts){
          const history=document.createElement('p');
          history.className='muted';
          history.textContent='Attempt '+attempt.position+' · '+attempt.task_status+(attempt.outcome?' · '+attempt.outcome+': '+attempt.assessment:'');
          row.append(history);
        }
        const endpoint='/api/projects/'+detail.id+'/workflows/'+w.id+'/steps/'+step.id;
        if(role()==='lead'&&['ready','retry'].includes(step.status)){
          const launch=document.createElement('button');launch.type='button';launch.textContent='Launch step';
          launch.onclick=()=>act(async()=>{
            const result=await api('POST',endpoint+'/launch');
            await openProject(detail.id);
            $('delegated-task-id').textContent=result.task.id;
            $('delegated-token').value=result.token;$('delegated-credential').hidden=false;
            $('delegated-credential').scrollIntoView({block:'nearest'});
            say('Workflow step delegated. Copy its restricted credential now.');
          });
          row.append(launch);
        }
        if(canDecide()&&step.status==='evaluation'){
          const label=document.createElement('label'), assessment=document.createElement('textarea');
          label.textContent='Evaluate against acceptance criteria';
          assessment.rows=3;assessment.maxLength=4000;assessment.setAttribute('aria-label','Assessment for '+step.title);
          label.append(assessment);row.append(label);
          for(const [outcome,name] of [['pass','Pass evaluation'],['revise','Request another attempt']]){
            const button=document.createElement('button');button.type='button';button.textContent=name;
            button.onclick=()=>act(async()=>{
              await api('POST',endpoint+'/evaluate',{attempt_id:step.attempts.at(-1).id,outcome,assessment:assessment.value});
              await openProject(detail.id);say('Workflow evaluation recorded.');
            });
            row.append(button);
          }
        }
        card.append(row);
      }
      host.append(card);
    }
    if(!host.children.length)host.textContent='No research workflows yet.';
  }
  $('workflow-select').onchange=workflowOptions;
  $('create-workflow').onclick=()=>act(async()=>{
    const result=await api('POST','/api/projects/'+detail.id+'/workflows',{
      title:$('workflow-title').value,objective:$('workflow-objective').value});
    await openProject(detail.id);
    $('workflow-select').value=result.id;workflowOptions();
    $('workflow-title').value=$('workflow-objective').value='';
    say('Research workflow created.');
  });
  $('add-workflow-step').onclick=()=>act(async()=>{
    await api('POST','/api/projects/'+detail.id+'/workflows/'+$('workflow-select').value+'/steps',{
      title:$('workflow-step-title').value,block_id:$('workflow-cell').value,assignee_id:$('workflow-assistant').value,
      instructions:$('workflow-instructions').value,criteria:$('workflow-criteria').value,
      context_ids:[...$('workflow-context').selectedOptions].map(o=>o.value),
      dependencies:[...$('workflow-dependencies').selectedOptions].map(o=>o.value)
    });
    await openProject(detail.id);
    for(const id of ['workflow-step-title','workflow-instructions','workflow-criteria'])$(id).value='';
    for(const o of $('workflow-dependencies').options)o.selected=false;
    say('Workflow step added.');
  });
  function renderAgentTasks(){
    const form=$('delegate-form'),host=$('agent-task-list');
    $('delegated-credential').hidden=true;$('delegated-token').value='';
    $('agent-tasks').hidden=me.kind!=='human';
    form.hidden=me.kind!=='human'||role()!=='lead';
    host.replaceChildren();
    const cell=$('delegate-cell'),assistant=$('delegate-assistant'),context=$('delegate-context');
    const priorCell=cell.value,priorAssistant=assistant.value,priorContext=[...context.selectedOptions].map(x=>x.value);
    cell.replaceChildren();assistant.replaceChildren();context.replaceChildren();
    for(const b of detail.blocks.filter(b=>b.rich))cell.append(new Option(b.path+' · '+b.quote.replace(/\s+/g,' ').slice(0,80),b.stableId));
    for(const m of detail.members.filter(m=>m.kind==='assistant'&&['author','lead'].includes(m.role)))assistant.append(new Option(m.name,m.id));
    for(const obj of detail.objects)context.append(new Option(obj.kind+' · '+obj.title+' · v'+obj.revision,obj.id));
    if([...cell.options].some(x=>x.value===priorCell))cell.value=priorCell;
    if([...assistant.options].some(x=>x.value===priorAssistant))assistant.value=priorAssistant;
    for(const option of context.options)option.selected=priorContext.includes(option.value);
    $('create-agent-task').disabled=!cell.options.length||!assistant.options.length;
    for(const task of detail.agent_tasks??[]){
      const row=document.createElement('article'),heading=document.createElement('strong'),info=document.createElement('p');
      const assignee=detail.members.find(m=>m.id===task.assignee_id)?.name??'Former assistant';
      heading.textContent=assignee+' · '+task.status;
      info.textContent=task.instructions+' · '+task.context_refs.length+' context objects · base cell v'+task.cell_version;
      row.append(heading,info);
      if(task.rationale){const reason=document.createElement('p');reason.textContent='Proposal rationale: '+task.rationale;row.append(reason);}
      if(role()==='lead'&&['open','expired','pending'].includes(task.status)){
        const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel delegated task';
        cancel.onclick=()=>act(async()=>{
          if(!window.confirm('Cancel this task and reject its pending proposal, if any?'))return;
          await api('POST','/api/projects/'+detail.id+'/agent-tasks/'+task.id+'/cancel');
          await openProject(detail.id);say('Delegated task cancelled.');
        });
        row.append(cancel);
      }
      host.append(row);
    }
    if(!host.children.length)host.textContent='No delegated tasks yet.';
  }
  $('create-agent-task').onclick=()=>act(async()=>{
    const instructions=$('delegate-instructions').value;
    const result=await api('POST','/api/projects/'+detail.id+'/agent-tasks',{
      block_id:$('delegate-cell').value,assignee_id:$('delegate-assistant').value,
      instructions,context_ids:[...$('delegate-context').selectedOptions].map(x=>x.value)
    });
    await openProject(detail.id);
    $('delegate-instructions').value='';
    $('delegated-task-id').textContent=result.task.id;
    $('delegated-token').value=result.token;$('delegated-credential').hidden=false;
    say('Delegated task created. Copy its restricted credential now; it is not shown again.');
  });
  $('hide-delegated-token').onclick=()=>{$('delegated-token').value='';$('delegated-credential').hidden=true;};
  $('refresh-agent-tasks').onclick=()=>act(async()=>{
    await openProject(detail.id);
    say('Task and review status refreshed.');
  });
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
      const task=(detail.agent_tasks??[]).find(t=>t.suggestion_id===item.id);
      if(task){
        const reason=document.createElement('p');reason.textContent='Delegated task · '+task.rationale+' · '+task.context_refs.length+' pinned context objects';
        const before=document.createElement('pre'),after=document.createElement('pre');
        before.style.whiteSpace=after.style.whiteSpace='pre-wrap';
        before.textContent='Original source:\n'+item.before;after.textContent='Proposed source:\n'+item.after;
        row.append(reason,before,after);
      }
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

  function outputPreview(output){
    const section=document.createElement('section');section.className='structured-output';
    const title=document.createElement('h4');title.textContent=output.title;section.append(title);
    if(output.kind==='table'){
      const table=document.createElement('table');table.style.borderCollapse='collapse';
      const head=table.createTHead().insertRow();
      for(const col of output.columns){const th=document.createElement('th');th.textContent=col;head.append(th);}
      const body=table.createTBody();
      for(const row of output.rows){const tr=body.insertRow();for(const cell of row)tr.insertCell().textContent=cell===null?'':String(cell);}
      const wrap=document.createElement('div');wrap.style.overflow='auto';wrap.style.maxHeight='260px';wrap.append(table);section.append(wrap);
    }else{
      // Construct SVG from numeric coordinates only. No imported markup.
      const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
      svg.setAttribute('viewBox','0 0 360 230');svg.setAttribute('width','100%');svg.setAttribute('role','img');
      svg.setAttribute('aria-label',output.title+'; '+output.x_label+' versus '+output.y_label);
      const x=output.points.map(p=>p[0]),y=output.points.map(p=>p[1]),xmin=Math.min(...x),xmax=Math.max(...x),ymin=Math.min(...y),ymax=Math.max(...y);
      const scale=(v,min,max)=>max===min?0.5:(v-min)/(max-min);
      const coords=output.points.map(([a,b])=>[55+280*scale(a,xmin,xmax),185-155*scale(b,ymin,ymax)]);
      const line=document.createElementNS(ns,'path');line.setAttribute('d','M55 30 V185 H335');line.setAttribute('stroke','currentColor');line.setAttribute('fill','none');svg.append(line);
      const series=document.createElementNS(ns,'polyline');series.setAttribute('points',coords.map(p=>p.join(',')).join(' '));series.setAttribute('fill','none');series.setAttribute('stroke','#326a99');series.setAttribute('stroke-width','2');svg.append(series);
      for(const [a,b] of coords){const dot=document.createElementNS(ns,'circle');dot.setAttribute('cx',a);dot.setAttribute('cy',b);dot.setAttribute('r','2.5');dot.setAttribute('fill','#326a99');svg.append(dot);}
      const text=(a,b,value,anchor='start')=>{const node=document.createElementNS(ns,'text');node.setAttribute('x',a);node.setAttribute('y',b);node.setAttribute('font-size','11');node.setAttribute('text-anchor',anchor);node.textContent=value;svg.append(node);};
      text(52,25,String(ymax),'end');text(52,185,String(ymin),'end');text(55,200,String(xmin));text(335,200,String(xmax),'end');text(195,219,output.x_label.slice(0,40),'middle');
      const label=document.createElement('p');label.textContent=output.y_label+' vs '+output.x_label;
      const values=document.createElement('details'),summary=document.createElement('summary');
      summary.textContent='Exact chart data';values.append(summary);
      const table=document.createElement('table'),head=table.createTHead().insertRow(),body=table.createTBody();
      for(const col of [output.x_label,output.y_label]){const th=document.createElement('th');th.textContent=col;head.append(th);}
      for(const pair of output.points){const row=body.insertRow();for(const value of pair)row.insertCell().textContent=String(value);}
      const scroll=document.createElement('div');scroll.style.maxHeight='260px';scroll.style.overflow='auto';scroll.append(table);values.append(scroll);
      section.append(svg,label,values);
    }
    return section;
  }
  function renderExperiments(){
    const host=$('experiment-list');
    $('experiment-panel').hidden=me.kind!=='human';
    $('experiment-form').hidden=!directAllowed();
    host.replaceChildren();
    for(const [id,kind] of [['experiment-code','code'],['experiment-datasets','dataset']]){
      const select=$(id),prior=[...select.selectedOptions].map(o=>o.value);
      select.replaceChildren();
      for(const obj of detail.objects.filter(o=>o.kind===kind&&!Object.keys(o.external).length))
        select.append(new Option(obj.title+' · v'+obj.revision,obj.id));
      if(prior.length)for(const option of select.options)option.selected=prior.includes(option.value);
    }
    for(const experiment of detail.experiments??[]){
      const row=document.createElement('article');row.className='experiment-record';
      const heading=document.createElement('strong'),info=document.createElement('p'),hash=document.createElement('p');
      heading.textContent=experiment.title+' · '+experiment.status;
      info.textContent=experiment.language+' · '+experiment.inputs.length+' pinned inputs'+(experiment.execution_status?' · '+experiment.execution_status:'');
      hash.textContent='Bundle SHA-256: '+experiment.bundle_sha256;hash.style.overflowWrap='anywhere';
      row.append(heading,info,hash);
      const endpoint='/api/projects/'+detail.id+'/experiments/'+experiment.id;
      const add=(name,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=name;b.onclick=()=>act(fn);row.append(b);};
      if(directAllowed()){
        add('Download experiment bundle',async()=>{
          const bundle=await api('GET',endpoint+'/bundle');
          download(JSON.stringify(bundle,null,2),'experiment-'+experiment.id+'.json','application/json');
        });
        if(experiment.status==='planned'){
          const input=document.createElement('input');input.type='file';input.accept='.json,application/json';
          input.setAttribute('aria-label','Runner receipt for '+experiment.title);row.append(input);
          add('Import runner receipt',async()=>{
            const file=input.files[0];
            if(!file||file.size>1024*1024)throw Error('Choose a bounded JSON runner receipt.');
            await api('POST',endpoint+'/receipt',JSON.parse(await file.text()));
            await openProject(detail.id);say('Receipt recorded; human review required.');
          });
        }
      }
      if(experiment.log!==null){
        const pre=document.createElement('pre');pre.textContent=experiment.log;pre.style.whiteSpace='pre-wrap';pre.style.maxHeight='240px';pre.style.overflow='auto';row.append(pre);
      }
      for(const output of experiment.outputs??[]){
        const panel=outputPreview(output);
        panel.dataset.outputName=output.name;
        const button=document.createElement('button');button.type='button';button.textContent='Download output JSON';
        button.onclick=()=>download(JSON.stringify(output,null,2),output.name+'.json','application/json');
        panel.append(button);
        if(experiment.status==='accepted'&&directAllowed()){
          const select=document.createElement('select');select.setAttribute('aria-label','Manuscript cell for '+output.name);select.style.maxWidth='100%';
          for(const b of detail.blocks)select.append(new Option(b.path+' · '+b.kind+' · '+b.quote.replace(/\s+/g,' ').slice(0,60),b.stableId));
          const link=document.createElement('button');link.type='button';link.textContent='Link output to cell';link.disabled=!select.options.length;
          link.onclick=()=>act(async()=>{
            const b=detail.blocks.find(x=>x.stableId===select.value);
            if(!b)throw Error('Choose a manuscript cell.');
            await api('POST',endpoint+'/output-links',{output_name:output.name,block_id:b.stableId,version:b.version});
            await openProject(detail.id);say('Reviewed output linked to manuscript cell version.');
          });
          panel.append(select,link);
        }
        for(const link of (detail.experiment_output_links??[]).filter(x=>x.experiment_id===experiment.id&&x.output_name===output.name)){
          const info=document.createElement('p');info.textContent='Linked cell '+link.block_id.slice(0,8)+' · v'+link.cell_version+' · '+link.status;panel.append(info);
        }
        row.append(panel);
      }
      if(experiment.status==='review'&&canDecide()){
        const assessment=document.createElement('textarea');assessment.rows=3;assessment.maxLength=4000;
        assessment.setAttribute('aria-label','Experiment assessment for '+experiment.title);row.append(assessment);
        if(experiment.execution_status==='succeeded')add('Accept as run evidence',async()=>{
          if(!window.confirm('Accept this user-supplied receipt as reviewed evidence? It is not independently attested.'))return;
          await api('POST',endpoint+'/review',{outcome:'accepted',assessment:assessment.value});
          await openProject(detail.id);say('Run evidence registered.');
        });
        add('Reject receipt',async()=>{
          await api('POST',endpoint+'/review',{outcome:'rejected',assessment:assessment.value});
          await openProject(detail.id);say('Receipt rejected.');
        });
      }
      if(experiment.assessment){const assessment=document.createElement('p');assessment.textContent='Review: '+experiment.assessment;row.append(assessment);}
      host.append(row);
    }
    if(!host.children.length)host.textContent='No registered experiments.';
  }
  $('create-experiment').onclick=()=>act(async()=>{
    await api('POST','/api/projects/'+detail.id+'/experiments',{
      title:$('experiment-title').value,objective:$('experiment-objective').value,
      language:$('experiment-language').value,image:$('experiment-image').value.trim(),code_id:$('experiment-code').value,
      dataset_ids:[...$('experiment-datasets').selectedOptions].map(o=>o.value)
    });
    await openProject(detail.id);$('experiment-title').value=$('experiment-objective').value='';say('Experiment registered with immutable inputs.');
  });
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
    fileText = payload.text;fileRevision=payload.revision;
    // Text and catalogue come from one server-side snapshot.
    detail.blocks=detail.blocks.filter(b=>b.path!==path).concat(payload.blocks);
    const host = $('blocks');
    host.replaceChildren();
    const blocks = detail.blocks.filter(block => block.path === path);
    for (const block of blocks) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'secondary';
      button.dataset.stableId=block.stableId;
      button.dataset.kind=block.kind;
      button.textContent = (block.kind === 'heading' ? 'Heading' : block.rich ? 'Paragraph' : 'Preserved') + ' · ' + block.quote.replace(/\s+/g, ' ').slice(0, 80);
      button.onclick = () => {
        if(busy||recovery) return;
        if(isMulti()) {selected=block;presenceChanged();cellViews.get(block.stableId)?.element.scrollIntoView({block:'nearest'});}
        else if(!dirty || window.confirm($('durable-drafts').checked?'Leave active draft in local recovery and switch cell?':'Discard your local cell draft?')) selectBlock(block);
      };
      const outputLinks=(detail.experiment_output_links??[]).filter(x=>x.block_id===block.stableId);
      if(outputLinks.length)button.textContent+=' · '+outputLinks.length+' computational link'+(outputLinks.length===1?'':'s');
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
    header.append(label);
    for(const link of (detail.experiment_output_links??[]).filter(x=>x.block_id===base.stableId)){
      const evidence=document.createElement('span');evidence.textContent=' · '+link.output_name+' ('+link.status+')';header.append(evidence);
    }
    element.append(header);
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
      await forget(base);
      multiDrafts.delete(base.stableId);
      if(!multiDrafts.size) {draftState(false);await openProject(detail.id);}
      else {replaceHostedCell(base);draftState(true);}
    },true));
    save.hidden=!directAllowed()||!editable;propose.hidden=!allowed||!base.rich;discard.hidden=!editable;
    function changed(value,kind,error='',extra=null) {
      after=value;mode=kind;valid=!error;
      if(error||value!==base.quote) multiDrafts.set(base.stableId,{base,after,mode,valid});
      else multiDrafts.delete(base.stableId);
      const has=multiDrafts.has(base.stableId);
      save.disabled=propose.disabled=!has||!valid;discard.disabled=!has;
      status.textContent=error||(has?'Local draft · not saved':'');
      element.classList.toggle('has-draft',has);
      remember(base,value,kind,valid,extra);
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
            } catch(error){changed(after,'source',error.message,{fields:fields.inputs.map((el,i)=>({name:spec.fields[i].name,value:el.value}))});}
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
    if(viewMode==='cells'&&directAllowed()&&base.rich){
      const add=(name,action,options={})=>{
        const button=make(name,()=>{
          if(dirty||busy||recovery)return;
          const opts=typeof options==='function'?options():options;
          if(['delete','merge-next','convert'].includes(action)&&!window.confirm(name+'? This changes the accepted manuscript.'))return;
          act(()=>changeStructure(base,action,opts));
        });
        button.dataset.structure=action;button.onmousedown=event=>event.preventDefault();
        button.disabled=dirty;
      };
      add('Add paragraph','insert',{kind:'paragraph'});
      add('Add heading','insert',{kind:'heading'});
      add('Add equation','insert',{kind:'equation'});
      add('Add table','insert',{kind:'table'});
      add('Add list','insert',{kind:'list'});
      add('Move up','move-up');add('Move down','move-down');
      if(base.kind==='paragraph'){
        add('Split at caret','split',()=>({offset:editor?.state.selection.from-1}));
        add('Merge next','merge-next');
      }
      add(base.kind==='heading'?'Make paragraph':'Make heading','convert');
      add('Delete cell','delete');
    }
    save.disabled=propose.disabled=discard.disabled=true;
    element.addEventListener('focusin',()=>{selected=base;presenceChanged();});
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
  async function changeStructure(base,action,options){
    if(!directAllowed()||dirty||recovery)throw Error('Save or close local drafts first.');
    const result=await api('POST','/api/projects/'+detail.id+'/blocks/'+base.stableId+'/structure',
      {revision:fileRevision,version:base.version,action,options});
    selected=result.selectedId?{stableId:result.selectedId,path:base.path}:null;
    await openProject(detail.id);
    cellViews.get(result.selectedId)?.element.scrollIntoView({block:'nearest'});
    say('Cell structure updated at revision '+result.revision+'.');
  }
  async function saveCell(base,after,mode){
    const endpoint='/api/projects/'+detail.id+'/blocks/'+base.stableId;
    if(!$('crdt-enabled').checked||!base.rich){
      return {result:await api('POST',endpoint+'/edit',{version:base.version,before:base.quote,after,mode}),transport:'direct'};
    }
    // No silent fallback: a failed CRDT save leaves the draft intact.
    if(!me?.experimental_crdt||!directAllowed())throw Error('Experimental collaboration is unavailable.');
    const state=await api('GET',endpoint+'/crdt');
    if(state.version!==base.version||state.quote!==base.quote)
      throw Error('This cell changed remotely. Your draft has not been saved.');
    crdtModule??=await import('/experimental/crdt-browser.js');
    const update=crdtModule.incrementalUpdate(state,base.quote,after);
    const result=await api('POST',endpoint+'/crdt',{version:state.version,epoch:state.epoch,update});
    return {result,transport:'Yjs'};
  }
  async function commitHostedCell(base, action) {
    const entry=multiDrafts.get(base.stableId);
    if(!entry?.valid) return;
    if(action==='direct'&&!directAllowed()) return;
    let next=base,transport='direct';
    if(action==='direct') {
      const saved=await saveCell(base,entry.after,entry.mode);
      next=saved.result.block;transport=saved.transport;
    } else {
      const result=await api('POST','/api/projects/'+detail.id+'/suggestions',
        {block_id:base.stableId,base_revision:detail.revision,before:base.quote,after:entry.after,mode:entry.mode});
      if(result.status!=='pending') throw new Error('Proposal is stale; your cell draft is retained.');
    }
    await forget(base);
    multiDrafts.delete(base.stableId);
    if(!multiDrafts.size) {draftState(false);await openProject(detail.id);}
    else {
      detail.blocks=detail.blocks.map(b=>b.stableId===next.stableId?next:b);
      replaceHostedCell(next);draftState(true);
    }
    say(action==='direct'?'Cell saved via '+transport+'; other local drafts retained.':'Cell proposal recorded; other local drafts retained.');
  }
  for(const button of $('hosted-views').querySelectorAll('[data-view]')) button.onclick=()=>{
    if(busy||recovery||button.dataset.view===viewMode) return;
    if(dirty&&!window.confirm($('durable-drafts').checked?'Leave active drafts in local recovery and switch view?':'Discard all local cell drafts and switch view?')) return;
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
            sourceDraft=after; sourceDirty=false;
            remember(block,after,'visual');
            draftState(after!==block.quote);
          } catch(error) {fail(error);}
        },
        onState() {},
        onProtected() { say('Change citations and maths from the source proposal.'); }
      });
    } else $('visual-host').textContent = 'This block stays as original LaTeX.';
    source = PaperColabEditors.source($('source-host'), PaperColabBlocks.current(parsed, local), (!block.rich && !scientific) || (!directAllowed() && !block.rich), value => {
      sourceDraft = value; sourceDirty=true;
      visual?.setEditable(false,false);
      const eol=block.quote.match(/\r\n|\r|\n/)?.[0]??fileText.match(/\r\n|\r|\n/)?.[0]??'\n';
      remember(block,value.replace(/\n/g,eol),'source',false);
      draftState(true);
    });
    sourceDraft = PaperColabBlocks.current(parsed, local);
    presenceChanged();
  }

  async function saveDirect() {
    if (!selected || !directAllowed() || !dirty) return;
    const eol=selected.quote.match(/\r\n|\r|\n/)?.[0] ?? fileText.match(/\r\n|\r|\n/)?.[0] ?? '\n';
    const after=sourceDirty ? source.value().replace(/\n/g,eol) : sourceDraft;
    const saved=await saveCell(selected,after,sourceDirty?'source':'visual');
    await forget(selected);
    draftState(false);
    await openProject(detail.id);
    say('Cell saved via '+saved.transport+'. Other sessions will receive the revision.');
  }
  async function poll() {
    if($('live-enabled').checked&&me?.experimental_live){
      ensureLive();
      if(live?.connected){await applyLiveRevision();return;}
    }
    if(!detail || busy || polling) return;
    const id=detail.id, revision=detail.revision, credential=token;
    polling=true;
    try {
      const state=await api('GET','/api/projects/'+id+'/revision');
      if(busy || detail?.id!==id || token!==credential || detail.revision!==revision) return;
      if(state.revision!==revision) {
        if(recovery)$('sync-state').textContent='Remote revision '+state.revision+' available. Refresh the server comparison before reconciling.';
        else if(dirty) $('sync-state').textContent='Remote revision '+state.revision+' available. Your local draft is retained; save checks its cell version.';
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
    const response=await api('POST', '/api/projects/' + detail.id + '/suggestions', {
      block_id: selected.stableId, base_revision: detail.revision, before: selected.quote, after, mode
    });
    if(response.status!=='pending')throw Error('Proposal is stale. Local draft retained.');
    await forget(selected);
    draftState(false);
    say(mode === 'visual' ? 'Visual suggestion recorded.' : 'Source suggestion recorded.');
    await openProject(detail.id);
  }

  function act(work, allowDraft=false, allowRecovery=false) {
    clear();
    if(busy) {say('Synchronisation in progress; try again.'); return;}
    if(recovery&&!allowRecovery){say('Close the local draft comparison before another workspace action.');return;}
    if(dirty && !allowDraft) {say('Save, propose or discard the local cell draft before this action.');return;}
    busy=true;
    freeze(true);
    Promise.resolve().then(work).catch(fail).finally(()=>{
      busy=false;freeze(false);
    });
  }

  $('actor').replaceChildren(...demo.map(([name, value]) => new Option(name, value)));
  $('actor').value = token;
  $('token').value = '';
  function changeToken(next) {
    if(busy || recovery || (dirty && !window.confirm($('durable-drafts').checked?'Leave active drafts in local recovery and switch account?':'Discard your local cell draft?'))) {$('actor').value=token;return;}
    act(async()=>{
      const previous=detail?.id;
      stopLive();$('live-enabled').checked=false;
      closeRecovery();$('durable-drafts').checked=false;storageMessage('');storageFailed=false;
      $('delegated-token').value='';$('delegated-credential').hidden=true;$('delegate-instructions').value='';
      for(const key of ['experiment-title','experiment-objective','experiment-image','object-body'])$(key).value='';
      for(const key of ['workflow-title','workflow-objective','workflow-step-title','workflow-instructions','workflow-criteria'])$(key).value='';
      destroyEditors(); detail=null; selected=null; fileText='';
      $('crdt-enabled').checked=false;updateTransportControl();
      $('open').hidden=true;$('workspace-welcome').hidden=false;
      for(const id of ['project-title','readiness','members','releases','blocks','queue','agent-task-list','workflow-list','experiment-list','library','links','decisions','audit','cost-out','review-count','sync-state','block-label','delegated-task-id','file','delegate-cell','delegate-assistant','delegate-context','workflow-select','workflow-cell','workflow-assistant','workflow-context','workflow-dependencies','experiment-code','experiment-datasets','evidence'])$(id).replaceChildren();
      delete $('project-title').dataset.id;
      for(const id of ['comment-body','claim','decision','object-title','object-id','member-id','search','account-name'])$(id).value='';
      $('cost-out').hidden=true;
      $('project-list').replaceChildren();$('search-results').replaceChildren();
      $('project-create-tools').hidden=$('project-search-tools').hidden=$('provision-panel').hidden=true;
      clearProvision();me=null;projects=[];
      $('who').textContent='Signed out';
      $('welcome-message').textContent='Sign in with your local access token to get started.';
      token=next;$('token').value='';$('actor').value=token;
      sessionStorage.removeItem('papercolab-token');
      if(!token)return;
      try{await refresh();sessionStorage.setItem('papercolab-token',token);}
      catch(error){token='';$('actor').value='';throw error;}
      if(projects.some(p=>p.id===previous)) await openProject(previous);
    },true);
  }
  $('actor').onchange = () => changeToken($('actor').value);
  $('use-token').onclick = () => changeToken($('token').value.trim());
  $('sign-out').onclick=()=>changeToken('');
  $('provision-account').onclick=()=>act(async()=>{
    clearProvision();
    const account=await api('POST','/api/admin/actors',{name:$('account-name').value.trim(),kind:$('account-kind').value});
    $('provision-id').value=account.id;$('provision-token').value=account.token;
    $('provision-result').hidden=false;$('account-name').value='';
    say('Account created. Copy its credential securely before clearing it.');
  });
  $('show-provision-token').onchange=()=>{$('provision-token').type=$('show-provision-token').checked?'text':'password';};
  $('hide-provision').onclick=clearProvision;
  $('add-member').onclick=()=>act(async()=>{
    const id=$('member-id').value.trim();
    if(!id||id===me.id)throw Error('Enter another local account ID.');
    await api('POST','/api/projects/'+detail.id+'/members',{actor_id:id,role:$('member-role').value});
    $('member-id').value='';await openProject(detail.id);say('Project membership updated.');
  });
  $('create').onclick = () => act(() => api('POST', '/api/projects', { title: $('new-title').value }).then(project => openProject(project.id)).then(refresh));
  $('example').onclick = () => act(() => api('POST', '/api/projects', { title: 'Estuary field notes', example: true }).then(project => openProject(project.id)).then(refresh));
  $('zip').onchange = event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    act(async () => {
      const project = await api('POST', '/api/projects', { title: file.name.replace(/\.zip$/i, '') });
      await api('POST', '/api/projects/' + project.id + '/import', null, file);
      await openProject(project.id);await refresh();
    });
  };
  $('file').onchange = () => {
    if(busy || recovery || (dirty && !window.confirm($('durable-drafts').checked?'Leave active drafts in local recovery and switch file?':'Discard your local cell drafts?'))) {$('file').value=selected?.path??'';return;}
    act(()=>showFile($('file').value),true);
  };
  $('save-direct').onclick=()=>act(saveDirect,true);
  $('discard-local').onclick=()=>act(async()=>{await discardCurrent();await openProject(detail.id);},true);
  $('durable-drafts').onchange=()=>{
    if($('durable-drafts').checked){
      storageFailed=false;
      storageMessage('Local recovery enabled. Drafts remain on this browser until saved or removed.');
    }else storageMessage('New local storage disabled. Existing stored drafts can still be removed from recovery.');
  };
  $('keep-drafts').onclick=()=>act(async()=>{
    await writes;
    if(storageFailed)throw Error('Local storage failed; copy your draft before leaving.');
    const bases=isMulti()?[...multiDrafts.values()].map(x=>x.base):[selected];
    if(!bases.length||bases.some(base=>!base||![...localRecords.values()].some(r=>r.actor===me.id&&r.project===detail.id&&r.cell===base.stableId)))
      throw Error('Not all active drafts have a local recovery record.');
    await openProject(detail.id);await listRecovery();say('Drafts kept locally. Select a stored draft to reconcile.');
  },true);
  $('list-recovery').onclick=()=>act(listRecovery,true,true);
  $('recovery-save').onclick=()=>act(()=>resolveRecovery('direct'),false,true);
  $('recovery-propose').onclick=()=>act(()=>resolveRecovery('proposal'),false,true);
  $('recovery-refresh').onclick=()=>act(()=>compareRecovery(recovery.row,true),false,true);
  $('recovery-close').onclick=()=>{if(mayCloseRecovery())closeRecovery();};
  $('recovery-download').onclick=()=>{
    if(recovery)download(JSON.stringify(recovery.row,null,2),'papercolab-local-draft.json','application/json');
  };
  $('recovery-remove').onclick=()=>act(async()=>{
    if(!recovery||!window.confirm('Permanently remove this local draft?'))return;
    const row=recovery.row;
    if(!await store.remove(row.id,row.stamp))throw Error('Stored record changed; reopen the list.');
    closeRecovery();await listRecovery();
  },false,true);

  $('refresh-manuscript').onclick=()=>act(()=>openProject(detail.id));
  window.addEventListener('beforeunload',event=>{if(dirty||(recovery&&$('recovery-result').value!==normalise(recovery.row.after))){event.preventDefault();event.returnValue='';}});
  $('live-enabled').onchange=()=>{if($('live-enabled').checked)ensureLive();else stopLive();};
  window.addEventListener('pagehide',stopLive);
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
    await api('POST', '/api/projects/' + detail.id + '/objects', { kind: $('object-kind').value, title: $('object-title').value, body: $('object-body').value, external });
    $('object-body').value='';
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
  act(async()=>{
    const response=await fetch('/api/health');
    const health=await response.json();
    $('demo-account').hidden=!health.demo;
    if(!token&&health.demo)token='demo-ada';
    $('actor').value=token;
    if(token){
      try{await refresh();sessionStorage.setItem('papercolab-token',token);}
      catch(error){
        token='';sessionStorage.removeItem('papercolab-token');$('actor').value='';
        $('who').textContent='Signed out';$('project-create-tools').hidden=$('project-search-tools').hidden=$('provision-panel').hidden=true;
        throw error;
      }
    }else $('who').textContent='Signed out';
  });
})();
