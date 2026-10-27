#!/usr/bin/env python3
"""build_docs_site.py — render docs/**/*.md into a static, searchable site.

Why this exists (S141): ~63 markdown files (ADRs, 25 research notes, wayfinder
tickets) had no entry point. You had to know a filename to find anything. This
produces a browsable site with a sidebar, client-side search and a sitemap —
entirely from our own content, so there is no licensing exposure.

Deliberate choices:
  * No new dependencies: system `markdown` (3.x) only.
  * docs/reference/books (266 MB of PDFs) is not copied; the Reference page
    links to the files in place instead.
  * Output goes to site/ (gitignored) — rebuilt on demand, never committed.

Usage:
  scripts/build_docs_site.py                 # -> site/
  scripts/build_docs_site.py --out build/site
"""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import sys
from datetime import UTC, datetime
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

# (subdirectory, group label, order)
SECTIONS = [
    ("", "Overview", 0),
    ("adr", "Architecture decisions", 1),
    ("research", "Research", 2),
    ("wayfinder", "Planning", 3),
    ("reference", "Reference", 4),
]

# Never copied or rendered: binary payloads and rot.
EXCLUDE_DIRS = {"books", "images", "archive"}
EXCLUDE_NAMES = {"screenshot.cjs"}

MD_EXTENSIONS = ["extra", "tables", "toc", "sane_lists", "attr_list"]


def group_for(rel: Path) -> tuple[str, int]:
    parts = rel.parts
    if len(parts) > 1:
        for name, label, order in SECTIONS[1:]:
            if parts[0] == name:
                return label, order
    return SECTIONS[0][1], SECTIONS[0][2]


def collect() -> list[dict]:
    pages = []
    for path in sorted(DOCS.rglob("*.md")):
        rel = path.relative_to(DOCS)
        if any(part in EXCLUDE_DIRS for part in rel.parts[:-1]):
            continue
        if path.name in EXCLUDE_NAMES:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        title = next(
            (line[2:].strip() for line in text.splitlines() if line.startswith("# ")),
            rel.stem.replace("-", " ").replace("_", " "),
        )
        pages.append(
            {
                "rel": rel,
                "src": path,
                "title": title,
                "group": group_for(rel)[0],
                "order": group_for(rel)[1],
                "text": text,
            }
        )
    return pages


def slug(rel: Path) -> str:
    return str(rel.with_suffix("")).replace("\\", "/")


def excerpt(text: str, limit: int = 400) -> str:
    """Plain-text snippet for the search index."""
    body = re.sub(r"```.*?```", " ", text, flags=re.S)
    body = re.sub(r"^\s{0,3}#{1,6}\s*", "", body, flags=re.M)
    body = re.sub(r"[*_`>|]", "", body)
    body = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", body)
    body = re.sub(r"\s+", " ", body).strip()
    return body[:limit]


def render(text: str) -> str:
    md = markdown.Markdown(extensions=MD_EXTENSIONS)
    body = md.convert(text)
    # Rewrite intra-repo markdown links to their rendered pages where we can.
    body = re.sub(
        r'href="([^"#]*?)\.md(#[^"]*)?"',
        lambda m: f'href="{m.group(1)}.html{m.group(2) or ""}"',
        body,
    )
    return body


CSS = """
:root{--bg:#0f1115;--panel:#171a21;--fg:#e6e8ee;--muted:#9aa3b2;--accent:#5aa9e6;--line:#252a33}
@media(prefers-color-scheme:light){:root{--bg:#fbfbfd;--panel:#f2f4f8;--fg:#1b1f27;--muted:#5b6472;--accent:#1f6feb;--line:#e2e6ee}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.layout{display:grid;grid-template-columns:270px 1fr;min-height:100vh}
nav{background:var(--panel);border-right:1px solid var(--line);padding:20px 16px;position:sticky;top:0;height:100vh;overflow:auto}
nav h1{font-size:15px;margin:0 0 14px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
nav h2{font-size:12px;margin:18px 0 6px;color:var(--muted);letter-spacing:.04em;text-transform:uppercase}
nav a{display:block;padding:3px 0;font-size:14px;color:var(--fg)}
main{padding:36px 48px;max-width:900px}
main h1{margin-top:0;font-size:30px}
main h2{margin-top:32px;border-bottom:1px solid var(--line);padding-bottom:6px}
main code{background:var(--panel);padding:1px 5px;border-radius:4px;font-size:13px}
main pre{background:var(--panel);padding:14px;border-radius:8px;overflow:auto}
main pre code{background:none;padding:0}
main table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14px}
main th,main td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
main th{background:var(--panel)}
main blockquote{border-left:3px solid var(--accent);margin:14px 0;padding:2px 14px;color:var(--muted)}
.search{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font-size:14px}
.results{margin-top:10px;font-size:13px}
.results a{display:block;padding:2px 0}
.muted{color:var(--muted)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
@media(max-width:820px){.layout{grid-template-columns:1fr}nav{position:static;height:auto}}
"""

