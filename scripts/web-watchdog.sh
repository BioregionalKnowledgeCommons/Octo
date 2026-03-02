#!/usr/bin/env bash
# web-watchdog.sh — Lightweight monitoring for KOI API + web pipeline.
#
# Checks:
#   1. /health responds 200 within 5s (catches hung process)
#   2. /web/health error count < 5 (catches error spikes)
#   3. systemctl is-active koi-api (catches crashed service)
#   4. POST /web/process probe with auto_ingest=false (catches pipeline breakage)
#   5. GET /web/monitor responds 200 (catches WebSensor init failures)
#
# Install: echo "*/15 * * * * /root/scripts/web-watchdog.sh" | crontab -
# Logs: /var/log/web-watchdog.log

set -euo pipefail

BASE_URL="${KOI_BASE_URL:-http://127.0.0.1:8351}"
LOG="/var/log/web-watchdog.log"
MAX_ERRORS=5
TIMEOUT=5

log() {
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $1" >> "$LOG"
}

fail() {
    log "FAIL: $1"
    echo "web-watchdog FAIL: $1" >&2
}

pass() {
    log "OK: $1"
}

errors=0

# --- Check 1: /health responds 200 within timeout ---
health_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$BASE_URL/health" 2>/dev/null || echo "000")
if [ "$health_code" = "200" ]; then
    pass "/health → 200"
else
    fail "/health → $health_code (expected 200)"
    errors=$((errors + 1))

    # If health is down, try restarting the service
    if systemctl is-active --quiet koi-api 2>/dev/null; then
        log "WARN: /health failed but service is active — possible hang"
    else
        log "ACTION: koi-api is not active, attempting restart"
        systemctl restart koi-api 2>/dev/null && log "ACTION: koi-api restarted" || log "ERROR: restart failed"
    fi
fi

# --- Check 2: /web/health error count ---
web_health=$(curl -s --max-time "$TIMEOUT" "$BASE_URL/web/health" 2>/dev/null || echo '{}')
web_errors=$(echo "$web_health" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('errors_24h', 0))" 2>/dev/null || echo "0")
web_status=$(echo "$web_health" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status', 'unknown'))" 2>/dev/null || echo "unknown")

if [ "$web_errors" -lt "$MAX_ERRORS" ] 2>/dev/null; then
    pass "/web/health errors=$web_errors status=$web_status"
else
    fail "/web/health errors=$web_errors >= $MAX_ERRORS (status=$web_status)"
    errors=$((errors + 1))
fi

# --- Check 3: systemd service status ---
if systemctl is-active --quiet koi-api 2>/dev/null; then
    pass "koi-api service active"
else
    fail "koi-api service not active"
    errors=$((errors + 1))
    log "ACTION: attempting restart"
    systemctl restart koi-api 2>/dev/null && log "ACTION: koi-api restarted" || log "ERROR: restart failed"
fi

# --- Check 4: Lightweight /web/process probe ---
process_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    -X POST "$BASE_URL/web/process" \
    -H "Content-Type: application/json" \
    -d '{"url":"https://example.com","auto_ingest":false}' 2>/dev/null || echo "000")
if [ "$process_code" = "200" ]; then
    pass "/web/process probe → 200"
else
    fail "/web/process probe → $process_code"
    errors=$((errors + 1))
fi

# --- Check 5: /web/monitor probe ---
monitor_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$BASE_URL/web/monitor" 2>/dev/null || echo "000")
if [ "$monitor_code" = "200" ]; then
    pass "/web/monitor → 200"
else
    fail "/web/monitor → $monitor_code"
    errors=$((errors + 1))
fi

# --- Summary ---
if [ "$errors" -eq 0 ]; then
    log "SUMMARY: all checks passed"
else
    log "SUMMARY: $errors check(s) failed"
fi

exit "$errors"
