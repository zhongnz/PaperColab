# Systems and platform options

**Decision status** · Proposed architecture direction. Platform selection is open. Reviewed 23 November 2026. [Product strategy and governance](../STRATEGY.md)

## From management commitments to system boundaries

| Commitment | System responsibility | Evidence required before committing to a platform |
| --- | --- | --- |
| A research lead can govern a project | Workspace, project and object identities, membership, delegated roles, approval and release records | A policy can be applied consistently through the browser, an integration and the export process. Membership changes take effect for each route. |
| Every released claim can carry its supporting evidence | Versioned research objects, relationships and provenance | Follow a sampled claim to a particular source passage, figure, run or dataset version and identify its owner. A changed input makes the earlier relationship inspectable. |
| People can create in different modes | Authoring clients, format adapters, assets and per-object synchronisation | Visual and source edits converge and retain review context across a move, reconnect and restore. Original or opaque source spans remain recoverable. |
| External assistants and tools act with accountable authority | Permissions, connectors, credential handling, proposal and review services | A proposal identifies its actor, evidence and base revision. Revocation, stale proposals and human decisions have observable outcomes. |
| A team can publish, reproduce and exit | Release manifests, isolated build workers, versioned storage, interoperable exports and recovery | Restore a released project in a fresh environment. Verify its source, required assets, review decisions and outputs. |
| An operator can run the service sustainably | Storage, deployment, monitoring, backups and operating-cost controls | An independent operator can install, upgrade, restore and estimate cost at a documented team size. |

## Information architecture

The organising unit is a **research project**. A project contains or references documents, sections and blocks, sources, datasets, code revisions, notebooks, analysis runs, figures, claims and releases. Each object that people can own, cite, review or release needs a stable identity. Revisions identify its state at a particular time. Paths and display names can change.

| Information | Proposed authority |
| --- | --- |
| Membership, policy, review decisions and releases | The project service records explicit decisions, their actor, scope and revision. The server checks authority on each mutation. |
| Source text and assets | Each document type declares one authoritative editable representation. Visual and source panes translate edits against that representation. Retain imported bytes and protect unsupported constructs when exact export is promised. |
| Structured review and evidence | Store links between versioned objects and explicit anchor status. An unresolved anchor remains visible to reviewers. Decisions refer to the version actually reviewed. |
| External research data | Preserve the external system's identifier, version and access rules. Record whether PaperColab holds a reference, authorised cache or independently owned copy. |
| Generated output | A build or analysis produces an artefact tied to its inputs and toolchain. A release freezes the chosen versions, human decision and export manifest. |

