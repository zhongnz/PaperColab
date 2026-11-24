# PaperColab v0.1: controlled local researcher pilot

**Status:** recruitment and testing protocol, not completed research or a
public/private hosted alpha. Use the verified compiler baseline
[b0bf198](https://github.com/zhongnz/PaperColab/tree/b0bf1983acf92fbe4417417f2033cfc4dc46aee4).
All three ordinary CI workflows passed at this SHA, including actual PDF
preview and EPS/bibliography fixtures. The latest completed twenty-paper
fidelity result before this baseline was 8/20 with 34.6% classified prose
coverage; the gate is not met. Use the pilot tools on their own verified
commit once their CI passes. Keep the authoritative paper in its existing
system. Do not expose the loopback server to the internet.

## Phase A: recruit and qualify

Proposed sample: three independent groups, initially one author and one
reviewer or lead per group. Recruit one LaTeX-fluent writer and one person
who prefers visual editing where possible. Use a public or expressly
approved non-sensitive manuscript ZIP, not unpublished confidential
results, identifiable participant data or a live submission project.
Participation is voluntary; do not collect identifiable research content,
record the screen or send it to an AI provider. Obtain permission before
taking notes. Use aliases; keep contact details separately and privately.

Before the session, ask participants to show a recent writing/review or
export task in their existing tool and explain what went wrong (if
anything). Record baseline workflow, self-reported friction, and whether
they have a known-good PDF. The facilitator checks the actual source
build on the same isolated compiler. If that fails, record an original-build
blocker rather than testing that paper as a successful editable migration.
Use the bundled estuary fixture for the practice task, not as evidence of
real-paper migration.

## Phase B: isolated local workspace

Prerequisites: Python 3.11+, Node 22+ (CI Node 24), a recent browser, Git;
Docker Desktop or Engine with local Linux containers and pre-pulled
TeX Live for compilation. Do not require model keys. Only use trusted
research copies. For Windows PowerShell:

~~~powershell
git clone https://github.com/zhongnz/PaperColab.git
cd PaperColab
git checkout feature/block-native-editor
# Check CI at the intended SHA before using the tools. Pin that SHA.
git rev-parse HEAD
docker pull texlive/texlive:TL2025-historic
New-Item -ItemType Directory -Force pilot-local
$env:PAPERCOLAB_DATA = Join-Path (Get-Location) ("pilot-local\session-" + [guid]::NewGuid())
Remove-Item Env:PAPERCOLAB_DEMO -ErrorAction SilentlyContinue
Remove-Item Env:PAPERCOLAB_EXPERIMENTAL_CRDT -ErrorAction SilentlyContinue
$env:PAPERCOLAB_HOST="127.0.0.1"
$env:PAPERCOLAB_LOCAL_PDF_PREVIEW="1"
python -m server
~~~

Record and pin the exact checked-out SHA in the private session log
(and use git checkout --detach followed by that SHA for repeat sessions);
before using it, verify green ordinary workflows at that SHA. A fresh data
directory avoids mixing demo accounts or prior research. The terminal
prints a local operator credential. Keep it off shared notes/screenshots.
Open http://127.0.0.1:8787/ and sign in. Create a project and provision named
human test accounts; add them as author and reviewer in Settings. Use
separate browser profiles on the same trusted machine to simulate
collaboration. Do not share the operator token or open a tunnel. This is
a facilitated local test, **not** remote multi-user hosting. Turn off AI
proposals for the human-only session where appropriate; do not invoke
external models. Durable local draft storage is unencrypted: leave it off.

## Phase C: qualification and session

Place the disposable original ZIP in the ignored pilot-local directory,
retain an independent original outside the repository, and choose a
detected root using the offline inspector. Run the following in another
terminal from the repository; replace the example path/root/engine with
the actual selected paper:

~~~powershell
python -m scripts.pilot_check pilot-local/original.zip --root main.tex --engine pdflatex --build --report pilot-local/preflight.json
~~~

Only baseline-ready means the selected root compiled and contains at
least one classified editable paragraph. Static inspection alone is not
enough. A failure is a useful data point; do not replace failing papers
silently. The script uses temporary exact copies; it does not upload or
rewrite the originals. Reports contain filenames and hashes and are
private. The original ZIP must never be re-exported over itself.

Suggested 35–45 minute moderated test (time-box; do not coach until a
participant is blocked). Use the same two edits in the incumbent tool
when practical. Record actual task completion and time, not estimates.

| Task | Observable completion evidence |
| --- | --- |
| Import and select root | Original builds, project and root open, participant identifies editable vs preserved content |
| Visual edit | One ordinary prose change saved; protected reference/math remains |
| Cell and source views | Find the same cell, make one supported source edit, verify visual change; record any unsupported content |
| Collaboration | Second browser profile edits a different cell; then authors try a stale edit in the same cell and observe conflict handling |
| Review | Reviewer anchors a comment and accepts an explicitly proposed edit; author locates review history |
| Compilation | Compile saved revision, see page(s), download full PDF, recognise outdated preview after another save |
| Export | Download a new ZIP; compare with original and review the intended changes; preserve authoritative manuscript |
| Debrief | Ask what they would reuse, what prevented completion, and what they would not trust |

Use actual named test accounts for roles; an operator is not a substitute
for a reviewer. Record each result as unassisted, assisted, blocked or
not attempted. On any lost text, unexpected source change, access
control issue, or unapproved data egress, stop the session, preserve the
original, document a de-identified incident and do not continue editing
the real-paper copy. Do not hide source-only fallbacks or ask a
participant to copy private content into an issue.

## Phase D: verify the export and debrief

Before editing, agree on the permitted TeX file paths. Download the
export under a new filename. For example:

~~~powershell
python -m scripts.pilot_check pilot-local/original.zip --root main.tex --engine pdflatex --edited pilot-local/edited.zip --allow-changed main.tex --allow-changed sections/results.tex --build --report pilot-local/export-check.json
~~~

The comparison hashes every regular archive member, refuses unexpected
additions/removals/changes, and verifies original and edited builds under
matching compiler image, engine and recovery profile. The approved-file
list does not authorise arbitrary changes inside those files: inspect a
local diff and the actual PDFs side by side, especially equations,
citations, tables, figures and cross-references. The script does not
prove page equivalence or byte preservation within approved files. ZIP
container metadata may differ. **review-required** means only that the
machine checks passed; a person must approve the actual changes. Do not
submit the resulting paper to a journal from this pilot.

Ask: Which task was more or less difficult than your usual workflow?
Where did you switch back to source? Would you use this again for a real
section if the blocker were fixed? What would prevent adoption? Record
one concrete example rather than treating stated interest as retention.
Offer a second voluntary session after week four; count only actual
author/reviewer activity as retention.

## Phase E: evidence and decisions

Copy [pilot-session-template.csv](pilot-session-template.csv) and
[pilot-task-template.csv](pilot-task-template.csv) to the ignored local
directory, and use the existing [friction log](friction-log.csv). Store
private notes securely, do not commit data/ZIPs/PDFs or reports. No
telemetry is collected by these tools. Share only consented, de-identified
aggregate counts (including failed and not-attempted tasks); never names,
manuscript titles, file paths, hashes, token values or raw logs. Agree
retention with participants; by default remove disposable local copies
and credentials after verification, keeping the independent original.
Stop the local server before removing its separate database; deletion
does not guarantee erasure of filesystem backups or browser storage.

Proposed pilot decision criteria (not achieved outcomes):

- Zero known data-loss, access-control or unintended disclosure incidents
  in pilot sessions; pause on any critical incident.
- At least 80% of attempted core tasks completed unassisted, with
  assisted/blocked/not-attempted denominators reported separately.
- Every export accepted for the pilot passes machine comparison/build
  checks and explicit human source/PDF inspection.
- At least three independent groups voluntarily return after week four
  before claiming retention. The existing 18/20 fidelity release gate
  and production identity/deployment gates remain separate and unmet.

Treat early results as qualitative discovery, not a representative
statistical claim. Prioritise repeatable blockers in the next iteration.

The ordinary export workflow also runs the new pilot verification CLI on the existing browser-edited sample ZIP with actual Docker builds. These automated fixtures establish tool behaviour, not user adoption or usability evidence.
