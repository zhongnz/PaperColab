# Reproducible computational research (prototype)

A human author registers an experiment from one locally held text code object,
up to eight locally held text dataset objects, a language (Python or R), an
objective, and the exact locally installed Docker image ID. The service freezes
the code/data bytes and object revision IDs in a canonical SHA-256 identified
JSON bundle. It does not fetch external data or execute code. Subsequent object
edits do not change a bundle. Download the bundle from Computational research.

## Run explicitly on a trusted local workstation

Install Docker, obtain a trusted Python or R image, and inspect its exact ID
(e.g. docker image inspect --format '{{.Id}}' python:3.12-slim). Register that
ID; the runner never pulls an image itself. For Python, the code is placed at
/inputs/main.py; for R, /inputs/main.R. Datasets are ordered as
/inputs/data-1.txt, /inputs/data-2.txt, etc. Use those paths explicitly. Code
and input data are mounted read-only; scratch files in /tmp are discarded.
Only bounded text stdout/stderr is retained, not arbitrary output files.

```sh
python -m compute.runner experiment.json --receipt receipt.json
```

The runner launches an unprivileged container with no network, read-only root,
no added capabilities, no-new-privileges, limited memory/CPU/PIDs, bounded
tmpfs, 60-second default wall timeout and 128 KiB log limit. No project tokens,
host environment secrets or Docker socket are passed to the container. It
uses a trusted local Docker daemon and preinstalled image; Docker is not a
sufficient sandbox for hostile multi-tenant execution. Run trusted code only,
on a dedicated environment if data is sensitive. Container escape, image
supply-chain and side-channel risks remain. Linux CI is the initial target;
Windows Docker path/permissions and R image availability need verification.
No fallback to host Python or R.

Upload the receipt from the experiment panel. The server validates the
bundle identity, declared image, status and log hash, then stores the
receipt once. A reviewer accepts a successful receipt or rejects it with an
assessment. Accepted receipts create an immutable run research object that
can be linked to a claim using existing evidence links. Receipts are
user-supplied assertions: hashes detect mismatch, not proof of execution,
correctness, completeness or independent reproduction. A failed execution
can be retained and rejected, not registered as successful run evidence.
Repeat by registering a new experiment. Inputs/receipts are in the local
database backup; no new publication release gate.

This is a script-cell and experiment registry, not a hosted Jupyter kernel,
notebook editor, Quarto render integration, large/binary dataset store,
automatic experiment scheduler or workflow execution adapter. Evaluate
Jupyter kernels and notebook format for interactive computation, Quarto
for publication, and content-addressed object storage for larger artifacts
after the bounded script-run contract passes. CI runs Python and R images
separately, with actual image IDs resolved after pulling test tags; tags are
not immutable dependency pins for CI itself. Server contract tests use
synthetic receipts; the runner CI uses real containers.

The hosted browser test uses a clearly labelled synthetic receipt to verify bundle download, receipt import and reviewed evidence registration without starting containers in the web service.
