# PaperColab

PaperColab is an open-source project for writing and reviewing scientific manuscripts together. Its first tool checks a Prism or ordinary LaTeX export before a research group moves its paper.

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
node --test tests/validator.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 tests/browser_smoke.py
~~~

The [pilot plan](docs/pilot.md) contains the interview guide, the two-minute friction log and the criteria for building the collaborative editor. The [manuscript corpus](corpus/README.md) records versioned source candidates and the first published-source inspection.

PaperColab code and its fictional example use the [Apache License 2.0](LICENSE). The offline bundle includes [zip.js 2.25.0](https://github.com/gildas-lormeau/zip.js/tree/9f42e4694a3f72dbdfe8186a2ff3e0f9a226014a) under its [BSD licence](web/vendor/zip-LICENSE.txt). Its vendored zip-core.min.js has SHA-256 e9ac7bba4f42253414278cd1d85ff0fd3b2dc80e06de021c57d9c4173d4b9d9e.
