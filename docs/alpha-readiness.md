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

## Manuscript compatibility gate automation

The twenty-paper diagnostic is now a separate sharded CI workflow with staged
results and an aggregate 18/20 gate. An original-source build, static inventory,
or untouched export alone is insufficient. Count a pass only after a supported
visual edit, outside-span byte checks, source-mode re-import check, isolated
edited PDF build and visible marker. Source acquisition and template/toolchain
failures remain visible rather than being excluded from the denominator.
Until a complete report reaches the gate, broad LaTeX compatibility is unverified.

First full fidelity run: 8/20 (40%), 20/20 acquired, 8 original-build failures, 2 ambiguous roots, 2 no-editable-paragraph cases, 33.1% classified paragraph coverage. Gate not met. All eligible edited round-trips passed, but this is a narrow single-paragraph trial. See the linked run in corpus/README.md. Next run adds build error categories and full-file fallback reasons; no relaxation of isolated compilation or source preservation.

Parser compatibility increment: literal same-file macro signatures and protected explicit invocations, with shared hosted/standalone parsing context. Cross-file macro scope and migration of stored cell catalogues across parser versions remain release blockers. The preceding completed corpus run at cbc5b50 passed 8/20 and reached 39.2% classified paragraph coverage; BART root resolved but baseline compilation failed. No claim that the new registry improves the pass count until CI completes.

A lead-only, per-file catalogue upgrade preview/application is available in Project settings. The server compares exact UTF-16 ranges and quotes, refuses any unmatched boundary, fingerprints the current revision/source/old and new catalogues, and only applies an identical preview. Stable IDs, ownership, source bytes, anchors, evidence records and historical releases are retained; changed descriptions bump versions, stale pending proposals, cancel open delegated tasks and discard affected CRDT checkpoints. No auto-migration on startup; splits/merges or mismatched ranges remain blocked. The new text-run patch also preserves original intra-cell source for eligible single-run changes, with legacy serialization fallback for other changes. Neither is a general guarantee of arbitrary LaTeX round-trip fidelity.

Cross-file macro context prototype: one root, literal preamble input files containing only recognised declarations, and direct leaf sections, bounded to 128 text sources and 2 MiB of characters. The import catalogue, hosted file snapshot/edits/proposals, offline editor, and corpus use the same resolver. Visible competing definitions are excluded; ambiguous paths, multiple roots, nested/conditional includes and dynamic scope disable cross-file context. Hosted mutations compare the context before and after and refuse changes, and the offline export checks the same invariant. Legacy offset moves are disabled in projects with shared context. Existing project files use the exact-range catalogue upgrade if classification changes; unsupported boundaries remain blocked. This does not resolve arbitrary style/class/package semantics or prove TeX expansion equivalence. No general macro migration or dynamic include editing.

The previous source-span/metadata upgrade baseline (0cf8a23) passed all three ordinary CI suites; its corpus result remains 8/20 and 34.6% classified paragraph coverage. The cross-file context increment adds service regressions for direct edits, proposals, exact-range upgrade of a simulated legacy catalogue, retained ownership/anchors, and refusal of a context-changing candidate. A hosted browser fixture exercises both focused and document views with an imported multi-file project. Fresh CI is required before marking the increment verified.

## Local integrated PDF preview

Opt in with PAPERCOLAB_LOCAL_PDF_PREVIEW=1 alongside the loopback server,
with Docker installed and the existing TeX Live image pre-pulled. A human
project member chooses a detected root and pdfLaTeX/XeLaTeX/LuaLaTeX,
then explicitly compiles the saved revision. No unsaved drafts, automatic
compilation or host TeX fallback. One build at a time per server; the
request snapshots the ZIP under the service lock and releases it during
compilation, then rechecks the requesting credential and membership.
Returns the saved revision, current revision, source ZIP hash and PDF hash.
The UI shows up to three bounded PNG pages rendered inside the disposable
container (Poppler if available, otherwise Ghostscript) and allows full PDF
download. Failed builds show a bounded plain-text diagnostic; missing
raster support does not prevent PDF download. No active PDF embedding,
no persisted preview or cross-user cache. Clear preview/sign-out/project
switch discards the UI result; it does not cancel a running container.
Other edits can proceed, and older previews are identified by revision.
Existing no-network, no-shell-escape, unprivileged resource-bounded Docker
controls remain. This is for trusted local research projects, not public
multi-tenant execution; downloaded PDFs may contain active content.
The interactive PDF limit is 16 MiB, raster pages 2 MiB each, at most
1200 pixels per dimension. Real container/browser CI and permission/
lock regression tests are added; do not claim verification before they pass.

The preview also exposes the root, compiler, saved revision, source ZIP and PDF hashes, and shared fixed-category diagnostic guidance (the same classifier as the corpus). It labels older results even while local drafts prevent a refresh, and drops them on observed access revocation. The real browser test covers both a successful raster/PDF build and an intentionally missing dependency. No automatic compiler retry, package installation, input rewriting or shell escape. Existing corpus failures still require source-specific investigation.
