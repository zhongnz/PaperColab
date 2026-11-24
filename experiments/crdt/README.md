# Collaboration engine contract trial

Status: experimental; no engine selected. The production prototype retains its
version-checked direct saves and polling. This is an independent comparison of
Yjs 13.6.33 and Loro 1.16.0, not the earlier LibrePaper integration experiment
(PR #4). Both use UTF-16 text coordinates, matching the LaTeX parser.

Run from repository root (Node 24):

```sh
npm install --prefix experiments/crdt --ignore-scripts --no-audit --no-fund
npm test --prefix experiments/crdt
```

The experiment has exact top-level versions but the first install resolves
transitive dependencies. Retain the generated lockfile and report for a fully
repeatable follow-up; no dependencies are added to the production bundle.
The trial uses only an authored fixture, no user manuscript or service token.

| Contract | Trial |
| --- | --- |
| Bidirectional authoring | Actual rich-to-source adapter and source splice on disconnected replicas |
| Convergence / reconnect | Exchange snapshots, replay, restore in reversed order |
| Unicode and source fidelity | UTF-16 offsets, mixed line endings, protected inline math/citation, unchanged raw table |
| Stable identity | Actual server direct-edit parser checks exact offsets and retained IDs |
| Governance | Reference gate rejects assistant and stale checkpoint, checks visual protected tokens and boundary violations |
| Independent cells | Heading checkpoint accepted after paragraph version advances |
| Overlap | Record converged text; demonstrate why convergence is not approval; reject stale competing checkpoint |
| Metrics | Snapshot byte counts only, not a throughput or latency benchmark |

The reference gate is a test harness, not authentication or deployed policy.
It does not validate binary updates from untrusted peers, author attribution
inside those updates, or character-level permissions. It does not test
structural operations, selective sync, awareness, cursor anchors, incremental
updates, actual network loss, large corpus or end-to-end browser collaboration.
A passing trial is necessary but insufficient to choose either engine.

## Next decision gate

Compare per-cell and per-file replication with the same corpus; test actual
incremental transport, stable anchors through move/split/delete, malicious
updates, authenticated actor provenance, durable replay and immutable releases.
Require a bounded server-side validation pipeline before accepting any update.
Keep ordered cell structure and approval authority with the service until a
safe structural conflict policy is demonstrated. Do not put CRDT state in
charge of membership, approval or release records.

References:
- https://docs.yjs.dev/api/shared-types/y.text
- https://docs.yjs.dev/api/document-updates
- https://loro.dev/docs/api/js
- https://loro.dev/docs/tutorial/encoding
