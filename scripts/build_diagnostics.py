"""Shared bounded diagnostic classification; no raw log persistence."""
import re

def build_diagnostic(text):
    """Return a fixed diagnostic category, never arbitrary TeX log content."""
    # Ignore latexmk command echoes and normal TeX engine status lines.
    # In the previous run "-no-shell-escape" was misclassified as a
    # shell-escape requirement on all eight failed original builds.
    lines = [line for line in text.lower().splitlines()
             if not re.search(r"^\s*(?:running |command line |latexmk: applying rule|restricted \\write18 enabled|\\write18 disabled|entering extended mode)",line)
             and not re.search(r"^\s*(?:pdflatex|xelatex|lualatex|latexmk)\s",line)]
    text = "\n".join(lines)
    patterns = (
        ("eps-conversion-required",r"eps-converted-to\.pdf.{0,80}(?:not found|does not exist)|logfile claimed conversion from .{0,200}\.eps.{0,200}output file does not exist|eps conversion (?:requires|exceeded|did not produce)"),
        ("output-write-failure",r"i can't write on file|cannot write (?:on|to) file|permission denied|no space left on device"),
        ("package-conflict",r"option clash for package|command .{0,100}already defined|already defined\."),
        ("unicode-character",r"unicode character .{0,120}not set up|invalid utf-8 byte"),
        ("missing-bibliography-data", r"supplied bibliography leaves undefined citations|i couldn't open database file|couldn't open style file|bibtex.{0,80}(?:failed|error)|bibliography file .{0,120}(?:not found|missing)|(?:bibtex|biber).{0,100}cannot find"),
        ("missing-file", r"(?:latex|package .{0,80}) error: file .{0,200}not found|i can't find file|file .{0,200}not found"),
        ("shell-escape-required", r"(?:requires?|must (?:enable|use)|need(?:s|ed)?) [^\n]{0,80}(?:shell.escape|write18)|(?:shell.escape|write18) [^\n]{0,60}(?:required|not enabled|must be enabled)|(?:minted|pygmentize)[^\n]{0,120}(?:not installed|not found|disabled)"),
        ("font-or-engine", r"fontspec error|requires.{0,100}(?:xelatex|lualatex)|font .{0,100}not found"),
        ("undefined-control-sequence", r"undefined control sequence"),
        ("tex-input-syntax", r"runaway argument|file ended while scanning|extra \\\\endgroup|missing \\} inserted|emergency stop"),
        ("graphics-format", r"unknown graphics extension|cannot determine size of graphic|error converting .*?\\.(?:eps|pdf)|pdftex error.*?image"),
        ("resource-or-time-limit", r"exceeded the 120-second limit|capacity exceeded|out of memory|oom killed"),
        ("unsafe-archive", r"unsafe or conflicting archive path|special file|unsupported archive|exceeds 256 mib"),
        ("latex-error", r"latex error|package .{0,100} error|fatal error"),
    )
    for code, pattern in patterns:
        if re.search(pattern,text):
            return code
    return "unclassified"


GUIDANCE={
    "eps-conversion-required":"The manuscript appears to need an EPS conversion. Use conventional local figure paths and supplied compatible PDFs; arbitrary shell escape stays disabled.",
    "output-write-failure":"Check generated-file paths and the bounded output directory. Absolute or escaping paths and exhausted disk space cannot be repaired by granting broader write access.",
    "package-conflict":"Check conflicting package options or duplicate command declarations against the paper's original TeX Live version.",
    "unicode-character":"Check the manuscript's original encoding and compiler requirements; do not silently rewrite source bytes.",
    "missing-bibliography-data":"Check that the referenced bibliography files or the required prebuilt bibliography are present in the ZIP. Do not silently replace references.",
    "missing-file":"Inspect the first missing file in the log. Restore omitted project dependencies or check the selected root and its relative paths.",
    "shell-escape-required":"This build requests an external command or shell escape. Pre-generate the necessary artifacts in a trusted environment; shell escape stays disabled.",
    "font-or-engine":"Check the manuscript's documented compiler and fonts. Select XeLaTeX or LuaLaTeX only if the manuscript requires it.",
    "undefined-control-sequence":"Inspect the first undefined command. Check its package, local macro declaration, and compiler requirements.",
    "tex-input-syntax":"Inspect the first source error and surrounding LaTeX. Compare with an original-source build before attributing it to editing.",
    "graphics-format":"Check figure formats and compiler requirements. Supply compatible pre-generated figures instead of enabling shell escape.",
    "resource-or-time-limit":"The local build exceeded its resource budget. Reduce the document or use a separately reviewed build environment.",
    "unsafe-archive":"Check ZIP paths, links and expanded size. The build will not extract unsafe archives.",
    "latex-error":"Inspect the first TeX error in the diagnostic. Check the original manuscript with the same root and engine.",
    "unclassified":"The failure could not be classified safely. Inspect the bounded diagnostic; verify Docker, the configured image, root and compiler."
}

def explain(text):
    code=build_diagnostic(text)
    return {"category":code,"guidance":GUIDANCE[code]}


def dependency_details(text):
    """Allowlisted, bounded diagnostic details for the public corpus.

    Only conventional dependency basenames/extensions and package names;
    never arbitrary log lines, absolute paths, source snippets or commands.
    """
    missing=set()
    for match in re.finditer(r"\bfile\s+[\x60'\"]?(?:[A-Za-z0-9_.-]+/)*([A-Za-z0-9_][A-Za-z0-9_.-]{0,100}\.(?:sty|cls|bst|bib|bbl|tex|ltx|pdf|png|jpg|jpeg|eps|tfm|otf|ttf))[\x60'\"]?\s+(?:not found|does not exist)",text,re.I):
        missing.add(match.group(1))
        if len(missing)>=8:break
    packages=set(re.findall(r"\bPackage ([A-Za-z0-9][A-Za-z0-9_.-]{0,40}) Error:",text,re.I)[:8])
    return {"missing_dependencies":sorted(missing),"error_packages":sorted(packages)}
