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
