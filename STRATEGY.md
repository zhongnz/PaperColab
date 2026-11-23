# PaperColab platform strategy

**Status** · Proposed for project review, 23 November 2026.

**Decision proposed.** Keep the working LaTeX editor, archive handling and build checks. Set the product direction at the level of a research team and its projects. Decide which collaboration platform to build on after agreeing the governance model and testing the alternatives against it. A specific manuscript workflow can serve as a pilot once those decisions are made.

## Purpose and strategic position

PaperColab should be a free-to-use, open-source, AI-native research workspace. A team should be able to organise a project, bring together its people and evidence, produce and review research in the tools they prefer, and publish or leave with work they can independently use and verify. A manuscript is one important output. Code, data references, analysis runs, figures, notebooks, decisions and contributor records also have a place in the project.

Three constituencies shape the design. **Researchers and co-authors** need a familiar place to contribute, whether they prefer visual editing, markup, code or their own AI. **Research leads** need to understand ownership, dependencies, open decisions and readiness for release. **Institutions and self-hosters** need control of access, data handling, integrations, operating cost and exit. Research groups are the initial design audience. Which constituency pays for a managed service remains an open business decision.

AI-native means an authorised external assistant can receive relevant project context, identify the revision and evidence it used, and return an attributable proposal to the people responsible. The same project should also be usable by a collaborator who brings no AI account. Support for ChatGPT, Claude, Gemini and other tools is a product ambition. Each integration needs its own capability and permissions check.

## Where to compete

**Strategic thesis.** A team should choose PaperColab if it can coordinate research across its existing tools, see which evidence supports a result, and take an accountable decision to release it. Easy authoring, collaboration and export are essential. The proposed advantage is keeping context, authority and evidence connected as work passes between people, AI and applications. Whether this earns adoption is a hypothesis to test.

**What to own and what to connect.** PaperColab should own the meaning of a project, its permissions, durable links among research objects, and its review and release history. Teams should be able to keep their existing reference managers, repositories, notebooks, storage and preferred assistants. A native feature earns investment when it materially improves the team experience or a guarantee PaperColab is responsible for.

**Route to adoption.** Let a contributor join or import existing work with little setup, demonstrate value to the group, then give the research lead and institutional operator a reason to support wider adoption. Measure these decisions separately. A successful individual import gives little information about repeat group use or institutional purchasing.

## Management objectives

| Objective | What management should look for |
| --- | --- |
| Adoption across a research team | Both visual-first and source-first contributors can participate. Measure time to first useful contribution for each group, and count independent teams that return voluntarily after four weeks. |
| Research quality and accountability | A lead can tell which outputs have an owner, which claims require evidence, what changed and who approved release. Sample real project decisions to assess whether those records answer the team's questions. |
| Productive use of AI | Reviewers can understand the evidence and scope behind a proposal, decide it and recover the prior revision. Track review time, stale proposals, corrections and rework alongside acceptance. |
| Portability and trust | Another person can reconstruct a released output from an export and identify its inputs and decisions. Measure source fidelity, reproducibility and export completeness separately. |
| Sustainable stewardship | Track cost per active team, maintainer effort per release, support load and the ability of an independent operator to restore a deployment. Evaluate funding or paid services against the open-source commitments below. |

