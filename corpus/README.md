# Manuscript regression corpus

[papers.csv](papers.csv) identifies 20 published or publicly posted manuscripts across six cohorts. The links pin an author repository commit or an arXiv source version. A venue label groups papers by publication family. Inspect the actual class and files in each pinned source before claiming template coverage. One manuscript has passed an original-source build. Nineteen await a baseline. The offline editor regression below exercises that first paper. The full week-eight cohort and collaboration trials remain pending.

## Reproduce the first published-source check

The input consists of the manuscript and its AASTeX class from the authors' repository. These Git blob IDs identify the original bytes.

| Input | Git blob |
| --- | --- |
| document/ms.tex | bcfbba68c3867f2a8eaec96650414a09cb528fdb |
| document/aastex.cls | a8ad35a7a3f16f986a24c349d0e0fbdfa3485794 |

From the PaperColab checkout, run the following commands.

~~~sh
mkdir -p corpus/local
git clone https://github.com/dfm/emcee.git corpus/local/emcee
git -C corpus/local/emcee archive --format=zip 3036b79448cc671d1a1a6c9104b6f0b7c4362850 document/ms.tex document/aastex.cls > corpus/local/emcee.zip
node corpus/check.cjs corpus/local/emcee.zip
~~~

The checker identifies document/ms.tex as the root and follows its local class. It reports one located reference, fourteen TeX-distribution lookups and four macro-generated graphics paths requiring a build. All four point to parameterised figure commands inside the class. There were zero missing literal references in this two-file input. [Pinned source](https://github.com/dfm/emcee/tree/3036b79448cc671d1a1a6c9104b6f0b7c4362850/document)

Each root in the JSON result includes `coverage` for the `.tex` and `.ltx` files reached from that root: editable paragraphs, editable headings, fallback paragraphs, fallback headings, and the commands that kept a paragraph or heading as original LaTeX. Record those fields with the baseline. A paper with a blank coverage record cannot count toward the round-trip target. On 23 November 2026 the pinned `document/ms.tex` had 15 editable paragraphs and 7 editable headings. Fifty paragraph ranges stayed as original LaTeX, and no heading did. The commands recorded on those ranges were `Eq` (1), `Python` (1), `acknowledgments` (1), `acor` (1), `af` (1), `algo` (3), `citealt` (1), `citep` (4), `citet` (1), `citetalias` (4), `clearpage` (2), `eq` (1), `footnote` (1), `keywords` (1), `newcommand` (1), `noindent` (1), `nuisance` (1), `numpy` (1), `paper` (1), `paragraph` (4), `pr` (2), `sect` (2), `sectlabel` (4), `this` (8), `title` (1) and `url` (1). The same counts are in [papers.csv](papers.csv).

On 23 November 2026, the isolated pdfLaTeX job produced a 275,608-byte PDF from that source. The TeX Live 2025 image digest was sha256:dbd65d778eb83de9b45fb0a8deb3afe44cbbaba2272e4e1e644e94dda52c7109. This establishes the baseline for a future import and re-export comparison. [Build record](https://github.com/zhongnz/PaperColab/actions/runs/45254301969/job/137971905975)

## Run the editor round-trip

On a test copy, append a marker sentence through the visual block model and export the ZIP. The check verifies the untouched ZIP byte for byte, the complete edited file outside the paragraph range, every raw block after re-import and the other archive members. Then compile the edited copy with the same root and TeX image.

~~~sh
node corpus/roundtrip.cjs corpus/local/emcee.zip document/ms.tex corpus/local/emcee-edited.zip
python3 scripts/check_build.py --root document/ms.tex --pdf corpus/local/emcee-edited.pdf corpus/local/emcee-edited.zip
~~~

CI also edits the smaller Estuary manuscript through the real browser controls, downloads its ZIP, and checks the new heading and paragraph in the compiled PDF.

## Prepare the remaining sources

Download a pinned source into corpus/local. Keep the original and its licence record. Where arXiv supplies a tar, gzipped tar or a single TeX file, the packer copies regular file bytes into a ZIP and preserves their relative paths. A standalone source takes the name main.tex. Review the ZIP in the browser or run the same checks from a terminal.

~~~sh
python3 corpus/pack.py corpus/local/paper-source corpus/local/paper.zip
node corpus/check.cjs corpus/local/paper.zip
python3 scripts/check_build.py --root main.tex --pdf corpus/local/baseline.pdf corpus/local/paper.zip
~~~

Use the actual root from the report for the build. Record the source revision, ZIP SHA-256, compiler image digest, engine, root, required packages and output PDF. Mark a failed source build separately from an editor regression. Keep manuscript bytes and binaries in the local corpus unless redistribution has been cleared. For the editor trial, compare each original quarantined span byte for byte with its re-export, including comments, spacing and line endings. A static check or a successful original-source build cannot count as an editor round-trip.

## Automated twenty-paper release benchmark

The separate Manuscript compatibility benchmark workflow runs all twenty pinned
sources in four five-paper shards (at most two concurrent). The first uses the
existing pinned emcee checkout; the remaining sources are downloaded as exact
arXiv versions and repackaged without changing file bytes. Downloads have a
bounded size and approved HTTPS host/version; source bytes, logs and PDFs are
not uploaded as artifacts. JSON reports contain hashes, root candidates, source
versions, compiler image identity, coverage, and stage outcomes. Multiple root
candidates are reported unresolved unless a reviewed explicit root override is
provided. No attempt is made to repair a paper or guess its compiler; default
pdfLaTeX, optional manifest engine. A pass requires a successful original build,
byte preservation outside a single supported edit, re-import and source-mode
edit validation, a successful edited PDF build, and the marker in extracted PDF
text. A reachable included TeX file may be edited when the root lacks a supported
paragraph. Missing downloads, baseline failures, unsupported roots, missing
editable paragraphs and edited-build failures all remain separate statuses.
The aggregate job fails below 18/20, and rejects missing or duplicate results.
This is a diagnostic release gate, not a claim that the corpus currently passes.
TeX execution remains in the existing isolated Docker verifier. The actual
image ID and repository digests are recorded, and the tag is checked for changes
at the end of each successful trial; no image pulls occur during verification.

Local example (Docker, Node, Python and pdftotext required; pre-pull the TeX image):

~~~sh
python -m corpus.benchmark --shard 0 --work corpus/local/benchmark --report corpus/local/report-0.json --emcee corpus/local/emcee
# Repeat for shards 1–3 with new directories or the unused shard folders.
python -m corpus.summarize --require-gate corpus/local/report-*.json
~~~

Only the reports are retained in CI. Review source-specific licensing before
redistributing any manuscript or compiled PDF. This benchmark exercises the
shared browser parser/export model, not twenty real browser sessions or hosted
collaboration tests. The existing browser tests separately exercise real UI.

Coverage percentage applies only to classified paragraph ranges in inspected files; full-file parser fallbacks and unreadable sources can remain uncounted. The aggregate report makes this limitation explicit. The new multi-file fixture tests the same target and round-trip commands, including rejection of unreachable files.

## First complete benchmark and targeted improvements

The first full run (690a9be, 24 November 2026, [CI record](https://github.com/zhongnz/PaperColab/actions/runs/45424196170)) acquired all twenty sources: 8 passed, 8 failed original-source compilation, 2 had unresolved roots, and 2 compiled but had no editable paragraph. Classified paragraph coverage was 33.1% across 18 inspected papers. All eight papers that reached an edited build passed. This is not evidence of broad compatibility. PPO v1 is a PDF-inclusion wrapper; a visual LaTeX editor cannot recover the absent editable manuscript from that wrapper. The other no-editable case (diffusion) needs parser investigation. Multiple candidate roots in MAML and BART require inspection; no filename-based guesses are made.

Next reports classify build errors using a fixed diagnostic vocabulary, include root-candidate coverage and full-file parser fallback reasons, and count whole-file fallbacks separately. Diagnostic classification is heuristic; inspect original logs locally when necessary. Expanded protected one-brace citation variants and conservative literal HTTP(S) URL tokens improve supported prose without expanding custom macros, optional arguments or comment-containing ranges. Untouched source remains authoritative. No paper is replaced to improve the denominator, and no build safety controls are relaxed. Re-run the same corpus to measure the change.

The 4508337 run again passed 8/20, with classified coverage 33.4%. The initial shell-escape diagnostic was invalid because it matched the normal compiler command. The next increment filters command/status lines and requires a positive indication of missing shell escape; it does not enable shell escape. Ambiguous roots may now resolve only if a unique literal title begins with the pinned bibliographic title and the candidate contains a class and document body; ties stay unresolved. The selection basis and all candidate title evidence are reported. Added protected literal optional citation notes, simple footnotes, labels, and selected inline text commands. Complex arguments, comments, custom macros and full-file conditional fallbacks remain conservative. No successful build or coverage improvement is claimed until the next run completes.
