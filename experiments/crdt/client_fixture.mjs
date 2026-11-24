// Test-only client: produce an incremental update relative to a server vector.
import * as Y from 'yjs';
import {readFileSync} from 'node:fs';
const input=JSON.parse(readFileSync(0,'utf8'));
const doc=new Y.Doc(), t=doc.getText('source');
Y.applyUpdate(doc,Buffer.from(input.snapshot,'base64'));
if(input.extra)doc.getMap('unauthorised').set('role','lead');
if(input.format)t.format(0,1,{bold:true});
if(input.missing){
  const at=t.length;t.insert(at,'first');const vector=Y.encodeStateVector(doc);
  t.insert(at+5,'second');process.stdout.write(Buffer.from(Y.encodeStateAsUpdate(doc,vector)).toString('base64'));
}else{
  if(input.old!==undefined){
    const at=t.toString().indexOf(input.old);
    if(at<0)throw Error('missing fixture text');
    doc.transact(()=>{t.delete(at,input.old.length);t.insert(at,input.next);});
  }
  process.stdout.write(Buffer.from(Y.encodeStateAsUpdate(doc,Buffer.from(input.vector,'base64'))).toString('base64'));
}
doc.destroy();
