#!/bin/bash
# Interactive setup for a Quartz knowledge site on a BKC federation node.
# Can be run standalone or called from setup-node.sh.
#
# Usage:
#   bash scripts/setup-quartz.sh
#   bash scripts/setup-quartz.sh --node-name "Salt Spring Island" --node-slug "salt-spring-island" --node-dir "$HOME/salt-spring-island"
#
# All system operations use $SUDO (empty if root, "sudo" otherwise).

set -euo pipefail

OCTO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# ─── Colors ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}→${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }
err()   { echo -e "${RED}✗${NC} $1"; }
header(){ echo -e "\n${BOLD}── $1 ──${NC}\n"; }

# ─── Parse args ───
NODE_FULL_NAME=""
NODE_SLUG=""
NODE_DIR=""
QUARTZ_DIR=""
DOMAIN=""
ARG_KOI_API_PORT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node-name)     NODE_FULL_NAME="$2"; shift 2 ;;
    --node-slug)     NODE_SLUG="$2"; shift 2 ;;
    --node-dir)      NODE_DIR="$2"; shift 2 ;;
    --quartz-dir)    QUARTZ_DIR="$2"; shift 2 ;;
    --domain)        DOMAIN="$2"; shift 2 ;;
    --koi-api-port)  ARG_KOI_API_PORT="$2"; shift 2 ;;
    *) err "Unknown argument: $1"; exit 1 ;;
  esac
done

# ─── Detect privilege ───
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

# ─── Read Quartz version pin ───
QUARTZ_VERSION_FILE="$OCTO_DIR/quartz/QUARTZ_VERSION"
if [ ! -f "$QUARTZ_VERSION_FILE" ]; then
  err "Missing $QUARTZ_VERSION_FILE"
  exit 1
fi
QUARTZ_TAG=$(tr -d '[:space:]' < "$QUARTZ_VERSION_FILE")
if [ -z "$QUARTZ_TAG" ]; then
  err "Empty QUARTZ_VERSION file"
  exit 1
fi

# ─── Interactive prompts for missing values ───
header "Quartz Knowledge Site Setup"

if [ -z "$NODE_FULL_NAME" ]; then
  read -rp "  Node name (e.g. Salt Spring Island): " NODE_FULL_NAME
  if [ -z "$NODE_FULL_NAME" ]; then
    err "Node name cannot be empty"
    exit 1
  fi
fi

if [ -z "$NODE_SLUG" ]; then
  NODE_SLUG=$(echo "$NODE_FULL_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | sed 's/[^a-z0-9-]//g')
fi

if [ -z "$NODE_DIR" ]; then
  NODE_DIR="$HOME/$NODE_SLUG"
  read -rp "  Node directory [$NODE_DIR]: " INPUT_DIR
  NODE_DIR="${INPUT_DIR:-$NODE_DIR}"
fi

VAULT_PATH="$NODE_DIR/vault"

if [ -z "$QUARTZ_DIR" ]; then
  QUARTZ_DIR="${NODE_DIR}-quartz"
fi

# Site title
DEFAULT_TITLE="$NODE_FULL_NAME Knowledge Garden"
read -rp "  Site title [$DEFAULT_TITLE]: " SITE_TITLE
SITE_TITLE="${SITE_TITLE:-$DEFAULT_TITLE}"

# Domain
if [ -z "$DOMAIN" ]; then
  PUBLIC_IP=$(curl -s --max-time 5 -4 ifconfig.me 2>/dev/null || echo "")
  if [ -n "$PUBLIC_IP" ]; then
    DEFAULT_DOMAIN="${PUBLIC_IP}.sslip.io"
  else
    DEFAULT_DOMAIN="localhost"
  fi
  read -rp "  Domain [$DEFAULT_DOMAIN]: " DOMAIN
  DOMAIN="${DOMAIN:-$DEFAULT_DOMAIN}"
fi

# KOI API port (for nginx proxy)
if [ -n "$ARG_KOI_API_PORT" ]; then
  KOI_API_PORT="$ARG_KOI_API_PORT"
else
  KOI_API_PORT=8351
  read -rp "  KOI API port [$KOI_API_PORT]: " INPUT_PORT
  KOI_API_PORT="${INPUT_PORT:-$KOI_API_PORT}"
fi

# Chat widget
CHAT_PORT=3847
read -rp "  Enable chat widget? [y/N] " ENABLE_CHAT
if [[ "${ENABLE_CHAT,,}" =~ ^y ]]; then
  CHAT_WIDGET_ENABLED="true"
  read -rp "  Chat backend port [$CHAT_PORT]: " INPUT_CHAT_PORT
  CHAT_PORT="${INPUT_CHAT_PORT:-$CHAT_PORT}"
else
  CHAT_WIDGET_ENABLED="false"
fi

echo ""
info "Configuration:"
echo "  Site title:   $SITE_TITLE"
echo "  Domain:       $DOMAIN"
echo "  Quartz dir:   $QUARTZ_DIR"
echo "  Vault path:   $VAULT_PATH"
echo "  Quartz tag:   $QUARTZ_TAG"
echo "  Chat widget:  $CHAT_WIDGET_ENABLED"
echo ""

# ─── Step 1: Check prerequisites ───
header "Checking Prerequisites"

# Node.js
if ! command -v node &>/dev/null; then
  warn "Node.js not found"
  read -rp "  Install Node.js via NodeSource? [Y/n] " INSTALL_NODE
  if [[ "${INSTALL_NODE,,}" != "n" ]]; then
    info "Installing Node.js..."
    if command -v curl &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash - &>/dev/null
      $SUDO apt-get install -y nodejs &>/dev/null
    else
      err "curl not found. Install Node.js 18+ manually and re-run."
      exit 1
    fi
    if command -v node &>/dev/null; then
      ok "Node.js $(node --version) installed"
    else
      err "Node.js installation failed. Install manually and re-run."
      exit 1
    fi
  else
    err "Node.js 18+ is required. Install it and re-run."
    exit 1
  fi
else
  NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -lt 18 ]; then
    err "Node.js 18+ required (found $(node --version))"
    exit 1
  fi
  ok "Node.js $(node --version)"
