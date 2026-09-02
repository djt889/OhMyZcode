**English** | [简体中文](./README.zh-CN.md)

# docs/ — the architecture diagram and its evidence

The four-layer architecture diagram embedded in the top-level README lives here, in four files per language:

| File | What it is |
|---|---|
| `omz-architecture.json` | The typed [archify](https://github.com/tt-a1i/archify) specification — the only hand-edited file |
| `omz-architecture.html` | The delivered standalone viewer: one self-contained page, no network, no build step |
| `omz-architecture.light.png` / `.dark.png` | Static captures of the diagram surface, at 2× density, for embedding in the README |

The `.zh-CN.*` files are the Simplified Chinese counterparts. The two languages are separate specifications with the same topology, not one file with translated strings: node sizes and the viewBox are tuned per language because CJK glyphs are twice as wide, and the viewer's own UI language follows `meta.locale`.

## Why an HTML page and not just an image

The PNGs are what GitHub can render inline. The HTML is the actual artifact: it carries four guided views (the default `core` path, DAG scheduling, semantic retrieval, and the three fallback chains, each with a short authored note), click-to-focus on any component, relationship tracing, light/dark themes, and `sources` references that point at real files in this repository. Seven components carry such a reference — the coordinator's MCP entry point and schema, the dashboard's GET-only surface, `probeCodegraph`, the review-gate agent, the eight-step lifecycle command, and the status renderer.

GitHub does not render HTML from a repository inline, so the page has to be opened locally: clone or download the repository and open `docs/omz-architecture.html` in a browser. It is a single file with no external requests.

## How to regenerate

The diagram is produced by the archify skill. With that skill available:

```bash
# 1. validate the specification against the showcase quality gate
node bin/archify.mjs validate architecture <repo>/docs/omz-architecture.json \
  --quality showcase --repo-root <repo> --json

# 2. deliver: freeze the spec bytes, render, check, then atomically commit the HTML
node bin/archify.mjs deliver architecture <repo>/docs/omz-architecture.json \
  <repo>/docs/omz-architecture.html --quality showcase --repo-root <repo> --json

# 3. collect containment and readability evidence from the delivered HTML
node bin/archify.mjs visual-check <repo>/docs/omz-architecture.html --json
```

`visual-check` writes PNG sidecars and a contact sheet of the **whole viewer page** next to the artifact; those are inspection evidence, not the README images, and they are deliberately not committed. The README images are the diagram surface only, captured in the viewer's embed mode (`?embed=1`, which hides the toolbar, header and cards) and clipped to the measured `<svg>` rect at `deviceScaleFactor: 2`.

## Verification state of the committed artifacts

Both languages, at the revision recorded in each specification's `meta.repository`:

- `validate` / `deliver`: 9 of 9 artifact checks pass under the `showcase` profile, 0 errors, 0 warnings, repository evidence verified against 7 source references.
- `visual-check`: `status: pass` — no vertical or horizontal overflow at 1440×900, 1600×1000, 1920×1080 or 2048×1320, and the smallest projected node text stays at or above the 6 px readability floor (7.6 px at the tightest viewport for English, 7.8 px for Chinese).
- Visual review of the rendered captures: passed by inspection of the light and dark PNGs.

The `deliver` receipts, which you can check against the bytes in this repository:

| File | SHA-256 | Bytes |
|---|---|---|
| `omz-architecture.json` | `dc03886c38df7d19c4bf02fb2bd2d98ce898f8dbabeb17b4f5a69259c455417a` | 8555 |
| `omz-architecture.html` | `7cb8881ef826b8d40fac5d9abf5d891792f435b612a8f042e5e928b20621732a` | 737189 |
| `omz-architecture.zh-CN.json` | `12424c54b7bd5569e354989b3de1c0a923fb4e0ae4a825d9758acbcbfb2a7883` | 7218 |
| `omz-architecture.zh-CN.html` | `e57f43867db7adf3f3ea0a2bbc097b359ba74c372f86f77246cba9c6f0c5abf8` | 736591 |

The two HTML files carry `-text` in `.gitattributes`: without it, `text=auto eol=lf` would normalize their CRLF line endings on checkout and the delivered bytes would no longer match these hashes.

A `showcase` pass is a mechanical claim about composition and containment — no edge crosses an unrelated node, no label is masked, nothing overflows a desktop viewport. It says nothing about whether the facts in the diagram are right; those are the responsibility of DESIGN §3.1 and §3.3, which this diagram is drawn from.
