#!/bin/bash
set -euo pipefail

# Configuration - update this to the canonical repo location
CANONICAL_REPO="${CANONICAL_REPO:-/Users/darrenzal/projects/RegenAI/koi-processor}"
GITHUB_REPO="https://github.com/gaiaaiagent/koi-processor.git"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIN=$(cat "$SCRIPT_DIR/pin.txt")
VENDOR_DIR="$SCRIPT_DIR/koi-processor"

# If canonical repo not available locally, clone from GitHub
CLEANUP_CANONICAL=""
if [ ! -d "$CANONICAL_REPO/.git" ]; then
    echo "Canonical repo not found locally. Cloning from GitHub..."
    CANONICAL_REPO=$(mktemp -d)
    CLEANUP_CANONICAL=true
    git clone --bare "$GITHUB_REPO" "$CANONICAL_REPO"
fi

echo "Syncing koi-processor at commit $PIN"
echo "Source: $CANONICAL_REPO"

# Verify the commit exists
cd "$CANONICAL_REPO"
if ! git cat-file -e "$PIN" 2>/dev/null; then
    echo "ERROR: Commit $PIN not found in $CANONICAL_REPO"
    exit 1
fi

# Create vendor directory if needed
mkdir -p "$VENDOR_DIR"

# Use git archive to extract at pinned commit, then rsync
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

git archive "$PIN" | tar -x -C "$TMPDIR"

# Sync only the relevant directories
rsync -a --delete \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='venv/' \
    --exclude='.env' \
    "$TMPDIR/" "$VENDOR_DIR/"

if [ "$CLEANUP_CANONICAL" = "true" ]; then rm -rf "$CANONICAL_REPO"; fi

# Overlay Octo's canonical BKC ontology on top of the vendored copy.
# Octo is the source of truth for bkc-ontology.jsonld; this ensures the
# deployed koi-api loads the current Octo ontology even if the pinned
# koi-processor commit is older than the latest ontology edit.
OCTO_ONTOLOGY="$SCRIPT_DIR/../ontology/bkc-ontology.jsonld"
if [ -f "$OCTO_ONTOLOGY" ]; then
    mkdir -p "$VENDOR_DIR/api/ontology"
    cp "$OCTO_ONTOLOGY" "$VENDOR_DIR/api/ontology/bkc-ontology.jsonld"
    echo "Ontology overlaid from $OCTO_ONTOLOGY"
else
    echo "WARNING: $OCTO_ONTOLOGY not found; vendored ontology (if any) left untouched"
fi

echo "Vendored koi-processor at $PIN"
echo "Files synced to $VENDOR_DIR"