fi

# npm
if ! command -v npm &>/dev/null; then
  err "npm not found. Install Node.js properly and re-run."
  exit 1
fi
ok "npm $(npm --version)"

# nginx
if ! command -v nginx &>/dev/null; then
  warn "nginx not found"
  read -rp "  Install nginx? [Y/n] " INSTALL_NGINX
  if [[ "${INSTALL_NGINX,,}" != "n" ]]; then
    info "Installing nginx..."
    $SUDO apt-get update -qq &>/dev/null
    $SUDO apt-get install -y -qq nginx &>/dev/null
    if command -v nginx &>/dev/null; then
      ok "nginx installed"
    else
      err "nginx installation failed"
      exit 1
    fi
  else
    err "nginx is required. Install it and re-run."
    exit 1
  fi
else
  ok "nginx $(nginx -v 2>&1 | sed 's/.*\///')"
fi

# git
if ! command -v git &>/dev/null; then
  err "git is required. Install it and re-run."
  exit 1
fi

# Vault must exist
if [ ! -d "$VAULT_PATH" ]; then
  err "Vault directory not found: $VAULT_PATH"
  echo "  Run setup-node.sh first, or create it: mkdir -p $VAULT_PATH"
  exit 1
fi
ok "Vault found at $VAULT_PATH"

# ─── Step 2: Clone or update Quartz ───
header "Setting Up Quartz"

if [ -d "$QUARTZ_DIR/.git" ]; then
  info "Quartz directory exists, updating to $QUARTZ_TAG..."
  cd "$QUARTZ_DIR"
  git fetch --tags origin &>/dev/null
  git reset --hard "$QUARTZ_TAG" &>/dev/null
  ok "Quartz updated to $QUARTZ_TAG"
elif [ -d "$QUARTZ_DIR" ]; then
  err "Directory exists but is not a Quartz clone: $QUARTZ_DIR"
  echo "  Remove it or choose a different --quartz-dir"
  exit 1
else
  info "Cloning Quartz $QUARTZ_TAG..."
  git clone --branch "$QUARTZ_TAG" --depth 1 https://github.com/jackyzha0/quartz.git "$QUARTZ_DIR" &>/dev/null
  ok "Quartz cloned to $QUARTZ_DIR"
fi

cd "$QUARTZ_DIR"

# Create support directories
mkdir -p "$QUARTZ_DIR/.locks" "$QUARTZ_DIR/logs"

# ─── Step 3: Symlink vault as content ───
info "Linking vault to content..."

CONTENT="$QUARTZ_DIR/content"

if [ -L "$CONTENT" ]; then
  CURRENT_TARGET=$(readlink "$CONTENT")
  if [ "$CURRENT_TARGET" = "$VAULT_PATH" ]; then
    ok "Content symlink already correct"
  else
    rm "$CONTENT"
    ln -s "$VAULT_PATH" "$CONTENT"
    ok "Content symlink updated (was: $CURRENT_TARGET)"
  fi
