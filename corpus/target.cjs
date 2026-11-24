// Choose an editable paragraph only within the root's statically reached files.
const fs=require('node:fs/promises');
globalThis.zip=require('../web/vendor/zip-core.min.js');
require('../web/vendor/latex.min.js');
require('../web/archive.js');
require('../web/inspect.js');
require('../web/blocks.js');
(async()=>{
  const [filename,root]=process.argv.slice(2);
  const inventory=PaperColabInspect.inventory(await PaperColabArchive.readArchive(new Blob([await fs.readFile(filename)])));
  if(!inventory.roots.includes(root))throw Error('Unknown root.');
  const {sources}=PaperColabInspect.inspectRoot(inventory,root);
  const candidates=[root,...sources.filter(s=>s!==root&&/\.(tex|ltx)$/i.test(s))];
  let target=null;
  for(const source of candidates){
    const text=inventory.files.get(source)?.text;
    if(typeof text!=='string')continue;
    const file=PaperColabBlocks.parseFile(text,{root:source===root});
    if(file.blocks.some(b=>b.kind==='paragraph'&&b.rich)){target=source;break;}
  }
  console.log(JSON.stringify({target}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
