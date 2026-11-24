# Experimental Yjs checkpoint transport

Status: opt-in loopback prototype; Yjs selected for this experiment only. The
hosted editor uses its original save path by default, with an optional browser bridge described below. To test the API alone, run:

```sh
npm install --prefix experiments/crdt --ignore-scripts --no-audit --no-fund
python3 experiments/crdt/transport_test.py
PAPERCOLAB_DEMO=1 PAPERCOLAB_EXPERIMENTAL_CRDT=1 python3 -m server
```

GET and POST /api/projects/{project}/blocks/{stableId}/crdt use the existing
bearer-token authorisation. Only human authors/leads can open or commit a
replica. GET returns a base64 snapshot, state vector, current quote, version
and server-generated epoch. POST takes version, epoch and base64 incremental
Yjs update. No client-supplied actor or permission is trusted. An accepted
checkpoint updates source, identity catalogue, version, audit and snapshot
in a single transaction. Concurrent same-cell submissions must rebase
manually; they are not merged automatically. Normal saves invalidate the epoch;
other changed content invalidates it on next read. Restore invalidates all
epochs. Imports and project purge remove snapshots.

Worker limits: 256 KiB decoded update, 1 MiB snapshot, 128 KiB UTF-8 text,
5-second timeout, 128 MiB Node heap flag. The worker rejects extra roots,
formatted/nested values, unresolved dependencies, invalid base64 and malformed
Unicode. The existing parser rejects changed source boundaries. These are
defence-in-depth checks, not a security sandbox or comprehensive audit. Only
supported rich prose and headings are exposed. Snapshots contain history
metadata; never expose them to an unauthorised reader. Node process isolation
is not OS-level isolation, and the global service lock can be blocked by a
slow worker. No public deployment, WebSocket fanout, live keystroke sync,
awareness, durable local drafts, rate limiting or automatic same-cell merge.
Transitive dependency lock remains open. Current experimental policy treats
all binary edits as source edits, so it does not trust claimed visual intent.

CI executes actual HTTP calls with separate author tokens, invalid and
unauthorised updates, stale/replay handling, source rejection, restart recovery
and epoch invalidation. This is a foundation for a later authenticated
WebSocket prototype, not a production collaborative service.

## Optional hosted browser bridge

After installing root and experiment dependencies, run:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm install --prefix experiments/crdt --ignore-scripts --no-audit --no-fund
node experiments/crdt/build-browser.mjs
PAPERCOLAB_DEMO=1 PAPERCOLAB_EXPERIMENTAL_CRDT=1 python3 -m server
```

Select a human author or lead and enable **Experimental Yjs saves** in the
hosted manuscript. Focused, Document and Cells views use the same save bridge
for editable prose/heading cells. The bridge hydrates a replica at save time,
checks the base version and quote, computes a Unicode-safe changed span and
sends an incremental update. No automatic fallback after a failed experimental
save; the user retains the draft. Raw scientific cells and proposals retain the
existing paths. The server still polls accepted revisions; this is explicit
checkpoint collaboration, NOT character-level real-time editing, durable local
replicas or WebSockets. The optional bundle and third-party notices are built
locally and served only in the enabled loopback experiment. No CDN or production
bundle changes. The browser test exercises visual and LaTeX saves, two sessions,
stale-draft retention and accepted checkpoint audit records.
