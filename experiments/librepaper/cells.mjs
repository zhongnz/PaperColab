// The host supplies the active LibrePaper document, editor identity and pinned upstream modules.
export function cellSession({ doc, fileId, root = false, model, anchors, tracking, actor }) {
  const memory = new anchors.MoveMemory();
  const body = () => doc.getMap('files').get(fileId).toString();
  const parse = () => model.parseFile(body(), { root });

  function attach(block) {
    const source = body();
    const id = crypto.randomUUID();
    const ok = anchors.createAnchor(doc, fileId, id, block.from, block.to, {
      exact: source.slice(block.from, block.to), prefix: source.slice(Math.max(0, block.from - 32), block.from),
      suffix: source.slice(block.to, block.to + 32)
    });
    if (!ok) throw Error('Unable to anchor cell.');
    doc.commit();
    return id;
  }

  function read(id) {
    const anchor = anchors.resolveAnchors(doc, fileId).find(item => item.id === id);
    if (!anchor || anchor.detached || anchor.unresolved || anchor.collapsed) return null;
    const file = parse();
    const hits = file.blocks.filter(b => b.from < anchor.to && b.to > anchor.from);
    // A split, merge or partial match needs an explicit review decision.
    if (hits.length !== 1 || hits[0].from !== anchor.from || hits[0].to !== anchor.to) return null;
    const block = hits[0];
    return { id, file, block, source: model.current(file, block) };
  }

  function write(edits, tracked) {
    const before = body();
    const prior = anchors.resolveAnchors(doc, fileId);
    const ids = tracked ? tracking.trackedSplices(doc, fileId, edits, actor) : [];
    if (!tracked) tracking.untrackedSplices(doc, fileId, edits);
    doc.commit();
    anchors.recordOperation(doc, [{fileId, before, anchors: prior, edits}], memory, {});
    doc.commit({origin: anchors.ANCHORS_ORIGIN});
    return ids;
  }

  function visual(snapshot, rich) {
    const live = read(snapshot.id);
    if (!live || live.source !== snapshot.source) throw Error('Cell changed. Refresh before applying this draft.');
    model.editVisual(live.file, live.block, rich);
    const next = model.current(live.file, live.block);
    // Compare code points so an edit can never split a UTF-16 surrogate pair.
    const a = Array.from(live.source), b = Array.from(next);
    let left = 0, right = 0;
    while (left < a.length && left < b.length && a[left] === b[left]) left++;
    if (left === a.length && left === b.length) return [];
    while (right < a.length-left && right < b.length-left && a[a.length-1-right] === b[b.length-1-right]) right++;
    const from = live.block.from + a.slice(0,left).join('').length;
    const to = live.block.to - a.slice(a.length-right).join('').length;
    return write([{from, to, insert:b.slice(left,b.length-right).join('')}], true);
  }
  return { attach, read, visual, source: edits => write(edits, false), parse, body };
}
