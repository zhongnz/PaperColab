# PaperColab

PaperColab is an open-source project for writing and reviewing scientific manuscripts together. The workspace is a self-hosted project service: people suggest visual or source edits, a reviewer accepts them, and a lead approves a release that stays fixed. The offline editor still opens a LaTeX ZIP on one machine and exports the original bytes around each edited span.

## Run the workspace

```sh
PAPERCOLAB_DEMO=1 PAPERCOLAB_DATA=data/demo python3 -m server
```

Open http://127.0.0.1:8787/. The demo opens Estuary Field Notes on an editable cell. Choose **Demo role** to switch among Ada (lead and operator), Bao (author), Iris (reviewer) or Quill (assistant). Demo mode listens on a loopback address.

- Choose a file and cell in **Manuscript cells**. Changes in Visual and LaTeX update the same draft. When LaTeX is incomplete, Visual keeps the last valid version while you finish the edit.
- **Propose cell edit** submits the draft for human review. Unsubmitted drafts stay in this browser when you switch cells or reload. A conflicting accepted edit leaves the draft available for reconciliation.
- A lead can add a heading or paragraph next to a selected cell, move cells within a file, and assign ownership. You can start with a new manuscript or import a LaTeX project ZIP under **Add or find a project**.
- Open **Preview manuscript** to read the cells together in manuscript order. Select **Build PDF** to compile the chosen main file with its includes, figures, and bibliography. **Include saved drafts** layers your valid local cell drafts over the accepted revision for preview. A PDF build leaves that revision and the review queue unchanged.

A suggestion, whether it comes from the visual editor, the source editor, or `POST /api/mcp`, is the same review record. It names the person or assistant, the revision they saw, and the block. The manuscript changes only when a human reviewer or lead accepts it. Two overlapping edits of one block both stay pending; accepting one marks the other stale instead of merging the text. A split that stops being one block stays for review. Moving a block keeps its id, so a comment anchor still resolves. A release ZIP and its manifest stay byte-for-byte the same after later draft edits.

The SQLite database is `data/papercolab.sqlite`. An operator can back it up, restore it, turn AI proposals off, set how long unreleased projects are kept, and read the audit log. Without demo mode, the first start provisions an operator using `PAPERCOLAB_OPERATOR_TOKEN` or writes the initial key to `data/operator-token`. The offline checker remains at http://127.0.0.1:8787/index.html and does not call the service.

## Host a workspace

Deploy the repository with the [Render Blueprint](render.yaml), or build the [container image](Dockerfile) for a Docker host. The blueprint provisions one paid web service with a persistent disk at `/var/lib/papercolab`. Render generates the initial `PAPERCOLAB_OPERATOR_TOKEN` and serves the workspace over HTTPS. Find the key in the service's Environment settings and use it to sign in. The key provisions an operator only when the database is empty.

To check the hosted runtime locally with Docker:

```sh
docker build -t papercolab .
docker volume create papercolab-data
docker run --name papercolab -p 127.0.0.1:8787:8787 \
  -v papercolab-data:/var/lib/papercolab papercolab
```

Read the initial key with `docker exec papercolab cat /var/lib/papercolab/operator-token`. A public deployment needs an HTTPS reverse proxy and `PAPERCOLAB_PUBLIC_ORIGIN` set to the external origin. Keep the named volume across deploys and keep operator backups off the host. Run one application instance per SQLite database. Use `/api/health` for the hosting provider's readiness check.

A project lead can create an author, reviewer or reader invitation under **Manage access**. Each link works once and expires after seven days. The person accepting it gets a browser session and a sign-in key they can save for another device. Leads can update or remove project access from the same panel.

For in-app PDF builds, run the workspace on Linux with Bubblewrap, user namespaces, and a system TeX Live installation, or on a host with the TeX Live Docker image already available. `PAPERCOLAB_PDF_RUNNER` accepts `auto` (default), `bubblewrap`, `docker`, and `off`. PDF builds use an isolated workspace with no network. The combined manuscript view works without a compiler.

## Edit a manuscript

Open **web/index.html** and select **Open example editor**. For your own paper, choose a project ZIP, select a manuscript root and click **Edit manuscript**. The outline lists the files and blocks. Choose a paragraph or section heading to edit.

- Type in the visual pane or use bold and italic. The LaTeX pane follows each visual change. Citations, references and inline maths appear as protected tokens.
- To change a token or fine-tune source, edit the LaTeX pane and click **Apply source**. Invalid or multi-block source stays in the draft until corrected or discarded.
- Tables, display equations, custom macros, preambles and complex blocks appear as read-only LaTeX. **Revert block** restores its exact input. Visual undo and redo operate within the current block.
- **Export project ZIP** saves the project. Edits are held in this tab’s memory. Export before closing the tab or handing the paper to a co-author.

An untouched project exports as the original ZIP bytes. After an edit, PaperColab rewrites only the chosen source spans. It may reflow whitespace inside a visually edited paragraph. Original line endings, comments and bytes outside the edited spans are preserved, including the content of every other file. Edited ZIP containers may have different ZIP metadata. Visual editing covers UTF-8 source files up to 512 KiB. This offline page is single-author. Review and release happen in the workspace.

