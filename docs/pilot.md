# PaperColab pilot and implementation plan

The first decision is whether a research group can move a manuscript into PaperColab, edit it with co-authors and get a publishable LaTeX project back. Keep each active paper in its team's existing writing environment while testing copies of representative sections.

| Stage | Deliverable | Evidence for proceeding |
| --- | --- | --- |
| Weeks 1–2 | Offline export checker, repeatable source corpus, 15–20 interviews across four settings | Record the most recent incident for each participant, confirm the existing workaround and establish a source-build baseline for each corpus entry. |
| Weeks 3–8 | Block-scoped visual and LaTeX editing, stable block IDs and owners, anchored reviews, per-block server permissions, sync, bibliography import and isolated PDF builds | At least 18 of 20 papers round-trip and compile, each with its editable paragraph count, editable heading count, and fallback commands recorded. Every quarantined byte span remains intact. At least three independent groups stay active voluntarily beyond week four. Concurrent visual and source edits survive sync and reconnect. |
| Months 3–6 | Bring-your-own-model review and a scoped MCP interface for reading, comments and revision-checked suggestions | At least 30% of weekly active collaborators use AI review. At least 70% of proposals resolve cleanly. Test tenant isolation, block permissions and build isolation before a public launch. |
| Months 7–12 | Claim-to-source links, read-only research connectors and institutional self-hosting | Three paid institutional or corporate pilots, or grant funding alongside at least 2,000 weekly active open-source users. |
| Months 13–18 | Administration, deployment and audit controls | Implement controls requested by buyers in the preceding pilots. |

## Keep the survey moving

Retain the current shared manuscript as the publication copy. Ask contributors how they actually prefer to draft prose, equations and tables. If at least five avoid raw LaTeX, use section-sized collaborative documents with a shared Zotero bibliography and two production editors for final LaTeX assembly. A LaTeX-fluent team can compare a copy of one section in an alternative environment. Move two sections into the eventual PaperColab pilot after a baseline build exists. Keep an owner and an acceptance decision for each section.

## Discovery interviews

Recruit across a CS/AI group, an engineering or physics group, a biomedical or quantitative social-science group and a university IT or library team. Include a section author and the person responsible for final submission. Record de-identified evidence privately. The public repository holds the instruments and aggregate results.

1. Walk through the last change you made with a co-author. Where did the draft start and where did it finish?
2. Show the most recent edit, comment, citation or build that required rework. How did you notice it? Who fixed it and how long did it take?
3. Which parts of a section could a reviewer edit directly? For which changes would you need to approve a suggestion? What happened the last time an AI tool touched the draft?
4. Which artefacts must survive an export before you would switch? What would you compare to tell?
5. For IT and library buyers, who approved the last comparable tool, which budget paid for it, and what evidence was required for a pilot?

## Two-minute weekly friction log

Keep one row per incident in a private copy of [friction-log.csv](friction-log.csv). Record the week, group and section aliases, task, time lost, consequence and workaround. Choose among edit or comment collision, AI copy/paste round-trip, evidence lookup, a compile failure taking over 15 minutes, or another observed problem. Use a row marked “none” to distinguish an incident-free active week from a missing response. Turn repeat incidents into testable acceptance cases.

## Week-eight evaluation

Freeze the 20-paper cohort and its baseline evidence before testing editor changes. Use the same TeX engine and image for both builds. Compare source bytes, especially spans the visual editor treats as raw LaTeX. Save the input and output hashes, compiler exit status and a PDF comparison for each paper. Compile and inspect at least one example containing each of a multi-file input tree, custom macros, booktabs/multirow material and TikZ. For each paper, record the editable paragraph count, the editable heading count, and the commands that kept a paragraph or heading as original LaTeX. `node corpus/check.cjs` prints that record in `coverage`. A paper counts toward the 18 round trips only after those numbers are recorded. Editing one supported paragraph does not measure the remaining prose.

For the co-editing check, have two participants edit different blocks and then the same block from different modes. Test a move, an anchored comment and reconnecting after offline edits. Compare both clients with the exported source and review history. Count a group as retained when someone voluntarily returns to author or review after week four. Keep actual interview, retention and test counts separate from recruitment targets.

If the week-eight checks fail, keep working on source fidelity and collaboration. The offline prototype covers one author editing a paragraph or heading and exporting with the surrounding source intact. The next collaboration milestone is a comment anchored to a persistent block ID that two authors can resolve after editing and reconnecting. Expand the manuscript corpus alongside that work.

## Current controlled local testing

Use the [local pilot protocol](local-pilot.md) and its private session/task templates for the first facilitated sessions. The protocol distinguishes actual source/PDF verification, task completion and observed retention from recruitment targets. It does not supersede the twenty-paper or production deployment gates.
