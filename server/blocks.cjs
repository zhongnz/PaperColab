// Server-side block identity. The browser uses the same web/identity.js rules.
const { readFileSync } = require('node:fs');
require('../web/vendor/latex.min.js');
require('../web/blocks.js');
require('../web/identity.js');

const request = JSON.parse(readFileSync(0, 'utf8'));
const I = PaperColabIdentity;

function parse(text, root) {
  return PaperColabBlocks.parseFile(text, { root: Boolean(root) });
}

function run(body) {
  if (body.op === 'catalogue') {
    const file = parse(body.text, body.root);
    return I.catalogue(file, body.previous || [], body.prefer || null);
  }
  if (body.op === 'apply') return I.applyEdit(body.text, body.previous, body.stableId, body.after, body.root);
  if (body.op === 'direct') {
    const B=PaperColabBlocks, file=parse(body.text,body.root);
    const old=body.previous.find(b=>b.stableId===body.stableId);
    const block=file.blocks.find(b=>b.from===old?.from && b.to===old?.to && B.current(file,b)===old.quote);
    if (!block || typeof body.after!=='string' || body.after===old.quote)
      return {ok:false,error:'No valid changed cell.'};
    try {
      let next;
      if (block.rich) {
        B.editSource(file,block,body.after);
        if (body.mode==='visual' && JSON.stringify(B.tokens(block.rich))!==JSON.stringify(B.tokens(B.rich(file,block))))
          throw new Error('Visual edits cannot change protected citation or math tokens.');
        next=B.exportText(file);
      } else {
        next=B.exportText(B.structural(file,block.id,'scientific-source',{source:body.after,root:body.root}).file);
      }
      const parsed=parse(next,body.root), delta=body.after.length-old.quote.length;
      if(parsed.blocks.length!==body.previous.length) throw new Error('Edit changes cell boundaries.');
      const blocks=parsed.blocks.map((cell,i)=>{
        const prior=body.previous[i], target=prior.stableId===old.stableId;
        const shift=prior.from>=old.to?delta:0;
        if(cell.kind!==prior.kind || cell.from!==prior.from+shift ||
           cell.to!==prior.to+shift+(target?delta:0) ||
           B.current(parsed,cell)!==(target?body.after:prior.quote))
          throw new Error('Edit changes an unrelated source range.');
        return {...prior,from:cell.from,to:cell.to,quote:B.current(parsed,cell),label:cell.label||'',rich:Boolean(cell.rich),
          fallback:cell.fallback||'',commands:cell.commands||[]};
      });
      return {ok:true,text:next,blocks};
    } catch(error) {return {ok:false,error:error.message};}
  }
  if (body.op === 'structure') {
    const B=PaperColabBlocks,file=parse(body.text,body.root);
    try {
      if(file.blocks.length!==body.previous.length)throw Error('Cell catalogue no longer matches source.');
      const ids=new Map();
      for(let i=0;i<file.blocks.length;i++){
        const b=file.blocks[i],old=body.previous[i];
        if(b.kind!==old.kind||b.from!==old.from||b.to!==old.to||B.current(file,b)!==old.quote)
          throw Error('Cell catalogue no longer matches source.');
        ids.set(b.id,old.stableId);
      }
      const target=file.blocks.find(b=>ids.get(b.id)===body.stableId);
      if(!target)throw Error('Unknown cell.');
      const result=B.structural(file,target.id,body.action,{...body.options,root:Boolean(body.root)});
      const blocks=result.file.blocks.map(b=>{
        const stableId=ids.get(b.id)??crypto.randomUUID();
        ids.set(b.id,stableId);
        return {stableId,kind:b.kind,from:b.from,to:b.to,quote:B.current(result.file,b),
          label:b.label||'',rich:Boolean(b.rich),fallback:b.fallback||'',commands:b.commands||[]};
      });
      return {ok:true,text:B.exportText(result.file),blocks,selectedId:ids.get(result.selectedId)??null};
    }catch(error){return {ok:false,error:error.message};}
  }
  if (body.op === 'move') return I.moveBlock(body.text, body.previous, body.stableId, body.toOffset, body.root);
  if (body.op === 'resolve') return I.resolveAnchor(body.blocks, body.anchor);
  throw new Error('Unknown block operation.');
}

try {
  process.stdout.write(JSON.stringify(run(request)));
} catch (error) {
  process.stderr.write(error.stack || error.message);
  process.exit(1);
}
