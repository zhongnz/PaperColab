// Loopback-only experimental worker; never accept arbitrary binary updates
// directly into the authoritative manuscript. The service gates the checkpoint.
import * as Y from 'yjs';
import {readFileSync} from 'node:fs';
const MAX_TEXT=128*1024, MAX_UPDATE=256*1024, MAX_SNAPSHOT=1024*1024;
const encode=x=>Buffer.from(x).toString('base64');
function decode(value,max){
  if(typeof value!=='string'||value.length>Math.ceil(max/3)*4)throw Error('size');
  const b=Buffer.from(value,'base64');
  if(!b.length||b.length>max||encode(b)!==value)throw Error('encoding');
  return b;
}
function check(doc){
  // Predeclare the sole allowed root before applying updates. Reject nested
  // content, formatting, unknown shared roots and unresolved dependencies.
  const text=doc.getText('source');
  if(doc.share.size!==1||doc.store.pendingStructs||doc.store.pendingDs)throw Error('unresolved or unexpected root');
  if(text.toDelta().some(part=>typeof part.insert!=='string'||part.attributes))throw Error('not plain text');
  const value=text.toString();
  if(Buffer.byteLength(value)>MAX_TEXT||!value.isWellFormed())throw Error('text limit or malformed Unicode');
  return value;
}
function state(doc){
  const text=check(doc), snapshot=Y.encodeStateAsUpdate(doc);
  if(snapshot.byteLength>MAX_SNAPSHOT)throw Error('snapshot limit');
  return {ok:true,text,snapshot:encode(snapshot),vector:encode(Y.encodeStateVector(doc))};
}
function run(input){
  const doc=new Y.Doc();
  try{
    const text=doc.getText('source');
    if(input.op==='seed'){
      if(typeof input.text!=='string'||Buffer.byteLength(input.text)>MAX_TEXT)throw Error('text');
      text.insert(0,input.text);
      return state(doc);
    }
    if(input.op==='apply'){
      Y.applyUpdate(doc,decode(input.snapshot,MAX_SNAPSHOT));
      if(check(doc)!==input.before)throw Error('checkpoint mismatch');
      Y.applyUpdate(doc,decode(input.update,MAX_UPDATE));
      return state(doc);
    }
    throw Error('operation');
  }finally{doc.destroy();}
}
try{process.stdout.write(JSON.stringify(run(JSON.parse(readFileSync(0,'utf8')))));}
catch{process.stdout.write(JSON.stringify({ok:false}));process.exitCode=1;}