JS = """
(async () => {
  const input = document.querySelector('#q');
  const out = document.querySelector('#results');
  if (!input) return;
  const root = document.body.dataset.root || '';
  const idx = await (await fetch(root + 'search-index.json')).json();
  const run = () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { out.innerHTML = ''; return; }
    const hits = idx.filter(p => (p.t + ' ' + p.x).toLowerCase().includes(q)).slice(0, 20);
    out.innerHTML = hits.length
      ? hits.map(p => `<a href="${root}${p.u}">${p.t}</a>`).join('')
      : '<span class="muted">no matches</span>';
  };
  input.addEventListener('input', run);
})();
"""


def page_shell(title: str, nav_html: str, body_html: str, prefix: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)}</title>
<link rel="stylesheet" href="{prefix}assets/app.css">
</head><body data-root="{prefix}">
<div class="layout">
<nav>
<h1>Remote Lockdown</h1>
<input class="search" id="q" placeholder="Search docs…" autocomplete="off">
<div class="results" id="results"></div>
{nav_html}
</nav>
<main>{body_html}</main>
</div>
<script src="{prefix}assets/app.js"></script>
</body></html>"""


def nav_html(pages: list[dict], current: str | None, prefix: str) -> str:
    out = []
    last_group = None
    for page in pages:
        if page["group"] != last_group:
            out.append(f"<h2>{html.escape(page['group'])}</h2>")
            last_group = page["group"]
        href = f"{prefix}docs/{slug(page['rel'])}.html"
        klass = ' class="muted"><strong' if slug(page["rel"]) == current else ">"
        out.append(f'<a href="{href}"{klass}>{html.escape(page["title"])}</a>')
    return "\n".join(out)


def prepare_out_dir(out_dir: Path) -> None:
    """Clear a previous build, refusing targets that would be destructive.

    `--out` is user-supplied, so a typo like `--out .` or `--out /` must not be
    able to wipe the repository. Only an explicit, non-root path is removed.
    """
    resolved = out_dir.resolve()
    forbidden = {Path("/").resolve(), ROOT.resolve(), (ROOT / "docs").resolve(), Path.home().resolve()}
    if resolved in forbidden or resolved.parent == Path("/"):
        raise SystemExit(f"[FAIL] refusing to delete {resolved} — pick a dedicated output directory")
    if resolved.exists():
        try:
            shutil.rmtree(resolved)
        except OSError as exc:
            raise SystemExit(f"[FAIL] cannot clear {resolved}: {exc}") from exc


def write_site(pages: list[dict], out_dir: Path) -> dict:
    prepare_out_dir(out_dir)
    (out_dir / "assets").mkdir(parents=True)
    (out_dir / "assets" / "app.css").write_text(CSS, encoding="utf-8")
    (out_dir / "assets" / "app.js").write_text(JS, encoding="utf-8")

    # Landing page
    cards = []
    last_group = None
    for page in pages:
        if page["group"] != last_group:
            cards.append(f"<h2>{html.escape(page['group'])}</h2>")
            last_group = page["group"]
        cards.append(
            '<div class="card">'
            f'<a href="docs/{slug(page["rel"])}.html"><strong>{html.escape(page["title"])}</strong></a>'
            f'<div class="muted">{html.escape(excerpt(page["text"], 150))}</div>'
            "</div>"
        )
    landing = page_shell(
        "Remote Lockdown — documentation",
        nav_html(pages, None, ""),
        f"<h1>Remote Lockdown System — documentation</h1>"
        f'<p class="muted">{len(pages)} documents: architecture decisions, research, planning, reference.</p>'
        + "\n".join(cards),
        "",
    )
    (out_dir / "index.html").write_text(landing, encoding="utf-8")

    # Individual pages
    for page in pages:
        rel = page["rel"]
        depth = len(slug(rel).split("/"))
        prefix = "../" * depth
        body = render(page["text"])
        html_doc = page_shell(
            f"{page['title']} — Remote Lockdown docs",
            nav_html(pages, slug(rel), prefix),
            body,
            prefix,
        )
        target = out_dir / "docs" / (slug(rel) + ".html")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(html_doc, encoding="utf-8")

    # Search index
    index = [
        {"t": p["title"], "u": f"docs/{slug(p['rel'])}.html", "x": excerpt(p["text"])}
        for p in pages
    ]
    (out_dir / "search-index.json").write_text(json.dumps(index), encoding="utf-8")

    # Sitemap
    today = datetime.now(UTC).strftime("%Y-%m-%d")
    urls = ['<url><loc>index.html</loc></url>']
    urls += [f'<url><loc>docs/{slug(p["rel"])}.html</loc></url>' for p in pages]
    (out_dir / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        f'<lastmod>{today}</lastmod>' + "".join(urls) + "</urlset>",
        encoding="utf-8",
    )
    return {"pages": len(pages), "out": out_dir}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=None, help="output directory (default: <repo>/site)")
    args = ap.parse_args()

    if not DOCS.is_dir():
        print(f"[FAIL] docs directory not found at {DOCS}", file=sys.stderr)
        return 1

    pages = collect()
    if not pages:
        print("[FAIL] no markdown files found", file=sys.stderr)
        return 1

    out_dir = Path(args.out) if args.out else ROOT / "site"
    stats = write_site(pages, out_dir)
    print(f"[OK] {stats['pages']} pages -> {stats['out']}")
    print(f"     open {stats['out'] / 'index.html'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
