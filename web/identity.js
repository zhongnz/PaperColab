/* global PaperColabBlocks */
(() => {
  'use strict';
  const B = () => globalThis.PaperColabBlocks;

  function describe(file) {
    return file.blocks.map(block => ({
      kind: block.kind,
      from: block.from,
      to: block.to,
      quote: B().current(file, block),
      label: block.label || '',
      fallback: block.fallback || '',
      commands: block.commands || [],
      rich: Boolean(block.rich)
    }));
  }

  function catalogue(file, previous = [], prefer = null) {
    const blocks = describe(file);
    const used = new Set();
    if (prefer) {
      const candidates = blocks.filter(block => block.kind === prefer.kind && block.quote === prefer.quote);
      const chosen = prefer.near == null ? candidates[0] : candidates.slice().sort((a, b) =>
        Math.abs(a.from - prefer.near) - Math.abs(b.from - prefer.near) || a.from - b.from)[0];
      if (!chosen) return { ok: false, error: 'The edited block could not be found after the change.', unresolved: [prefer.stableId] };
      chosen.stableId = prefer.stableId;
      used.add(prefer.stableId);
    }
    for (const prior of previous) {
      if (used.has(prior.stableId)) continue;
      const match = blocks.find(block => !block.stableId && block.kind === prior.kind && block.quote === prior.quote);
      if (!match) continue;
      match.stableId = prior.stableId;
      used.add(prior.stableId);
    }
    for (const block of blocks) if (!block.stableId) block.stableId = crypto.randomUUID();
    return { ok: true, blocks, unresolved: previous.filter(prior => !used.has(prior.stableId)).map(prior => prior.stableId) };
  }

  function oneBlock(source, kind) {
    const parsed = B().parseFile(source);
    const supported = parsed.blocks.filter(block => block.kind === kind);
    if (parsed.blocks.length !== 1 || supported.length !== 1 || supported[0].from !== 0 || supported[0].to !== source.length) {
      return null;
    }
    return supported[0];
  }

  function applyEdit(text, previous, stableId, after, root) {
    const block = previous.find(item => item.stableId === stableId);
    if (!block) return { ok: false, error: 'Unknown block.' };
    if (after === block.quote) return { ok: false, error: 'The suggestion does not change the block.' };
    if (!oneBlock(after, block.kind)) {
      return { ok: false, error: 'This change needs review. It does not stay one block.', unresolved: [stableId], result: 'needs-review' };
    }
    const nextText = text.slice(0, block.from) + after + text.slice(block.to);
    const listed = locateChangedBlock(nextText, root, previous, block, after, block.from);
    if (!listed.ok) return listed;
    return { ok: true, text: nextText, blocks: listed.blocks, unresolved: listed.unresolved, result: 'accepted' };
  }

  function locateChangedBlock(text, root, previous, block, quote, start, blockCount = previous.length) {
    const parsed = B().parseFile(text, { root });
    const { stableId, kind } = block;
    const listed = catalogue(parsed, previous, { stableId, kind, quote, near: start });
    if (!listed.ok) return listed;
    const target = listed.blocks.find(item => item.stableId === stableId);
    if (target.from !== start || listed.unresolved.length || listed.blocks.length !== blockCount) {
      return { ok: false, error: 'This change would alter other block boundaries and needs review.', result: 'needs-review' };
    }
    return listed;
  }

  const lineEnding = /(?:\r\n|\r(?!\n)|(?<!\r)\n)/.source;
  const blankLine = lineEnding + '[ \t]*' + lineEnding;
  const startsBlank = new RegExp('^' + blankLine);
  const endsBlank = new RegExp(blankLine + '$');

  function insertCellText(text, at, quote, lineEndingSource = text) {
    const separator = (lineEndingSource.match(new RegExp(lineEnding))?.[0] ?? '\n').repeat(2);
    const before = text.slice(0, at);
    const after = text.slice(at);
    const prefix = before && !endsBlank.test(before) ? separator : '';
    const suffix = after && !startsBlank.test(after) ? separator : '';
    return { text: before + prefix + quote + suffix + after, start: at + prefix.length };
  }

  function boundary(text, at) {
    if (at <= 0 || at >= text.length) return Math.max(0, Math.min(text.length, at));
    let best = null;
    let bestDistance = Infinity;
    function consider(index) {
      const distance = Math.abs(index - at);
      if (distance <= 120 && distance < bestDistance) { bestDistance = distance; best = index; }
    }
    consider(0);
    for (const match of text.matchAll(new RegExp(blankLine, 'g'))) {
      consider(match.index);
      consider(match.index + match[0].length);
    }
    consider(text.length);
    return best;
  }

  function moveBlock(text, previous, stableId, toOffset, root, exact = false) {
    const block = previous.find(item => item.stableId === stableId);
    if (!block) return { ok: false, error: 'Unknown block.' };
    if (!Number.isInteger(toOffset) || toOffset < 0 || toOffset > text.length) return { ok: false, error: 'The destination is outside the file.' };
    if (toOffset >= block.from && toOffset <= block.to) return { ok: false, error: 'Choose a destination outside the block.' };
    const slice = text.slice(block.from, block.to);
    const removed = text.slice(0, block.from) + text.slice(block.to);
    const adjusted = toOffset > block.to ? toOffset - slice.length : toOffset;
    const at = exact ? adjusted : boundary(removed, adjusted);
    if (at === null) return { ok: false, error: 'Choose a destination near a block boundary.' };
    const inserted = insertCellText(removed, at, slice, text);
    const listed = locateChangedBlock(inserted.text, root, previous, block, slice, inserted.start);
    if (!listed.ok) return listed;
    return { ok: true, text: inserted.text, blocks: listed.blocks, unresolved: listed.unresolved, result: 'moved' };
  }

  function insertCell(text, previous, neighborId, direction, kind, source, root) {
    const neighbor = previous.find(item => item.stableId === neighborId);
    if (!neighbor) return { ok: false, error: 'Unknown cell.' };
    if (!oneBlock(source, kind)) {
      return { ok: false, error: 'Enter one supported paragraph or LaTeX heading.' };
    }
    const block = { stableId: crypto.randomUUID(), kind };
    const at = direction === 'before' ? neighbor.from : neighbor.to;
    const inserted = insertCellText(text, at, source);
    const listed = locateChangedBlock(inserted.text, root, previous, block, source, inserted.start, previous.length + 1);
    if (!listed.ok) return listed;
    return { ok: true, text: inserted.text, blocks: listed.blocks, stableId: block.stableId };
  }

  function resolveAnchor(blocks, anchor) {
    const hits = blocks.filter(block => block.stableId === anchor.blockId);
    if (hits.length !== 1) return { status: 'unresolved', blockId: anchor.blockId };
    const block = hits[0];
    if (block.quote !== anchor.quote) return { status: 'unresolved', blockId: block.stableId };
    return { status: 'exact', blockId: block.stableId, path: block.path, from: block.from, to: block.to };
  }

  globalThis.PaperColabIdentity = { catalogue, applyEdit, moveBlock, insertCell, resolveAnchor, oneBlock };
})();