A contributor can be credited for analysis without gaining release authority. Similarly, reading a manuscript need not grant access to the dataset behind a figure. Decide these rules in the project and deployment policies before selecting a database schema. For interoperability, evaluate W3C PROV for evidence lineage, CRediT for contributor roles and RO-Crate for packaging research objects with metadata. [W3C PROV](https://www.w3.org/TR/prov-overview/) · [CRediT](https://credit.niso.org/) · [RO-Crate](https://www.researchobject.org/ro-crate/)

## Proposed system shape

Start with one self-hostable product and clear responsibilities. The project service owns membership, policy and decisions. Authoring clients and synchronisation operate on versioned objects. Integrations translate external identifiers and actions through the same authority checks as the user interface. Builds and computational jobs run in isolated workers. Portfolio views, search and reports are derived from authorised project records. These boundaries can initially share one application and database.

A project may need a jointly edited document, an immutable dataset in an institutional repository and an approved release at the same time. They have different lifecycles. Keeping those distinctions explicit leaves room for new tools without requiring every research object to become an editable text block.

## What the current implementation establishes

| Existing work | Keep and reuse | Limit of the evidence |
| --- | --- | --- |
| Archive inspector and isolated TeX build | Project import, reference checks, human-readable findings and a reproducible publication check | A compiling PDF establishes buildability. Scientific validity, journal acceptance and complete project provenance require other evidence. |
| Tiptap, CodeMirror and the LaTeX source-range model | Familiar visual editing and precise source changes with preserved raw spans | The prototype edits a subset of LaTeX. Durable shared identity, ownership and review authority need a service beyond the current prototype. |
| Export regression and manuscript corpus | Byte comparisons, edited PDF checks and pinned source examples that can test any future platform | The pinned emcee manuscript has an edited build: 15 visually editable paragraphs, 7 editable headings, and 50 paragraph ranges kept as original LaTeX. The 20-paper corpus target and real-team trials remain open. |

The current parser numbers blocks in parse order. The browser holds edits in a session map. These choices work for an offline tool. A shared service must be able to identify the same object after an edit, move or reconnect, and decide who may change it. Keep the parser's offsets as coordinates into a particular source revision. Give persistent objects their own identity. [Block parser](https://github.com/zhongnz/PaperColab/blob/main/web/blocks.js) · [Workspace state](https://github.com/zhongnz/PaperColab/blob/main/web/workspace.js) · [Verified builds](https://github.com/zhongnz/PaperColab/actions/runs/45260813525)

## What LibrePaper changes

LibrePaper is a credible platform candidate as well as a product benchmark. Its browser already covers shared multi-file writing, comments, tracked changes and version history. Desktop adds computational notebooks and local Zotero integration. Its current agent documentation also describes remote MCP connections with distinct roles and a default suggestion role. Remote agent access is already part of the competitive baseline. [Feature matrix](https://librepaper.org/) · [Agent connections](https://librepaper.org/agents.html)

Three design details matter more than the number of features.

| Upstream design | Decision for PaperColab |
| --- | --- |
| A project uses a Loro collaborative document. Files have stable IDs, and review anchors can follow text across edits and moves. PostgreSQL and an object store persist project state. | Test whether durable semantic blocks, claim-to-evidence links and object-specific grants can be added without creating two editable copies or two competing permission systems. [Document model](https://librepaper.org/architecture/document.html) · [Review model](https://librepaper.org/architecture/review.html) |
| Share links give roles over the project. Upstream tracked edits enter its draft text immediately, and exports include pending changes. | Specify the scope at which authority is granted and how an approved release is selected. A working draft and the release approved by a research lead may need different revisions. [Sharing](https://librepaper.org/collaborate.html) · [Tracked changes](https://librepaper.org/architecture/review.html#track-changes) |
| The upstream editor normalises imported line endings to LF. PaperColab's tested LaTeX export retains original bytes outside edited spans. | An integration needs an original-byte record and a mapping to the editable text wherever the export fidelity guarantee applies. Test mixed line endings and unsupported LaTeX before moving an existing manuscript. [Pinned upstream source](https://github.com/LibrePaper/librepaper/blob/c74c348d926d9b06f54da52ffb2ea18141267ba5/web/src/lib/line-endings.js) |

These findings come from the published documentation and the pinned upstream source. Deployment cost, implementation effort and compatibility with PaperColab's governance model still need a comparative trial. [Upstream revision reviewed](https://github.com/LibrePaper/librepaper/tree/c74c348d926d9b06f54da52ffb2ea18141267ba5)

The local cell trial does not select LibrePaper. It has not met the three contracts in the strategy: the same review authority for visual and source edits, a defined result when offline edits overlap, and a public anchor API. [Contracts the LibrePaper trial has not met](../STRATEGY.md#contracts-the-librepaper-trial-has-not-met) · [Pull request 4](https://github.com/zhongnz/PaperColab/pull/4)

## Platform choices

| Option | When it earns investment | Main cost or uncertainty |
| --- | --- | --- |
| Extend LibrePaper and contribute changes upstream | Its existing collaboration, history and agent interfaces can honour the agreed authority, evidence and release contracts through maintainable extension points | Roadmap alignment, dependency upgrades and how much the underlying project model must change |
| Keep an independent PaperColab core and interoperate with LibrePaper and other tools | Project governance and versioned evidence belong above several authoring systems, and documented interfaces can carry the needed identity and revisions | Mapping permissions, changes and provenance across systems and reconciling disconnected work |
| Build a PaperColab collaboration core with open-source components | The mandatory contracts fail on existing platforms or integration introduces more complexity than operating the service directly | Owning sync, recovery, permissions, upgrades and support for every supported workflow |
| Maintain a long-lived LibrePaper fork | A necessary change cannot be accepted upstream, and a named team can fund and test the divergence | Permanent merge, compatibility, release and support responsibility |

Evaluate extension and interoperability first. A PostgreSQL and Yjs/Hocuspocus service remains a candidate for an independent core. That proposal is not recorded in this repository. Keep the working editor as a reference client and its fidelity tests as a common benchmark under every option.

## How to choose

First agree the essential outcomes and decision rights in the strategy. Then give each candidate the same set of acceptance questions. Can it enforce project and object authority across entry points? Can it preserve identity, review decisions and evidence across revisions? Can it distinguish an AI proposal from approved work? Can a team recover and export a complete release? What would adoption, upgrades and ongoing operation cost?

Record a result, a reproducible demonstration and any required changes for each essential contract. Mark untested claims as open. Use representative workflows across authoring, evidence management, review and publication to gather that evidence. Choose the smallest sustainable platform that meets the agreed contracts. Revisit the choice when those contracts or the upstream implementation change.