elif [ -d "$CONTENT" ]; then
  if [ -d "$QUARTZ_DIR/content.default" ]; then
    rm -rf "$CONTENT"
  else
    mv "$CONTENT" "$QUARTZ_DIR/content.default"
  fi
  ln -s "$VAULT_PATH" "$CONTENT"
  ok "Content symlinked to vault (original saved as content.default)"
elif [ -e "$CONTENT" ]; then
  rm "$CONTENT"
  ln -s "$VAULT_PATH" "$CONTENT"
  ok "Content symlinked to vault"
else
  ln -s "$VAULT_PATH" "$CONTENT"
  ok "Content symlinked to vault"
fi

# ─── Step 4: Generate quartz.config.ts from template ───
info "Generating quartz.config.ts..."

TEMPLATE="$OCTO_DIR/quartz/quartz.config.ts.template"
if [ ! -f "$TEMPLATE" ]; then
  err "Template not found: $TEMPLATE"
  exit 1
fi

# Build ignore patterns string
IGNORE_PATTERNS='"private", "templates", ".obsidian", "People/**"'

# Escape sed special chars in replacement strings (& and \)
escape_sed() { printf '%s' "$1" | sed 's/[&\\/]/\\&/g'; }
SAFE_TITLE=$(escape_sed "$SITE_TITLE")
SAFE_DOMAIN=$(escape_sed "$DOMAIN")

sed \
  -e "s|__SITE_TITLE__|$SAFE_TITLE|g" \
  -e "s|__BASE_URL__|$SAFE_DOMAIN|g" \
  -e "s|__IGNORE_PATTERNS__|$IGNORE_PATTERNS|g" \
  "$TEMPLATE" > "$QUARTZ_DIR/quartz.config.ts"

ok "quartz.config.ts generated"

# ─── Step 5: Generate rebuild.sh from template ───
info "Generating rebuild.sh..."

REBUILD_TEMPLATE="$OCTO_DIR/quartz/rebuild.sh.template"
if [ ! -f "$REBUILD_TEMPLATE" ]; then
  err "Template not found: $REBUILD_TEMPLATE"
  exit 1
fi

sed \
  -e "s|__QUARTZ_DIR__|$QUARTZ_DIR|g" \
  -e "s|__CHAT_WIDGET_ENABLED__|$CHAT_WIDGET_ENABLED|g" \
  "$REBUILD_TEMPLATE" > "$QUARTZ_DIR/rebuild.sh"

chmod +x "$QUARTZ_DIR/rebuild.sh"
ok "rebuild.sh generated"

# ─── Step 6: Copy chat widget (if enabled) ───
if [ "$CHAT_WIDGET_ENABLED" = "true" ]; then
  info "Installing chat widget..."
  mkdir -p "$QUARTZ_DIR/quartz/static"
  cp "$OCTO_DIR/quartz/chat-widget.js" "$QUARTZ_DIR/quartz/static/chat-widget.js"
  ok "Chat widget installed"
fi

# ─── Step 7: Install dependencies ───
info "Installing Quartz dependencies (this may take a minute)..."
cd "$QUARTZ_DIR"
if [ -f package-lock.json ]; then
  npm ci --silent 2>&1 | tail -3
else
  npm install --silent 2>&1 | tail -3
fi
ok "Dependencies installed"

# ─── Step 8: Initial build ───
header "Building Site"

info "Running initial build..."
if bash "$QUARTZ_DIR/rebuild.sh"; then
  ok "Site built successfully"
else
  err "Initial build failed. Check output above."
  echo "  You can retry: bash $QUARTZ_DIR/rebuild.sh"
  exit 1
fi

# ─── Step 9: nginx setup (HTTP first) ───
header "Configuring nginx"

NGINX_TEMPLATE="$OCTO_DIR/quartz/nginx-quartz.conf.template"
if [ ! -f "$NGINX_TEMPLATE" ]; then
  err "Template not found: $NGINX_TEMPLATE"
  exit 1
fi

NGINX_CONF="$QUARTZ_DIR/nginx-quartz.conf"
QUARTZ_PUBLIC="$QUARTZ_DIR/public"

# Extract HTTP-only variant from template
sed -n '/^# __VARIANT_HTTP_START__$/,/^# __VARIANT_HTTP_END__$/p' "$NGINX_TEMPLATE" \
  | grep -v '__VARIANT_HTTP' \
  | sed \
    -e "s|__SERVER_NAME__|$DOMAIN|g" \
    -e "s|__QUARTZ_PUBLIC__|$QUARTZ_PUBLIC|g" \
    -e "s|__KOI_API_PORT__|$KOI_API_PORT|g" \
    -e "s|__CHAT_PORT__|$CHAT_PORT|g" \
  > "$NGINX_CONF"

