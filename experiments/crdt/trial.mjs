import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as Y from 'yjs';
import {LoroDoc} from 'loro-crdt';

const require=createRequire(import.meta.url);
require('../../web/vendor/latex.min.js');
require('../../web/blocks.js');
require('../../web/identity.js');
const B=PaperColabBlocks, I=PaperColabIdentity;
const parser=fileURLToPath(new URL('../../server/blocks.cjs',import.meta.url));

// One text CRDT per stable cell. Ordering, raw gaps and authority are NOT CRDT
// fields; this trial does not expose any binary mutation endpoint.
const engines={
  yjs:{
    new:()=>new Y.Doc(),
    text:d=>d.getText('source'),
    snapshot:d=>Y.encodeStateAsUpdate(d),
    import:(d,b)=>Y.applyUpdate(d,b),
    commit:()=>{},
    dispose:d=>d.destroy()
  },
  loro:{
    new:()=>new LoroDoc(),
    text:d=>d.getText('source'),
    snapshot:d=>d.export({mode:'snapshot'}),
    import:(d,b)=>d.import(b),
    commit:d=>d.commit(),
    dispose:d=>d.free?.()
  }
};
function seed(e,source){
  const d=e.new();e.text(d).insert(0,source);e.commit(d);return d;
}
function restore(e,bytes){const d=e.new();e.import(d,bytes);return d;}
function value(e,d){return e.text(d).toString();}
function edit(e,d,from,to,insert){
  const t=e.text(d);
  if(to>from)t.delete(from,to-from);
  if(insert)t.insert(from,insert);
  e.commit(d);
}
function replace(e,d,old,next){
  const s=value(e,d),at=s.indexOf(old);
  assert.notEqual(at,-1);edit(e,d,at,at+old.length,next);
}
function exchange(e,a,b){
  const aa=e.snapshot(a),bb=e.snapshot(b);
  e.import(a,bb);e.import(b,aa);
  assert.equal(value(e,a),value(e,b),'replicas must converge');
  // Replay and reverse import order are deliberately exercised.
  e.import(a,bb);e.import(b,aa);
  const fresh=restore(e,bb);e.import(fresh,aa);
  assert.equal(value(e,fresh),value(e,a));
  e.dispose(fresh);
  return value(e,a);
}
function server(request){
  const p=spawnSync(process.execPath,[parser],{input:JSON.stringify(request),encoding:'utf8',maxBuffer:8*1024*1024});
  assert.equal(p.status,0,p.stderr);
  return JSON.parse(p.stdout);
}
const source='\\section{Sampling method}\r\n\r\nCafé 🐋 uses two readings and $x$ with \\cite{fieldguide}.\n\nSecond paragraph remains.\r\n\r\n\\begin{tabular}{ll}\r\nA & B \\\\\r\n\\end{tabular}\r\n';
const initial=I.catalogue(B.parseFile(source)).blocks;
const paragraph=initial.find(b=>b.rich&&b.kind==='paragraph');
const title=initial.find(b=>b.kind==='heading');
assert.ok(paragraph&&title);
const fixture={text:source,blocks:initial,versions:new Map(initial.map(b=>[b.stableId,1])),audit:[]};

