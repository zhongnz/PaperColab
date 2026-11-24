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
