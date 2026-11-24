# Manuscript regression corpus

[papers.csv](papers.csv) identifies 20 published or publicly posted manuscripts across six cohorts. Each source is pinned to a repository commit or an arXiv version. The manifest records the intended manuscript root, compiler, and measured visual coverage. Venue labels group papers by publication family.

## Check the full corpus

Use Python 3.12 or later and Node 24. The runner downloads pinned source bytes, prepares a ZIP, runs the browser's inspection and block parser, and attempts one visual paragraph edit. It verifies an untouched archive byte for byte, an edited archive outside the chosen range, and quarantined ranges after re-import. If the root has no editable paragraph, it also checks reachable `.tex` and `.ltx` files.

~~~sh
python3 corpus/run.py --no-build
python3 corpus/run.py --offline --no-build --paper emcee
~~~

For the full check, install Docker and `pdftotext` from Poppler. Pull the pinned TeX Live image and tag it for the existing isolated builder.

~~~sh
PAPERCOLAB_TEX_IMAGE=texlive/texlive@sha256:dbd65d778eb83de9b45fb0a8deb3afe44cbbaba2272e4e644e94dda52c7109
docker pull "$PAPERCOLAB_TEX_IMAGE"
docker tag "$PAPERCOLAB_TEX_IMAGE" texlive/texlive:TL2025-historic
python3 corpus/run.py --require-passes 18
~~~

The original and edited ZIPs build independently with the same pinned image, engine, and root. The JSON report records separate outcomes for downloading, inspection, the source round trip, each build, and PDF comparison. It includes hashes, page counts, coverage, and diagnostics. The comparison checks that the edit marker appears in the edited PDF alone. It also reports whether extracted text matches after removing that marker. A full pass requires both builds, a passing comparison, and coverage recorded for all reached manuscript sources.

Downloads, ZIPs, PDFs, and JSON reports live in the ignored `corpus/local/gate1/` directory by default. Use `--report PATH` to write the report at a known location. The manual [Gate 1 workflow](../.github/workflows/corpus.yml) runs the same commands and uploads the JSON report.

## Measured source coverage

On 23 November 2026 all 20 sources were downloaded and inspected. Nineteen passed the byte-preserving visual round trip. The editor preserves balanced standalone TeX groups and skipped conditionals as exact source ranges in Denoising Diffusion Probabilistic Models, Generative Adversarial Networks, Model-Agnostic Meta-Learning, and ChainForge. Proximal Policy Optimization v1 packages a PDF and a TeX wrapper for it, with zero editable paragraphs. The pinned MAML and BART archives contain additional `.tex` roots. Their canonical publication roots are `senstive.tex` and `main.tex`, respectively.

Docker was unavailable during that measurement. The historical emcee original-source build is recorded below. The paired isolated PDF checks still need evidence for this run.

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

The current editor identifies 22 editable paragraphs and 11 editable headings in the pinned `document/ms.tex`. Forty paragraph ranges and zero headings remain raw. The byte round trip preserves another 22 raw structural blocks in that source. [Coverage and fallback commands](papers.csv)

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
