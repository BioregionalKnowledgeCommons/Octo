#!/usr/bin/env python3
"""
Backfill source_url + source_name + source_license + source_license_url
frontmatter on vault notes derived from the Salish Sea Wiki.

Reads /tmp/wiki-attribution-targets.csv (pipe-delimited):
    entity_text|entity_type|vault_rid|source_url|source_rid|path_source

For each row, locates the vault note, parses its YAML frontmatter, adds
the four attribution fields IFF they are absent (idempotent), and writes
the file back atomically.

Source URL construction is verified upstream (mediawiki_page_state.title
joined to mediawiki_wikis.base_url); this script just propagates those
values into vault frontmatter.

License: CC-BY-SA 3.0 Unported (declared on the wiki's Welcome page,
quoted by operator on 2026-05-01).
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import sys
import tempfile
from pathlib import Path

import yaml


def sanitize_filename(name: str) -> str | None:
    """Mirror api/vault_note_utils.py:sanitize_filename so backfill paths
    match the names actually written to disk by ingest writers."""
    s = re.sub(r"[/\\\x00]", "", name)
    s = s.strip(". ")
    s = re.sub(r"\.{2,}", ".", s)
    s = s[:200]
    return s or None

VAULT_ROOT = Path("/root/.openclaw/workspace/vault")
TYPE_TO_FOLDER = {
    "Concept": "Concepts",
    "Location": "Locations",
    "Organization": "Organizations",
    "Project": "Projects",
    "Person": "People",
    "Practice": "Practices",
    "Pattern": "Patterns",
    "Bioregion": "Bioregions",
    "CaseStudy": "CaseStudies",
    "Protocol": "Protocols",
    "Playbook": "Playbooks",
    "Question": "Questions",
    "Claim": "Claims",
    "Evidence": "Evidence",
    "Meeting": "Meetings",
}

LICENSE_STRING = "CC-BY-SA 3.0 Unported"
LICENSE_URL = "https://creativecommons.org/licenses/by-sa/3.0/"
SOURCE_NAME = "Salish Sea Wiki"
ATTRIBUTION_FIELDS = ("source_url", "source_name", "source_license", "source_license_url")


def resolve_vault_path(entity_text: str, entity_type: str, vault_rid: str) -> Path | None:
    """Prefer vault_rid (when populated and points to an actual file);
    fall back to {folder}/{entity_text}.md derived from entity_type."""
    if vault_rid:
        candidate = VAULT_ROOT / vault_rid if not vault_rid.startswith("/") else Path(vault_rid)
        if candidate.is_file():
            return candidate
    folder = TYPE_TO_FOLDER.get(entity_type)
    if not folder:
        return None
    safe_name = sanitize_filename(entity_text)
    if not safe_name:
        return None
    candidate = VAULT_ROOT / folder / f"{safe_name}.md"
    return candidate if candidate.is_file() else None


def split_frontmatter(text: str) -> tuple[dict | None, str]:
    """Split a markdown file into (frontmatter dict, body). Returns (None, text)
    if no frontmatter delimiter is present."""
    if not text.startswith("---\n"):
        return None, text
    end = text.find("\n---\n", 4)
    if end < 0:
        return None, text
    yaml_block = text[4:end]
    body = text[end + 5 :]
    try:
        data = yaml.safe_load(yaml_block) or {}
        if not isinstance(data, dict):
            return None, text
        return data, body
    except yaml.YAMLError:
        return None, text


def render_frontmatter(data: dict, body: str) -> str:
    yaml_block = yaml.safe_dump(
        data, sort_keys=False, allow_unicode=True, default_flow_style=False
    )
    return f"---\n{yaml_block}---\n{body}"


def atomic_write(path: Path, content: str) -> None:
    fd, tmp = tempfile.mkstemp(prefix=".attr-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--csv", default="/tmp/wiki-attribution-targets.csv")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--limit", type=int, default=0, help="0 = no limit")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()

    counts = {"updated": 0, "already_set": 0, "missing_file": 0, "no_frontmatter": 0, "error": 0}
    with open(args.csv, encoding="utf-8") as fh:
        reader = csv.reader(fh, delimiter="|")
        for i, row in enumerate(reader):
            if args.limit and counts["updated"] + counts["already_set"] >= args.limit:
                break
            if len(row) < 6:
                counts["error"] += 1
                continue
            entity_text, entity_type, vault_rid, source_url, source_rid, _ = row
            path = resolve_vault_path(entity_text, entity_type, vault_rid)
            if not path:
                counts["missing_file"] += 1
                if args.verbose:
                    print(f"MISS {entity_type}/{entity_text}.md", file=sys.stderr)
                continue
            text = path.read_text(encoding="utf-8")
            fm, body = split_frontmatter(text)
            if fm is None:
                counts["no_frontmatter"] += 1
                if args.verbose:
                    print(f"NOFM {path}", file=sys.stderr)
                continue
            if all(k in fm for k in ATTRIBUTION_FIELDS):
                counts["already_set"] += 1
                continue
            new_fm = dict(fm)
            new_fm.setdefault("source_url", source_url)
            new_fm.setdefault("source_name", SOURCE_NAME)
            new_fm.setdefault("source_license", LICENSE_STRING)
            new_fm.setdefault("source_license_url", LICENSE_URL)
            if args.dry_run:
                counts["updated"] += 1
                if args.verbose:
                    print(f"DRY  {path}", file=sys.stderr)
                continue
            new_text = render_frontmatter(new_fm, body)
            atomic_write(path, new_text)
            counts["updated"] += 1

    print("=== summary ===")
    for k, v in counts.items():
        print(f"  {k}: {v}")
    print(f"  total_processed: {sum(counts.values())}")


if __name__ == "__main__":
    main()