## Check an export

Open **web/index.html** in a current Chrome, Edge, Firefox or Safari with native raw-deflate support. Choose a ZIP, drop it on the page, or select **Inspect example**. No account, server or installation is needed. All assets ship with the tool. It reads the selected file on your device and retains the session in memory.

Select a manuscript root to see which sections, figures and bibliographies it references. Findings include the referring filename and line. In a multi-project archive each root has its own report. **Save report** downloads a JSON record for the selected root plus the archive inventory. The report includes filenames and reference targets. Manuscript prose and conversation bodies stay out of the report.

To distribute a single offline HTML file, use Python 3.11 or later.

~~~sh
python3 scripts/package.py --html PaperColab.html
~~~

## Verify a PDF build

The browser reads ZIP data and checks literal references. A TeX engine resolves packages, dynamic paths and macros. The optional verifier runs TeX Live in a local Linux container using Docker and returns a newly built PDF. You can try the complete flow with the included example.

~~~sh
python3 scripts/package.py --zip estuary-example.zip
docker pull texlive/texlive:TL2025-historic
python3 scripts/check_build.py --root estuary/main.tex --pdf checked.pdf estuary-example.zip
~~~

For another project, use the root shown in its browser report. The verifier defaults to pdfLaTeX. Use `--engine xelatex` or `--engine lualatex` when the manuscript requires it. Docker must have the image locally before the job starts. Input arrives on standard input. The job has a read-only root filesystem, temporary writable storage, a non-root user, no host mounts and no network. It ignores project latexmk configuration and disables shell escape. Projects that require a custom build step need a separate review. Compare the resulting PDF's pages, equations, figures and citations with the last known good PDF.

See the [TeX Live image](https://hub.docker.com/r/texlive/texlive/) and [Docker runtime options](https://docs.docker.com/reference/cli/docker/container/run/).

## What the report covers

| Check | Behaviour |
| --- | --- |
| Archive integrity | Reads every regular entry and checks its CRC and size. Rejects invalid ZIPs, unsafe or duplicate paths, encrypted files and special files. |
| Manuscripts | Finds candidate roots from a document class or document environment. Follows literal inputs, includes, subfiles and local classes and packages. An included file can also be a standalone root. |
| Assets | Checks literal graphics paths and common graphics extensions, BibTeX files and biblatex resources. Reports TeX-distribution package lookups separately. Macro arguments, conditional layouts and vendor-specific commands still need the build check. |
| Metadata | Inspects JSON structure, counts conversation files and reports recognised entries in export-errors.json. Unrecognised or malformed logs require inspection of the original. |
| Limits | Up to 64 MiB compressed, 256 MiB expanded and 4,000 entries. Source/metadata inspection uses UTF-8 and up to 4 MiB per file and 32 MiB in total. Large or non-UTF-8 individual text files receive a finding. Nested ZIPs can be opened separately. |

Keep the original ZIP and a reference PDF. Project history, permissions and live Zotero connections have their own migration requirements. [OpenAI's Prism migration guide](https://help.openai.com/en/articles/20001615-prism-to-codex-migration-guide)

## Development and pilot

Run the archive and build tests with Node 22+ and Python 3.11+. The two trusted example build tests also need latexmk, pdfLaTeX, BibTeX and booktabs. The browser integration check uses Playwright for Python and Chrome or Chromium.

~~~sh
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 tests/browser_smoke.py
python3 tests/editor_browser.py --output-zip build/editor-edited.zip
python3 tests/project_browser.py
~~~

The [pilot plan](docs/pilot.md) contains the interview guide, the two-minute friction log and the criteria for building the collaborative editor. The [manuscript corpus](corpus/README.md) records versioned source candidates, the first published-source inspection, and each paper's visually editable paragraph and heading counts.

### Open-source components

| Component | Role in PaperColab |
| --- | --- |
| [Tiptap 3 and ProseMirror](https://github.com/ueberdosis/tiptap) | Visual block editing, selection, formatting and undo |
| [CodeMirror 6](https://github.com/codemirror/dev) | Editable LaTeX source with syntax highlighting and line numbers |
| [unified-latex](https://github.com/siefkenj/unified-latex) | Parse LaTeX and locate source spans |
| [zip.js](https://github.com/gildas-lormeau/zip.js) | Verify archives and preserve compressed data for untouched files |

PaperColab owns the mapping between manuscript blocks and original source ranges. To rebuild the editor libraries, use Node 24 and run `npm ci --ignore-scripts` followed by `npm run build:vendor`. CI checks that the resulting bundles and notices match the checked-in copies. Opening the app requires no npm install or remote services.

PaperColab code and its fictional example use the [Apache License 2.0](LICENSE). The bundled editors and parser ship with [per-package third-party notices](web/vendor/editor-NOTICES.txt). The bundled zip.js 2.25.0 has its own [BSD licence](web/vendor/zip-LICENSE.txt). The single-file distribution includes the same notices.
