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

  function oneBlock(source, kind, macros = null) {
    const parsed = B().parseFile(source,{macros});
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
    const context=B().parseFile(text,{root});
    if (!oneBlock(after, block.kind, context.macros)) {
      return { ok: false, error: 'This change needs review. It does not stay one block.', unresolved: [stableId], result: 'needs-review' };
    }
    const nextText = text.slice(0, block.from) + after + text.slice(block.to);
    const parsed = B().parseFile(nextText, { root });
    const listed = catalogue(parsed, previous, { stableId, kind: block.kind, quote: after });
    if (!listed.ok) return listed;
    return { ok: true, text: nextText, blocks: listed.blocks, unresolved: listed.unresolved, result: 'accepted' };
  }

  function boundary(text, at) {
    if (at <= 0 || at >= text.length) return Math.max(0, Math.min(text.length, at));
    if (text.slice(Math.max(0, at - 2), at) === '\n\n' || text.slice(at, at + 2) === '\n\n') return at;
    let best = at;
    let bestDistance = Infinity;
    const start = Math.max(0, at - 120);
    const end = Math.min(text.length, at + 120);
    for (let index = start; index <= end; index++) {
      const onBoundary = index === 0 || index === text.length || text.slice(Math.max(0, index - 2), index) === '\n\n' || text.slice(index, index + 2) === '\n\n';
      if (!onBoundary) continue;
      const distance = Math.abs(index - at);
      if (distance < bestDistance) { bestDistance = distance; best = index; }
    }
    return best;
  }

  function moveBlock(text, previous, stableId, toOffset, root) {
    const block = previous.find(item => item.stableId === stableId);
    if (!block) return { ok: false, error: 'Unknown block.' };
    if (!Number.isInteger(toOffset) || toOffset < 0 || toOffset > text.length) return { ok: false, error: 'The destination is outside the file.' };
    const slice = text.slice(block.from, block.to);
    const removed = (text.slice(0, block.from) + text.slice(block.to)).replace(/\n{3,}/g, '\n\n');
    let at = toOffset >= block.to ? toOffset - (block.to - block.from) : toOffset <= block.from ? toOffset : block.from;
    at = boundary(removed, Math.max(0, Math.min(removed.length, at)));
    const prefix = at > 0 && !removed.slice(0, at).endsWith('\n\n') ? '\n\n' : '';
    const suffix = at < removed.length && !removed.slice(at).startsWith('\n\n') ? '\n\n' : '';
    const nextText = removed.slice(0, at) + prefix + slice + suffix + removed.slice(at);
    const parsed = B().parseFile(nextText, { root });
    const listed = catalogue(parsed, previous, { stableId, kind: block.kind, quote: slice, near: at + prefix.length });
    if (!listed.ok) return listed;
    return { ok: true, text: nextText, blocks: listed.blocks, unresolved: listed.unresolved, result: 'moved' };
  }

  function resolveAnchor(blocks, anchor) {
    const hits = blocks.filter(block => block.stableId === anchor.blockId);
    if (hits.length !== 1) return { status: 'unresolved', blockId: anchor.blockId };
    const block = hits[0];
    if (block.quote !== anchor.quote) return { status: 'unresolved', blockId: block.stableId };
    return { status: 'exact', blockId: block.stableId, path: block.path, from: block.from, to: block.to };
  }

  globalThis.PaperColabIdentity = { catalogue, applyEdit, moveBlock, resolveAnchor, oneBlock };
})();
