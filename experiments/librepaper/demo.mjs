import {LoroDoc,LoroText} from '../../build/upstream/web/src/lib/loro-web.js';
import * as anchors from '../../build/upstream/web/src/lib/anchors.js';
import * as tracking from '../../build/upstream/web/src/lib/track-changes.js';
import {cellSession} from './cells.mjs';

const source = await fetch('../../examples/estuary/sections/methods.tex').then(r=>r.text());
const a = new LoroDoc(), b = new LoroDoc(), fileId = crypto.randomUUID();
a.getMap('files').setContainer(fileId,new LoroText()).insert(0,source);
a.getMap('paths').set(fileId,'sections/methods.tex');
a.commit();
const session = (doc,author) => cellSession({doc,fileId,anchors,tracking,model:PaperColabBlocks,actor:{who:author,author}});
const first = session(a,'Alice');
const cells = first.parse().blocks.filter(block=>block.rich).map(block=>({id:first.attach(block),label:block.kind}));
b.import(a.export({mode:'snapshot'}));
const status = document.querySelector('#status'), connected = document.querySelector('#connected');
const panes = [];
function exchange() {
  if (connected.checked) {
    a.import(b.export({mode:'update',from:a.oplogVersion()}));
    b.import(a.export({mode:'update',from:b.oplogVersion()}));
    status.textContent = 'Collaborators synced';
  } else status.textContent = 'Editing independently';
  for (const pane of panes) pane.refresh();
}
function pane(name, client, visual) {
  const el = document.createElement('article');
  el.innerHTML = '<h2></h2><label>Cell<select></select></label><div class="surface"></div><button class="primary">Apply edit</button> <button class="text-button">Discard draft</button>';
  el.querySelector('h2').textContent = name + (visual ? ' · Visual editor' : ' · LaTeX editor');
  document.querySelector('#panes').append(el);
  const select = el.querySelector('select'), host = el.querySelector('.surface');
  const [apply, discard] = el.querySelectorAll('button');
  for(const cell of cells) select.add(new Option(cell.label,cell.id));
  select.value = cells.find(c=>c.label==='paragraph').id;
  let snapshot, editor, dirty = false, draft;
  function change(value) { dirty = true; draft = value; select.disabled = true; apply.disabled = discard.disabled = false; }
  function show() {
    dirty = false; select.disabled = false; apply.disabled = discard.disabled = true;
    editor?.destroy(); host.replaceChildren();
    snapshot = client.read(select.value);
    if (!snapshot) { host.textContent = 'Cell needs review.'; editor = null; return; }
    editor = visual ? PaperColabEditors.visual(host,snapshot.block.rich,{onChange:change,onState:()=>{},onProtected:()=>{status.textContent='Change citations through the source pane.';}})
      : PaperColabEditors.source(host,snapshot.source,false,change);
  }
  select.onchange = discard.onclick = show;
  apply.onclick = () => {
    try {
      if (visual) client.visual(snapshot,draft); else client.markup(snapshot,draft);
      show(); exchange();
    } catch(error) { status.textContent = error.message; }
  };
  show();
  return { refresh() { if (!dirty && client.read(select.value)?.source !== snapshot?.source) show(); } };
}
panes.push(pane('Alice',first,true),pane('Bob',session(b,'Bob'),false));
connected.onchange = exchange;
exchange();