Avoid a single composite score. A growth or AI-usage metric cannot compensate for lost research data or an unapproved release. Current evidence covers the offline authoring prototype, including a successful edited round trip on one published manuscript. Team retention, willingness to pay and institutional demand still need direct evidence. [Editor verification](https://github.com/zhongnz/PaperColab/actions/runs/45260813525)

## What the platform must be able to support

This capability map sets the design horizon. It gives future features a home and a reason to exist. Delivery order and native versus integrated implementation are separate decisions.

| Capability | Product ambition |
| --- | --- |
| Manage research | Projects and collections, people and roles, ownership, milestones, dependencies, readiness and unresolved decisions across work in progress. |
| Discover and organise knowledge | Sources, notes, search, shared bibliographies and reusable research objects. Keep source identity, version and access conditions with each reference. |
| Connect evidence and computation | Link claims and figures to specific source passages, dataset versions, code revisions and analysis runs. Support external repositories and notebooks as systems of record. |
| Create research outputs | Familiar visual and source editing for writing, equations, tables and figures. Use semantic blocks where independent ownership or review helps. Support additional formats according to their own fidelity requirements. |
| Collaborate and review | Live co-authoring, comments, suggestions, assignments, conflict handling, attributable decisions, history and recovery. Support both draft work and an explicitly approved release. |
| Work with AI and external tools | Bring a chosen assistant or research tool into a project with scoped context, permissions, attribution and revocation. Provide a common way to exchange references and proposals. |
| Publish, reproduce and hand over | Templates, previews, authoritative builds, release snapshots, portable sources, assets, bibliography and evidence records. Assess Word, web, PDF, LaTeX and other outputs independently. |
| Operate and govern deployments | Workspace administration, access policy, data retention, backups, restoration, portability, accessibility, observability and cost management. |

## Who decides

Two forms of governance matter. Product stewardship determines which commitments the software makes. Research governance determines who may act on a particular project. These are proposed roles. One person can initially hold several of them.

| Decision | Accountable role | Operating rule |
| --- | --- | --- |
| Product direction, capability priorities and funding | Product steward, advised by researchers, research leads and operators | Publish outcomes, evidence, trade-offs and decisions for each milestone. Keep a visible register of deferred capabilities. |
| Architecture, compatibility and upstream dependencies | Technical maintainers | Record consequential decisions, alternatives, migration cost and a way back. Review compatibility and maintenance effort before adopting a fork. |
| Releases, open-source contributions and public interfaces | Project maintainers | Publish contribution criteria, release ownership and compatibility expectations. Make the core, its exchange formats and self-hosting path inspectable. |
| Deployment policy, external providers and retention | Workspace or institutional administrator | Set the limits within which projects operate. Make connector access, data egress and recovery responsibilities visible to project owners. |
| Membership, delegation and release approval | Research lead or delegated project owner | Assign roles and owners. Record who may review, approve and publish a particular output. Project grants operate within deployment policy. |
| Scientific judgement, contributor credit and AI proposals | Named human owner or reviewer | Keep the author of a change, its reviewer, the evidence for it and the person accountable for publication distinguishable. Contributor credit and permission to edit are separate records. |

**Open-source and business position.** The proposed public core includes authoring, collaboration, portable project data and self-hosting. Managed hosting, institutional operations and support are funding hypotheses. The product steward should test who benefits, who buys and what it costs to deliver before setting a pricing boundary. A team must be able to recover its research if a hosted service closes.

## How to make investment decisions

1. **Charter and governance.** Agree the audiences, open-source commitments, decision rights, portability promise and what “better” means to a research group. Record the accountable owner, alternatives and assumptions for each open decision.
2. **Capability priorities.** For each proposed feature, record the beneficiary, outcome, related research objects, authority required, existing alternatives, owner and evidence of demand. Identify dependencies and collective value across features.
3. **Information and systems.** Assign one authority for each kind of record, define exchange and recovery requirements, and map the capabilities to services. The companion architecture assessment starts here. [Systems and platform options](docs/platform-architecture.md)
4. **Tools and workflows.** Compare implementation options using the same evidence. Then select representative workflows to validate the architecture across different disciplines, team roles and authoring styles.
5. **Pilot and investment review.** Compare measured outcomes with the charter. The existing pilot proposes 18 successful source round trips out of 20 and three independent groups active beyond week four. Those targets evaluate the authoring pilot. The broader management objectives above require their own evidence. [Existing pilot criteria](https://github.com/zhongnz/PaperColab/blob/473e9874480f896ba0b065d70671ca1a3485c868/docs/pilot.md)

At each investment review the product steward should record a decision to build, integrate, investigate or defer, the reason, an accountable owner and the evidence that would reopen it. This keeps a broad feature portfolio visible while the team delivers in increments.

The first management decisions are the initial audience and economic sponsor, the guarantees every deployment owes its users, and the research capabilities PaperColab must own to keep those guarantees. These decisions determine the architecture brief.
