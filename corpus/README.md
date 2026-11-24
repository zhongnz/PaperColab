# Manuscript regression corpus

[papers.csv](papers.csv) identifies 20 published or publicly posted manuscripts across six cohorts. The links pin an author repository commit or an arXiv source version. A venue label groups papers by publication family. Inspect the actual class and files in each pinned source before claiming template coverage. One manuscript has passed an original-source build. Nineteen await a baseline. The Week 8 editor round-trip evaluation has yet to begin.

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

On 23 November 2026, the isolated pdfLaTeX job produced a 275,608-byte PDF from that source. The TeX Live 2025 image digest was sha256:dbd65d778eb83de9b45fb0a8deb3afe44cbbaba2272e4e1e644e94dda52c7109. This establishes the baseline for a future import and re-export comparison. [Build record](https://github.com/zhongnz/PaperColab/actions/runs/45254301969/job/137971905975)

## Prepare the remaining sources

Download a pinned source into corpus/local. Keep the original and its licence record. Where arXiv supplies a tar, gzipped tar or a single TeX file, the packer copies regular file bytes into a ZIP and preserves their relative paths. A standalone source takes the name main.tex. Review the ZIP in the browser or run the same checks from a terminal.

~~~sh
python3 corpus/pack.py corpus/local/paper-source corpus/local/paper.zip
node corpus/check.cjs corpus/local/paper.zip
python3 scripts/check_build.py --root main.tex --pdf corpus/local/baseline.pdf corpus/local/paper.zip
~~~

Use the actual root from the report for the build. Record the source revision, ZIP SHA-256, compiler image digest, engine, root, required packages and output PDF. Mark a failed source build separately from an editor regression. Keep manuscript bytes and binaries in the local corpus unless redistribution has been cleared. For the editor trial, compare each original quarantined span byte for byte with its re-export, including comments, spacing and line endings. A static check or a successful original-source build cannot count as an editor round-trip.