NGINX_SITE="${NODE_SLUG}-quartz"
$SUDO cp "$NGINX_CONF" "/etc/nginx/sites-available/$NGINX_SITE"
$SUDO ln -sf "/etc/nginx/sites-available/$NGINX_SITE" "/etc/nginx/sites-enabled/$NGINX_SITE"

if $SUDO nginx -t 2>&1 | grep -q "successful"; then
  $SUDO systemctl reload nginx
  ok "nginx configured (HTTP)"
else
  err "nginx config test failed:"
  $SUDO nginx -t
  exit 1
fi

SITE_URL="http://$DOMAIN"

# Verify HTTP
if curl -s --max-time 10 "$SITE_URL/" | grep -q '<title>'; then
  ok "Site accessible at $SITE_URL"
else
  warn "Could not verify site at $SITE_URL (may need DNS or firewall)"
fi

# ─── Step 10: TLS (optional) ───
header "TLS Certificate"

echo "  HTTPS is recommended but optional. You can set it up later."
echo ""
echo "  Options:"
echo "    1) certbot (Let's Encrypt)  [recommended]"
echo "    2) acme.sh (ZeroSSL/Let's Encrypt)"
echo "    3) Skip (keep HTTP only)"
echo ""
read -rp "  Choose (1/2/3) [3]: " TLS_CHOICE
TLS_CHOICE="${TLS_CHOICE:-3}"

TLS_OK=false

case "$TLS_CHOICE" in
  1)
    if ! command -v certbot &>/dev/null; then
      info "Installing certbot..."
      $SUDO apt-get update -qq &>/dev/null
      $SUDO apt-get install -y -qq certbot &>/dev/null
    fi
    read -rp "  Email for cert registration: " CERT_EMAIL
    if [ -n "$CERT_EMAIL" ]; then
      info "Requesting certificate via certbot..."
      if $SUDO certbot certonly --webroot -w "$QUARTZ_PUBLIC" -d "$DOMAIN" \
          --non-interactive --agree-tos -m "$CERT_EMAIL" 2>&1 | tail -5; then
        SSL_CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
        SSL_KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
        if [ -f "$SSL_CERT" ]; then
          TLS_OK=true
          ok "Certificate obtained"
        else
          warn "Certificate files not found at expected path"
        fi
      else
        warn "certbot failed — keeping HTTP-only"
      fi
    fi
    ;;
  2)
    ACME_BIN=$(command -v acme.sh 2>/dev/null || echo "$HOME/.acme.sh/acme.sh")
    if [ ! -x "$ACME_BIN" ]; then
      err "acme.sh not found — install via: curl https://get.acme.sh | sh"
      echo "  Then re-run this script."
    else
      info "Requesting certificate via acme.sh..."
      if "$ACME_BIN" --issue -d "$DOMAIN" -w "$QUARTZ_PUBLIC" 2>&1 | tail -5; then
        # Copy certs to nginx-readable location via staging dir
        ACME_STAGING=$(mktemp -d)
        "$ACME_BIN" --install-cert -d "$DOMAIN" \
          --cert-file "$ACME_STAGING/cert.pem" \
          --key-file "$ACME_STAGING/privkey.pem" \
          --fullchain-file "$ACME_STAGING/fullchain.pem" 2>/dev/null
        $SUDO mkdir -p "/etc/nginx/ssl/$NODE_SLUG"
        $SUDO cp "$ACME_STAGING/fullchain.pem" "/etc/nginx/ssl/$NODE_SLUG/fullchain.pem"
        $SUDO cp "$ACME_STAGING/privkey.pem" "/etc/nginx/ssl/$NODE_SLUG/privkey.pem"
        rm -rf "$ACME_STAGING"
        SSL_CERT="/etc/nginx/ssl/$NODE_SLUG/fullchain.pem"
        SSL_KEY="/etc/nginx/ssl/$NODE_SLUG/privkey.pem"
        if [ -f "$SSL_CERT" ] && [ -f "$SSL_KEY" ]; then
          $SUDO chmod 600 "$SSL_KEY"
          TLS_OK=true
          ok "Certificate obtained"
        else
          warn "Certificate files not found at expected path"
        fi
      else
        warn "acme.sh failed — keeping HTTP-only"
      fi
    fi
    ;;
  *)
    info "Skipping TLS. You can set it up later."
    ;;
esac