// A deliberately small reference gate around the actual server parser. Role,
// base version and target are trusted server-side metadata, never CRDT fields.
// It models a checkpoint policy, not authenticated live transport.
function gate(state,request){
  if(request.actor!=='human-author')return {ok:false,reason:'authority'};
  const prior=state.blocks.find(b=>b.stableId===request.id);
  if(!prior||state.versions.get(request.id)!==request.version||prior.quote!==request.before)
    return {ok:false,reason:'stale'};
  const result=server({op:'direct',text:state.text,previous:state.blocks,stableId:request.id,
    after:request.after,mode:request.mode,root:false});
  if(!result.ok)return {ok:false,reason:'validation',detail:result.error};
  state.text=result.text;state.blocks=result.blocks;
  state.versions.set(request.id,request.version+1);
  state.audit.push({actor:request.actor,id:request.id,version:request.version+1,mode:request.mode});
  return {ok:true};
}
function state(){return {text:fixture.text,blocks:structuredClone(fixture.blocks),versions:new Map(fixture.versions),audit:[]};}
function trial(name,e){
  const base=seed(e,paragraph.quote),snapshot=e.snapshot(base);
  const a=restore(e,snapshot),b=restore(e,snapshot);
  // Derive a visual edit using the actual PaperColab rich model, then
  // translate its changed span to text operations (not a full-cell replace).
  const file=B.parseFile(paragraph.quote),local=file.blocks[0],rich=structuredClone(local.rich);
  const node=rich.content[0].content.find(n=>n.type==='text'&&n.text.includes('two readings'));
  assert.ok(node);node.text=node.text.replace('two readings','three readings');
  B.editVisual(file,local,rich);
  const visual=B.current(file,local);
  const at=paragraph.quote.indexOf('two readings');
  assert.equal(visual,paragraph.quote.slice(0,at)+'three readings'+paragraph.quote.slice(at+'two readings'.length));
  edit(e,a,at,at+'two readings'.length,'three readings');
  // UTF-16 coordinate after a surrogate pair; source edit changes a citation.
  replace(e,b,'fieldguide','otherguide');
  const merged=exchange(e,a,b);
  assert.equal(merged,paragraph.quote.replace('two readings','three readings').replace('fieldguide','otherguide'));
  const restored=restore(e,e.snapshot(a));assert.equal(value(e,restored),merged);
  const s=state(),req={actor:'human-author',id:paragraph.stableId,version:1,before:paragraph.quote,after:merged,mode:'source'};
  assert.equal(gate(s,{...req,actor:'assistant'}).reason,'authority');
  assert.equal(s.text,source);
  assert.equal(gate(s,req).ok,true);
  assert.equal(s.text,source.slice(0,paragraph.from)+merged+source.slice(paragraph.to));
  assert.deepEqual(s.blocks.map(x=>x.stableId),initial.map(x=>x.stableId));
  assert.equal(s.audit.length,1);
  assert.equal(gate(s,req).reason,'stale');
  // A different cell's original version is valid despite manuscript progress.
  const h=seed(e,title.quote);replace(e,h,'Sampling','Station');
  assert.equal(gate(s,{actor:'human-author',id:title.stableId,version:1,before:title.quote,after:value(e,h),mode:'source'}).ok,true);
  assert.equal(s.text,source.replace(title.quote,title.quote.replace('Sampling','Station')).replace(paragraph.quote,merged));
  // Cross-boundary and protected-token violations must never reach a release.
  const current=s.blocks.find(b=>b.stableId===paragraph.stableId);
  const r={actor:'human-author',id:current.stableId,version:2,before:current.quote,mode:'visual'};
  assert.equal(gate(s,{...r,after:current.quote.replace('$x$','$z$')}).reason,'validation');
  assert.equal(gate(s,{...r,mode:'source',after:current.quote+'\n\nExtra paragraph.'}).reason,'validation');
  // Overlapping replacements: convergence does NOT establish user intent.
  // Record actual merged text; accept one checkpoint and reject the stale
  // competitor under the current authority policy rather than publish a merge.
  const c=restore(e,snapshot),d=restore(e,snapshot);
  replace(e,c,'two readings','four readings');replace(e,d,'two readings','five readings');
  const cText=value(e,c),dText=value(e,d),overlap=exchange(e,c,d),conflict=state();
  const request={...req,after:cText};
  assert.equal(gate(conflict,request).ok,true);
  assert.equal(gate(conflict,{...request,after:dText}).reason,'stale');
  assert.equal(conflict.text,source.replace(paragraph.quote,cText));
  // Stable identity across a source-coordinate shift is tested above; moves,
  // deletes, authenticated wire updates and network recovery are future trials.
  const row={engine:name,checks:'passed',initialSnapshotBytes:snapshot.byteLength,
    mergedSnapshotBytes:e.snapshot(a).byteLength,overlapOutput:overlap,
    overlapAutomaticallyPublished:false,fixture:'mixed EOL + Unicode + protected citation/math + raw table'};
  for(const doc of [base,a,b,restored,h,c,d])e.dispose(doc);
  return row;
}
const results=[];
let failed=false;
for(const [name,e] of Object.entries(engines)){
  try{results.push(trial(name,e));}
  catch(error){failed=true;results.push({engine:name,checks:'failed',error:error.stack});}
}
const report={node:process.version,results,scope:'local replicas; full snapshots; server checkpoint reference gate; no performance ranking'};
writeFileSync(new URL('report.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(failed)process.exitCode=1;
