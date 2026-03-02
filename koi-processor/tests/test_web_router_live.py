"""Live integration tests for web endpoints — requires a running KOI API server.

The /web/* endpoints are only exposed on localhost (nginx gateway proxies /koi-net/*
and /health only). Run these on-server or via SSH tunnel:

  # On server:
  cd /root/koi-processor && venv/bin/python -m pytest tests/test_web_router_live.py --live-url http://127.0.0.1:8351 -v

  # Via SSH tunnel:
  ssh -L 8351:127.0.0.1:8351 root@45.132.245.30 -N &
  pytest tests/test_web_router_live.py --live-url http://127.0.0.1:8351 -v
"""

import pytest
import httpx


pytestmark = pytest.mark.live


@pytest.fixture
def http_client(live_url):
    """Synchronous httpx client for live tests."""
    return httpx.Client(base_url=live_url, timeout=30.0)


def test_live_health(http_client):
    """GET /health → 200."""
    resp = http_client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert "status" in data


def test_live_web_health(http_client):
    """GET /web/health → 200 with stats."""
    resp = http_client.get("/web/health")
    assert resp.status_code == 200
    data = resp.json()
    assert "status" in data
    assert "submissions_24h" in data


@pytest.mark.staging
def test_live_preview(http_client):
    """POST /web/preview with a known URL → 200 (writes a web_submissions row)."""
    resp = http_client.post("/web/preview", json={
        "url": "https://en.wikipedia.org/wiki/Salish_Sea",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["url"] == "https://en.wikipedia.org/wiki/Salish_Sea"
    assert data.get("title") or data.get("error")


def test_live_submissions(http_client):
    """GET /web/submissions → 200."""
    resp = http_client.get("/web/submissions?limit=5")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)


def test_live_monitor_status(http_client):
    """GET /web/monitor → 200."""
    resp = http_client.get("/web/monitor")
    assert resp.status_code == 200