if [ "$TLS_OK" = true ]; then
  info "Switching nginx to HTTPS..."

  # Extract HTTPS variant from template
  sed -n '/^# __VARIANT_HTTPS_START__$/,/^# __VARIANT_HTTPS_END__$/p' "$NGINX_TEMPLATE" \
    | grep -v '__VARIANT_HTTPS' \
    | sed \
      -e "s|__SERVER_NAME__|$DOMAIN|g" \
      -e "s|__QUARTZ_PUBLIC__|$QUARTZ_PUBLIC|g" \
      -e "s|__KOI_API_PORT__|$KOI_API_PORT|g" \
      -e "s|__CHAT_PORT__|$CHAT_PORT|g" \
      -e "s|__SSL_CERT_PATH__|$SSL_CERT|g" \
      -e "s|__SSL_KEY_PATH__|$SSL_KEY|g" \
    > "$NGINX_CONF"

  $SUDO cp "$NGINX_CONF" "/etc/nginx/sites-available/$NGINX_SITE"

  if $SUDO nginx -t 2>&1 | grep -q "successful"; then
    $SUDO systemctl reload nginx
    SITE_URL="https://$DOMAIN"
    ok "nginx switched to HTTPS"
  else
    warn "HTTPS nginx config failed — reverting to HTTP"
    # Re-generate HTTP-only
    sed -n '/^# __VARIANT_HTTP_START__$/,/^# __VARIANT_HTTP_END__$/p' "$NGINX_TEMPLATE" \
      | grep -v '__VARIANT_HTTP' \
      | sed \
        -e "s|__SERVER_NAME__|$DOMAIN|g" \
        -e "s|__QUARTZ_PUBLIC__|$QUARTZ_PUBLIC|g" \
        -e "s|__KOI_API_PORT__|$KOI_API_PORT|g" \
        -e "s|__CHAT_PORT__|$CHAT_PORT|g" \
      > "$NGINX_CONF"
    $SUDO cp "$NGINX_CONF" "/etc/nginx/sites-available/$NGINX_SITE"
    $SUDO nginx -t && $SUDO systemctl reload nginx
    SITE_URL="http://$DOMAIN"
  fi
fi

# ─── Step 11: Cron setup ───
header "Auto-Rebuild"

CRON_MARKER="# BKC-QUARTZ-REBUILD ${NODE_SLUG}"
CRON_LINE="*/15 * * * * $QUARTZ_DIR/rebuild.sh >> $QUARTZ_DIR/logs/rebuild.log 2>&1 $CRON_MARKER"

EXISTING_CRON=$(crontab -l 2>/dev/null || true)

if echo "$EXISTING_CRON" | grep -qF "$CRON_MARKER"; then
  ok "Cron entry already exists"
else
  info "Adding rebuild cron (every 15 minutes)..."
  (echo "$EXISTING_CRON"; echo "$CRON_LINE") | crontab -
  ok "Cron entry added"
fi

# ─── Step 12: Final verification ───
header "Verification"

if curl -s --max-time 10 "$SITE_URL/" | grep -q '<title>'; then
  ok "Site is live at $SITE_URL"
else
  warn "Could not verify site at $SITE_URL"
fi

# Check for unresolved placeholders
if grep -rq '__.*__' "$QUARTZ_DIR/quartz.config.ts" "$QUARTZ_DIR/rebuild.sh" 2>/dev/null; then
  warn "Unresolved placeholders found in generated files"
  grep -rn '__.*__' "$QUARTZ_DIR/quartz.config.ts" "$QUARTZ_DIR/rebuild.sh" 2>/dev/null || true
fi

# ─── Summary ───
header "Setup Complete!"

echo "Your knowledge site is running:"
echo ""
echo "  URL:          $SITE_URL"
echo "  Quartz dir:   $QUARTZ_DIR"
echo "  Vault:        $VAULT_PATH"
echo "  Rebuild log:  $QUARTZ_DIR/logs/rebuild.log"
echo "  nginx config: /etc/nginx/sites-available/$NGINX_SITE"
echo ""
echo "Manage:"
echo "  bash $QUARTZ_DIR/rebuild.sh              # manual rebuild"
echo "  tail -f $QUARTZ_DIR/logs/rebuild.log     # watch rebuilds"
echo ""
echo "Customize:"
echo "  nano $VAULT_PATH/index.md                # landing page"
echo "  nano $QUARTZ_DIR/quartz.config.ts        # site config"
echo ""
if [ "$TLS_OK" != true ] && [ "$DOMAIN" != "localhost" ]; then
  echo "To add HTTPS later, re-run this script or use certbot directly:"
  echo "  certbot certonly --webroot -w $QUARTZ_PUBLIC -d $DOMAIN"
  echo ""
fi
