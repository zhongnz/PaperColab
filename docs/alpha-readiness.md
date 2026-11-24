# PaperColab v0.1 — private-alpha readiness

Baseline: 46adbf3, all three CI workflows passed before consolidation.
This is a feature freeze for the first pilot, not a change to the long-term
research operating platform vision. Keep the experimental work in the draft PR.

## Local preview

Use Python 3.11+ and Node 22+ (vendored browser assets already included).
Run PAPERCOLAB_DEMO=1 python3 -m server and open http://127.0.0.1:8787/.
For a clean non-demo workspace use a new PAPERCOLAB_DATA directory, omit
PAPERCOLAB_DEMO and use the operator access token printed once at first boot.
The service binds only to loopback. Do not expose it via a public tunnel or
reverse proxy. Local account creation issues an existing bearer credential;
a lead adds the account ID to the project with a role. This is manual
provisioning, not password/OIDC authentication, email invitations or a
production secret store. The database contains credentials and research data.
Do not reuse demo databases for sensitive research. Sign out on shared devices;
local draft recovery is unencrypted and persists separately from sign-in.

## Release gates (not all met)

| Gate | Required evidence | Current state |
|---|---|---|
| Core flows | Green editor, hosted browser, export/PDF, Python/R suites at release SHA | baseline green; consolidation needs CI |
| UX | One coherent navigation shell; create/import/edit/review/export tested desktop and mobile | first consolidation increment |
| Onboarding | Named local accounts, role assignment, sign-out; external user onboarding observed | manual local prototype |
| Fidelity | 18/20 corpus papers round-trip and compile, untouched spans intact; record editable coverage | one documented published-source baseline |
| Security | threat model, token hashing/rotation, tenant isolation, revocation, safe error responses, deployment review | incomplete |
| Deployment | TLS, production auth, backups and restore drills, isolated build workers, monitoring, resource limits | not ready |
| Pilot | three independent groups voluntarily returning after week four | no measured retention |
| AI | supported model/provider integration with explicit egress consent and actual user test | mock provider tests, local MCP |

Pilot: start with a copy of one representative manuscript, two human authors
and one reviewer, use direct or suggested cell edits, run export verification,
and record friction. Keep the authoritative manuscript in its original system.
No automatic LLM execution or public signup in this increment. Do not declare
private-alpha readiness until deployment and security gates pass; controlled
local testing on non-sensitive copies is appropriate earlier. See docs/pilot.md.

The consolidated shell groups manuscript, AI/review and workflow controls,
research library/experiments, and project settings. Existing service semantics
remain the authority. Local named accounts are not a substitute for production
authentication. No architecture migration, new framework or new dependencies
in this increment. Next: isolate provisioning and deployment threat model,
expand the corpus and validate the user journey before adding new capabilities.

The second consolidation increment adds a non-demo browser onboarding regression, same-origin loopback Host/Origin checks, generic unexpected API errors, rejected revoked API actors, and sign-out cleanup. These controls reduce local prototype exposure but do not establish public deployment safety. The local server refuses non-demo startup on a database containing the fixed demo credentials.

## Credential and authority hardening

New random bearer tokens and migrated legacy tokens use SHA-256 digests in the
existing SQLite token column. Hashing is appropriate for randomly generated
high-entropy tokens, not user passwords. Fixed demo credentials remain public
and are detected by their digests; no production use. Migration uses SQLite
secure_delete and VACUUM, but old backups and filesystem snapshots may retain
plaintext. Rotate existing non-demo account credentials after migration and
secure/delete obsolete copies according to your retention policy.

Operators can list, rotate and revoke non-operator accounts. Rotation or
revocation invalidates pending proposals and open delegated tasks; removing or
downgrading an author similarly invalidates their pending authority in that
project. No project may lose its last active human lead through these APIs.
Assistant membership is limited to reader/author; imports require a human
editor and an empty project. Existing manuscripts cannot be overwritten by
ZIP import. Non-demo restore requires an identical account and membership
snapshot, preventing rollback of rotated/revoked credentials or membership.
This conservative restriction prevents some legitimate disaster recovery;
operator credential recovery and offline recovery procedures remain open.
No password authentication, MFA, OIDC, session expiry, TLS or deployment yet.

The onboarding regression also exercises rotation and revocation through the operator UI. The service rechecks ordinary proposal contributor authority at acceptance, and invalidated delegated tasks cannot be revived by re-adding a removed member. Old backups are rejected by the local restore API when identity or membership differs; this is not a complete disaster-recovery solution.
