/* Browser-local draft storage. No tokens, network requests or auto-merge. */
(() => {
  'use strict';
  let database;
  function open(){
    if(!database)database=new Promise((resolve,reject)=>{
      const request=indexedDB.open('papercolab-local-drafts',1);
      request.onupgradeneeded=()=>{
        const store=request.result.createObjectStore('drafts',{keyPath:'id'});
        store.createIndex('scope',['actor','project']);
      };
      request.onsuccess=()=>{
        const db=request.result;
        db.onversionchange=()=>{db.close();database=null;};
        resolve(db);
      };
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(Error('Draft database is blocked by another tab.'));
    }).catch(error=>{database=null;throw error;});
    return database;
  }
  async function tx(mode,work){
    const db=await open();
    return new Promise((resolve,reject)=>{
      const transaction=db.transaction('drafts',mode),store=transaction.objectStore('drafts');
      let result;
      transaction.oncomplete=()=>resolve(result);
      transaction.onerror=()=>reject(transaction.error??Error('Draft transaction failed.'));
      transaction.onabort=()=>reject(transaction.error??Error('Draft transaction aborted.'));
      try{work(store,v=>{result=v;},transaction);}catch(error){transaction.abort();reject(error);}
    });
  }
  const list=(actor,project)=>tx('readonly',(store,done)=>{
    const request=store.index('scope').getAll(IDBKeyRange.only([actor,project]));
    request.onsuccess=()=>done(request.result.sort((a,b)=>b.updated-a.updated));
  });
  async function put(row){
    if(new TextEncoder().encode(JSON.stringify(row)).length>2*1024*1024)throw Error('Draft exceeds local storage limit.');
    return tx('readwrite',(store,done,transaction)=>{
      const req=store.index('scope').getAllKeys(IDBKeyRange.only([row.actor,row.project]));
      req.onsuccess=()=>{
        if(req.result.length>=50&&!req.result.includes(row.id)){transaction.abort();return;}
        store.put(row);
      };
    });
  }
  // Compare-and-delete: another page may have updated the record while it was
  // open in the recovery panel. Never delete a newer revision by accident.
  function remove(id,stamp){
    return tx('readwrite',(store,done)=>{
      const request=store.get(id);
      request.onsuccess=()=>{
        if(request.result?.stamp===stamp){store.delete(id);done(true);}
        else done(!request.result);
      };
    });
  }
  globalThis.PaperColabDrafts={list,put,remove};
})();
