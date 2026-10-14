---
name: "doc"
description: "Use when the task involves reading, creating, or editing `.docx` documents, especially when formatting or layout fidelity matters; prefer `python-docx` plus the bundled `scripts/render_docx.py` for visual checks."
---

> Mira adaptation: Read [runtime setup](../../docs/development/runtime-tools.md) before running commands. Resolve scripts and references relative to this SKILL.md; use ordinary read/bash. Install only missing task dependencies in a user-owned venv. Use a work/output directory outside the source checkout. Upstream system-install commands are examples, not permission for sudo or large downloads.



# DOCX Skill

## When to use
- Read or review DOCX content where layout matters (tables, diagrams, pagination).
- Create or edit DOCX files with professional formatting.
- Validate visual layout before delivery.

## Workflow
1. Prefer visual review (layout, tables, diagrams).
   - If `soffice` and `pdftoppm` are available, convert DOCX -> PDF -> PNGs.
   - Or use `scripts/render_docx.py` (requires `pdf2image` and Poppler).
   - If these tools are missing, install them or ask the user to review rendered pages locally.
2. Use `python-docx` for edits and structured creation (headings, styles, tables, lists).
3. After each meaningful change, re-render and inspect the pages.
4. If visual review is not possible, extract text with `python-docx` as a fallback and call out layout risk.
5. Keep intermediate outputs organized and clean up after final approval.

## Temp and output conventions
- Use `tmp/docs/` for intermediate files; delete when done.
- Write final artifacts under `output/doc/` relative to the chosen work directory outside the source checkout.
- Keep filenames stable and descriptive.

## Dependencies (install if missing)
Set `MIRA_TOOLS_PYTHON` to the selected user-owned venv Python described in runtime setup. Prefer `uv` for dependency management; install only what this task needs.

Python packages:
```
uv pip install --python "$MIRA_TOOLS_PYTHON" python-docx pdf2image
```
If `uv` is unavailable:
```
"$MIRA_TOOLS_PYTHON" -m pip install python-docx pdf2image
```
System tools (for rendering):
```
# macOS (Homebrew)
brew install libreoffice poppler

# Ubuntu/Debian
sudo apt-get install -y libreoffice poppler-utils
```

If installation isn't possible in this environment, tell the user which dependency is missing and how to install it locally.

## Environment
No required environment variables.

## Rendering commands

Set `SKILL_DIR` to the directory containing this loaded SKILL.md.
DOCX -> PDF:
```
soffice -env:UserInstallation=file:///tmp/lo_profile_$$ --headless --convert-to pdf --outdir "$OUTDIR" "$INPUT_DOCX"
```

PDF -> PNGs:
```
pdftoppm -png "$OUTDIR/$BASENAME.pdf" "$OUTDIR/$BASENAME"
```

Bundled helper:
```
"$MIRA_TOOLS_PYTHON" "$SKILL_DIR/scripts/render_docx.py" /path/to/file.docx --output_dir /tmp/docx_pages
```

## Quality expectations
- Deliver a client-ready document: consistent typography, spacing, margins, and clear hierarchy.
- Avoid formatting defects: clipped/overlapping text, broken tables, unreadable characters, or default-template styling.
- Charts, tables, and visuals must be legible in rendered pages with correct alignment.
- Use ASCII hyphens only. Avoid U+2011 (non-breaking hyphen) and other Unicode dashes.
- Citations and references must be human-readable; never leave tool tokens or placeholder strings.

## Final checks
- Re-render and inspect every page at 100% zoom before final delivery.
- Fix any spacing, alignment, or pagination issues and repeat the render loop.
- Confirm there are no leftovers (temp files, duplicate renders) unless the user asks to keep them.
