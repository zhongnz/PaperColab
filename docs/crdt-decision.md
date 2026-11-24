# ADR: collaboration engine selection (proposed)

Decision: defer production selection until comparative trials pass mandatory
contracts. Prefer an existing CRDT implementation over developing a new one.
Start with cell-scoped replicas plus authoritative service-controlled ordering.
Maintain the current optimistic editor as a reference and fallback.

| Criterion | Yjs | Loro |
| --- | --- | --- |
| Text, UTF-16, replicated updates | Documented | Documented |
| Existing editor ecosystem | Established integration options | Existing LibrePaper integration precedent |
| Durable IDs and original source fidelity | Trial required | Trial required |
| Concurrent structural changes | Open | Open |
| Permission, AI review and immutable releases | PaperColab service responsibility | PaperColab service responsibility |
| Production transport and storage | Evaluate Hocuspocus / compatible transport | Evaluate Loro-compatible transport |
| Security, latency, memory and operational cost | Not yet measured | Not yet measured |

A CRDT converges state; it does not decide whose scientific claim is correct
or which source changes are authorised. Keep AI proposals out of authoritative
replicas until approved under the configured policy. Separate accepted source
checkpoints from transient editing state; preserve original import bytes and
unresolved anchors. Retain exact export and isolated compilation tests.

The [trial](../experiments/crdt/README.md) implements the first comparative
contract suite. Results are not claimed until it executes. A passing local
replica test does not authorise production deployment or imply that one engine
outperforms the other. The earlier LibrePaper experiment is additional evidence
rather than a substitute for the same tests on both candidates.

The initial comparative CI trial passed both engines (run 45414737947). For the next isolated transport experiment use Yjs, while production selection remains open. See [transport design and limitations](crdt-transport.md).
