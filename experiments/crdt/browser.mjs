// Optional, same-origin browser bridge. The editor still owns local drafts;
// the replica is reconstructed at explicit save time from the accepted state.
import * as Y from 'yjs';
const decode=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
function encode(bytes){
  let raw='';
  for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(raw);
}
export function incrementalUpdate(checkpoint, before, after){
  if(typeof before!=='string'||typeof after!=='string'||!before.isWellFormed()||!after.isWellFormed())
    throw Error('Invalid cell text.');
  if(before===after)throw Error('Change the cell before saving.');
  if(new TextEncoder().encode(after).length>128*1024)throw Error('Cell exceeds experimental collaboration limit.');
  const doc=new Y.Doc();
  try{
    const text=doc.getText('source');
    Y.applyUpdate(doc,decode(checkpoint.snapshot));
    if(text.toString()!==before||checkpoint.quote!==before)throw Error('Collaboration checkpoint does not match the local draft.');
    // Compare Unicode code points, then convert the changed span to UTF-16
    // offsets. A common prefix/suffix must never split a surrogate pair.
    const a=Array.from(before),b=Array.from(after);
    let prefix=0,suffix=0;
    while(prefix<Math.min(a.length,b.length)&&a[prefix]===b[prefix])prefix++;
    while(suffix<Math.min(a.length,b.length)-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
    const at=a.slice(0,prefix).join('').length;
    const removed=a.slice(prefix,a.length-suffix).join('').length;
    const inserted=b.slice(prefix,b.length-suffix).join('');
    doc.transact(()=>{if(removed)text.delete(at,removed);if(inserted)text.insert(at,inserted);});
    if(text.toString()!==after)throw Error('Replica update did not reproduce the draft.');
    const update=Y.encodeStateAsUpdate(doc,decode(checkpoint.vector));
    if(update.byteLength>256*1024)throw Error('Update exceeds experimental collaboration limit.');
    return encode(update);
  }finally{doc.destroy();}
}
