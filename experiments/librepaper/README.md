# LibrePaper manuscript cell trial

Two local collaborators share a LaTeX file using independent LibrePaper/Loro document replicas. Alice edits a supported cell visually in Tiptap. Bob edits its LaTeX through CodeMirror. Apply an edit to send it to the other replica. Turn off **Sync collaborators** to stage independent changes, then turn it back on to reconnect. A local draft stays in its pane when the peer changes the cell.

## Run the browser trial

From a checkout of this branch, with Node 24, Git and Python installed:

~~~sh
mkdir -p build
git clone https://github.com/LibrePaper/librepaper.git build/upstream
git -C build/upstream checkout --detach c74c348d926d9b06f54da52ffb2ea18141267ba5
npm install --prefix build/deps --ignore-scripts --no-audit --no-fund loro-crdt@1.16.1
ln -s "$PWD/build/deps/node_modules" build/upstream/web/node_modules
npm ci --ignore-scripts
node_modules/.bin/esbuild experiments/librepaper/demo.mjs --bundle --format=esm --target=es2022 --outfile=build/cell-demo/app.js
cp build/deps/node_modules/loro-crdt/web/*.wasm build/cell-demo/
python3 -m http.server 8000 --bind 127.0.0.1
~~~

Open http://127.0.0.1:8000/experiments/librepaper/demo.html. The CI workflow also runs a two-replica acceptance test, checks the exported manuscript with TeX Live and drives both editing controls in Chromium.

## Architecture decision

The shared Loro file remains authoritative. Each view parses that file with PaperColab. A visual commit computes a source splice and passes it to LibrePaper's tracked-change machinery. Source commits maintain pending tracked spans using the upstream untracked-edit path. Both record anchor movement. A cell has a UUID and an upstream passage anchor. Reading a cell requires the anchor to delimit exactly one parsed block. A merged, split or otherwise ambiguous range requires review. This conservative rule can also require reattachment after boundary edits. The demo supports interior edits and flags stale drafts that have already received a peer update.

Keep pursuing this authoring architecture if the trial passes. Promotion to the shared service requires testing real users through LibrePaper's authenticated server, durable author and comment records, server-side authority, offline edits overlapping within one cell, and explicit split/merge/reattachment rules. The current trial exchanges replica updates in memory and restores from Loro snapshots. Its anchor models the location of a cell or thread. It does not create a database-backed comment. The example export covers an LF manuscript. Original-byte mapping across LibrePaper's line-ending normalisation remains a separate fidelity requirement.

The pinned upstream code and Loro are MIT-licensed. The experiment imports the upstream implementation at build time. [Upstream source](https://github.com/LibrePaper/librepaper/tree/c74c348d926d9b06f54da52ffb2ea18141267ba5)
