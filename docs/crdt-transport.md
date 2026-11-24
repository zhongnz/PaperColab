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

## Experimental live revision and presence stream

Enable **Experimental live collaboration** in the hosted manuscript with the
same loopback feature flag. An authenticated fetch stream sends newline-delimited
JSON with accepted revision numbers and ephemeral cell-level presence. The client
refreshes clean views and retains dirty drafts. The stream carries no manuscript
text, tokens, CRDT operations or cursor offsets; presence names are resolved by
the server, not submitted by clients. Presence is project-scoped and advisory,
not a lock or permission. The server samples committed state every 400 ms,
rechecks read authority and caps streams at 24 sessions with 60-second leases.
Connections send heartbeats every five seconds and reconnect; disconnected
sessions may remain visible until the next failed write or lease expiry. Polling
is a fallback. HTTP streaming (not WebSockets) is deliberately used to test
behaviour with the existing server. This is not a scalable pub/sub service,
keystroke co-editing, durable offline recovery or a public deployment. The
browser test blocks revision polling and checks push refresh, stale draft
retention, presence and member revocation. No new third-party dependency.

## Local draft recovery and manual conflict reconciliation

Hosted users can opt into IndexedDB storage before editing. Records are scoped
by signed-in actor and project, with separate random page-instance IDs to avoid
cross-tab overwrites. Each stores original cell ID/version/source, local source,
mode and timestamp; invalid scientific field drafts additionally retain field
values for manual recovery. No bearer token is stored. Writes are queued and
success is shown after transaction completion. Browser storage is unencrypted,
not a backup, can be cleared or evicted, and is accessible to other same-origin
scripts and people using the same browser profile. Disable on shared devices.
No automatic restore or upload. Stored drafts can be listed, downloaded,
removed or compared against fresh server state. Reconciliation uses explicit
LaTeX input, normal server validation and current cell version checks, not an
automatic merge. Missing cells are downloadable only. A successful save or
proposal removes its record; cleanup failures are reported. Navigation can leave
records for later recovery. This is draft persistence, not durable CRDT replicas,
full offline editing or server-side encrypted storage. The initial implementation
bounds individual records at 2 MiB and 50 records per actor/project. Invalid
visual serialisation is not guaranteed to be recoverable. Test covers page reload,
remote revision, comparison and explicit reconciliation.
