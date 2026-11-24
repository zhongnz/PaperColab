# Experimental Yjs checkpoint transport

Status: opt-in loopback prototype; Yjs selected for this experiment only. The
existing hosted editor does not use this endpoint. Run:

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
slow worker. No public deployment, WebSocket fanout, client integration,
awareness, durable local drafts, rate limiting or automatic same-cell merge.
Transitive dependency lock remains open. Current experimental policy treats
all binary edits as source edits, so it does not trust claimed visual intent.

CI executes actual HTTP calls with separate author tokens, invalid and
unauthorised updates, stale/replay handling, source rejection, restart recovery
and epoch invalidation. This is a foundation for a later authenticated
WebSocket prototype, not a production collaborative service.
