# Research workflow coordination (prototype)

A workflow is a persistent project-scoped research objective with ordered
work items and explicit acceptance criteria. A human lead creates a plan,
then appends steps, each targeting one editable cell, one assistant and
zero to twelve selected research objects. Dependencies refer only to earlier
steps in the same workflow, so the dependency graph is acyclic by construction.
Independent steps may be launched separately. A dependent step becomes ready
only after every prerequisite has an accepted contribution AND a human
evaluation marked pass.

States: blocked, ready, delegated, review, evaluation, retry, completed.
Each launch creates a new restricted task and records the attempt in the same
transaction. The context and target versions are pinned at launch; no implicit
predecessor content is sent to a model. The agent can use existing CLI, MCP or
provider adapters. Review acceptance updates the manuscript through existing
validation. A reviewer then records an explicit assessment against the criteria.
Passing rechecks the accepted cell version/source and pinned object versions.
A revise outcome permits a new attempt; it does NOT undo an accepted edit.
Rejected, stale, expired or cancelled tasks also permit retry. Previous attempts
and evaluations remain visible. Completion is historical, not a guarantee
that later manuscript or evidence revisions still satisfy the criteria.

No automatic launch, model calls, provider cost accounting, execution workers,
dynamic DAG mutation, automatic rollback, release gate or evaluation scoring.
A workflow can coordinate multiple cells through separate steps; there is no
single atomic multi-cell proposal. Workflow state is separate from manuscript
revision; use Refresh tasks and review for external changes. Unsubmitted
workflow steps do not block publication. Records are included in SQLite backup
and purge; restored open tasks are cancelled by the existing restore path.
Limits: 25 workflows per project, 50 steps per workflow, 20 earlier dependencies
per step, 10 attempts per step. No credentials are stored in workflow records.

Engine strategy: use the existing service as authoritative planner, not a
model framework's ephemeral state. A later execution adapter can invoke
external orchestrators without granting them authority to approve outcomes.
Evaluate frameworks against durable retries, human checkpoints, scoped
credentials, event provenance and cost controls before selecting one.

The hosted browser regression creates a two-step plan, submits a real restricted
HTTP proposal, accepts it, verifies the dependent step stays blocked, records
a passing evaluation, and verifies the dependent step becomes ready.
