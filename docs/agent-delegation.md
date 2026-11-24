# Scoped AI task delegation (prototype)

A human project lead creates a task for one editable prose or heading cell,
an active assistant with author/lead membership, instructions, and zero to
twelve explicit research objects. The server pins the cell version and source
and object revisions. It issues a random, 24-hour bearer capability; only its
SHA-256 digest is stored. The raw capability is returned once. It is not an
ordinary actor token, cannot list projects, and is not accepted by the ordinary
API or the legacy MCP-like dispatcher.

## Local client contract

- GET /api/delegated/{task_id}/context with Authorization: Bearer <task token>
  returns the task instructions, assigned cell source, and selected object
  versions only. External references are metadata, not fetched content.
- POST /api/delegated/{task_id}/proposal with the same header and JSON fields
  after (complete revised cell source), rationale, evidence_ids (subset of the
  explicitly supplied object IDs). Exactly one proposal can be submitted.
- A human reviewer accepts or rejects via the existing review queue. The
  server rechecks cell version, quote, object revisions, assistant membership
  and AI policy before accepting a delegated proposal. The strict source
  boundary validator is used both before queuing and before acceptance.
- A lead can cancel an open task or a pending task proposal. Expiry stops
  new submissions, not review of a previously submitted proposal. Restoring
  a backup invalidates outstanding tasks and pending delegated proposals.

No automatic LLM invocation, no external network call, no arbitrary command
execution, no cross-cell or structural proposal, no full-project discovery,
no automatic evidence link creation. Rationale and evidence selections are
assistant assertions, not independently verified facts. Context is untrusted
data; prompt injection remains a model-side risk. No model provider or
standard MCP transport is integrated. The existing ordinary assistant member
tokens still have their older broader project permissions; **do not give those
tokens to a scoped task client**. Production authentication, secure remote
transport, rate limits, secret management and a full authority audit remain
required. The demo server is a local prototype, not a public endpoint.

Task credentials are secrets. Do not put them in logs, repositories, chat
transcripts or manuscripts. Use the explicit restricted credential and a
trusted local client. Task records are included in the existing database
backup and project deletion routines; accepted publication snapshots are
unchanged. Review readiness uses the existing pending-suggestion rule, not
unsubmitted tasks.
