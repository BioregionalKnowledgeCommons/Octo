#!/bin/bash
# Bootstrap a BKC KOI federation node on a fresh VPS.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/BioregionalKnowledgeCommons/Octo/main/scripts/bootstrap.sh | bash
#
# What this does:
#   1. Installs Docker and git (if needed)
#   2. Clones the Octo repo
#   3. Runs the setup wizard
#
# Everything runs in Docker — no Python/pip/venv on the host.

set -euo pipefail

REPO_URL="https://github.com/BioregionalKnowledgeCommons/Octo.git"
INSTALL_DIR="${INSTALL_DIR:-/root/Octo}"

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║  Bioregional Knowledge Commons           ║"
echo "  ║  KOI Node Bootstrap                      ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# Privilege check
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
  INSTALL_DIR="$HOME/Octo"
fi

# Docker
if ! command -v docker &>/dev/null; then
  echo "→ Installing Docker..."
  $SUDO apt-get update -qq &>/dev/null
  $SUDO apt-get install -y -qq curl &>/dev/null
  # get.docker.com may fail on older distros due to missing packages — fall back to manual
  if ! curl -fsSL https://get.docker.com | $SUDO sh &>/dev/null 2>&1; then
    echo "  Docker script had issues, trying manual install..."
    $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin &>/dev/null 2>&1 \
      || $SUDO apt-get install -y -qq docker.io docker-compose-v2 &>/dev/null
  fi
  if command -v docker &>/dev/null; then
    echo "✓ Docker installed"
  else
    echo "✗ Failed to install Docker. Install it manually and re-run."
    exit 1
  fi
fi

if ! $SUDO docker info &>/dev/null 2>&1; then
  $SUDO systemctl start docker 2>/dev/null || $SUDO service docker start 2>/dev/null || true
  sleep 3
fi

# Git
if ! command -v git &>/dev/null; then
  echo "→ Installing git..."
  $SUDO apt-get install -y -qq git &>/dev/null
fi

# Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "→ Updating Octo repo..."
  cd "$INSTALL_DIR" && git pull --ff-only 2>/dev/null || true
else
  echo "→ Cloning Octo repo..."
  git clone "$REPO_URL" "$INSTALL_DIR" 2>&1 | tail -1
fi

echo "✓ Ready"
echo ""

# Run wizard
cd "$INSTALL_DIR"
exec bash scripts/setup-node.sh
