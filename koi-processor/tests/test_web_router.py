"""Tests for api/routers/web_router.py — FastAPI endpoint tests with mocked dependencies.

The web_router uses lazy imports inside endpoint handlers (e.g., `from api.web_fetcher import
fetch_and_preview`). We mock at the source module level so the lazy import picks up our mock.
We also pre-seed api.personal_ingest_api in sys.modules to avoid heavy dependency imports.
"""

import json
import sys
import types
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
from fastapi import FastAPI
from httpx import ASGITransport

# Pre-seed heavy modules that web_router lazily imports
if "api.personal_ingest_api" not in sys.modules:
    _mock_ingest = types.ModuleType("api.personal_ingest_api")
    _mock_ingest.normalize_entity_text = lambda text: text.lower().strip()
    _mock_ingest.resolve_entity = AsyncMock()
    _mock_ingest.store_new_entity = AsyncMock()

    # Create mock ExtractedEntity that behaves like a Pydantic model
    class _MockExtractedEntity:
        def __init__(self, **kwargs):
            for k, v in kwargs.items():
                setattr(self, k, v)
    _mock_ingest.ExtractedEntity = _MockExtractedEntity
    sys.modules["api.personal_ingest_api"] = _mock_ingest

from api.routers.web_router import create_router


# =============================================================================
# Fixtures
# =============================================================================


def _make_mock_pool():
    """Create a mock asyncpg pool with context-manager acquire().

    The mock_conn.fetchrow is a smart dispatcher: returns None by default,
    but can be configured via pool._fetchrow_map to return different values
    based on substrings found in the query.
    """
    pool = MagicMock()
    mock_conn = AsyncMock()
    mock_conn.fetchval.return_value = 0
    mock_conn.fetch.return_value = []
    mock_conn.execute.return_value = None

    # Query-based dispatch for fetchrow
    pool._fetchrow_map = {}  # {"query_substring": return_value}
    pool._fetchrow_default = None

    async def _smart_fetchrow(query, *args):
        for substring, val in pool._fetchrow_map.items():
            if substring in query:
                return val
        return pool._fetchrow_default

    mock_conn.fetchrow = AsyncMock(side_effect=_smart_fetchrow)

    ctx = AsyncMock()
    ctx.__aenter__.return_value = mock_conn
    ctx.__aexit__.return_value = None
    pool.acquire.return_value = ctx
    pool._mock_conn = mock_conn
    return pool


def _make_mock_caps(llm=True, web_sensor=True):
    caps = MagicMock()
    caps.llm_enrichment = llm
    caps.web_sensor = web_sensor
    return caps


def _make_web_preview(fetch_error=None):
    from api.web_fetcher import WebPreview, PageMetadata
    return WebPreview(
        url="https://example.com/article",
        rid="orn:web.page:example_com/abc123",
        domain="example.com",
        title="Test Article",
        description="A test article about herring",
        content_text="This is content about herring monitoring in the Salish Sea.",
        content_hash="deadbeef" * 8,
        word_count=150,
        metadata=PageMetadata(title="Test Article", description="A test article"),
        matching_entities=[],
        fetch_error=fetch_error,
    )


def _make_extraction_result():
    result = MagicMock()
    entity = MagicMock()
    entity.name = "Herring Monitoring"
    entity.type = "Practice"
    entity.confidence = 0.9
    entity.context = "monitoring herring populations"
    result.entities = [entity]
    result.relationships = []
    result.summary = "Article about herring monitoring"
    result.model_used = "gemini-2.0-flash"
    return result


def _make_app(pool=None, caps=None):
    pool = pool or _make_mock_pool()
    caps = caps or _make_mock_caps()
    app = FastAPI()
    router = create_router(pool, caps)
    app.include_router(router)
    return app, pool


# =============================================================================
# POST /web/preview
# =============================================================================


@pytest.mark.asyncio
async def test_preview_success():
    app, pool = _make_app()
    preview = _make_web_preview()

    with patch("api.web_fetcher.fetch_and_preview", new_callable=AsyncMock, return_value=preview):
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/web/preview", json={"url": "https://example.com/article"})

    assert resp.status_code == 200
    data = resp.json()
    assert data["url"] == "https://example.com/article"
    assert data["title"] == "Test Article"
    assert data["word_count"] == 150


@pytest.mark.asyncio
async def test_preview_duplicate_detection():
    """Existing submission → is_duplicate=True."""
    app, pool = _make_app()
    pool._fetchrow_map["web_submissions WHERE url"] = {"id": 1, "status": "previewed"}
    preview = _make_web_preview()

    with patch("api.web_fetcher.fetch_and_preview", new_callable=AsyncMock, return_value=preview):
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/web/preview", json={"url": "https://example.com/article"})

    assert resp.status_code == 200
    assert resp.json()["is_duplicate"] is True


@pytest.mark.asyncio
async def test_preview_cat_receipt_created():
    """Verify create_receipt is called for web_fetch."""
    app, pool = _make_app()
    preview = _make_web_preview()

    with patch("api.web_fetcher.fetch_and_preview", new_callable=AsyncMock, return_value=preview):
        with patch("api.cat_receipts.create_receipt", new_callable=AsyncMock) as mock_receipt:
            transport = ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post("/web/preview", json={"url": "https://example.com/article"})

    assert resp.status_code == 200
    mock_receipt.assert_called_once()
    call_kwargs = mock_receipt.call_args
    # Check transformation_type is web_fetch (could be positional or keyword)
    all_args = str(call_kwargs)
    assert "web_fetch" in all_args


# =============================================================================
# POST /web/evaluate
# =============================================================================


@pytest.mark.asyncio
async def test_evaluate_success():
    app, pool = _make_app()
    extraction = _make_extraction_result()

    with patch("api.web_fetcher.fetch_and_preview", new_callable=AsyncMock, return_value=_make_web_preview()):
        with patch("api.llm_enricher.extract_from_content", new_callable=AsyncMock, return_value=extraction):
            transport = ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post("/web/evaluate", json={"url": "https://example.com/article"})

    assert resp.status_code == 200
    data = resp.json()
    assert data["relevance_score"] > 0
    assert len(data["suggested_entities"]) == 1


@pytest.mark.asyncio
async def test_evaluate_llm_disabled():
    """LLM disabled → 501."""
    caps = _make_mock_caps(llm=False)
    app, pool = _make_app(caps=caps)

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/web/evaluate", json={"url": "https://example.com"})

    assert resp.status_code == 501


# =============================================================================
# POST /web/process
# =============================================================================


@pytest.mark.asyncio
async def test_process_full_pipeline():
    app, pool = _make_app()
    preview = _make_web_preview()
    extraction = _make_extraction_result()

    with patch("api.web_fetcher.fetch_and_preview", new_callable=AsyncMock, return_value=preview):
        with patch("api.llm_enricher.extract_from_content", new_callable=AsyncMock, return_value=extraction):
            transport = ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post("/web/process", json={"url": "https://example.com/article"})

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "processed"
    assert data["quality_stats"] is not None
    assert data["quality_stats"]["total_input"] >= 1


@pytest.mark.asyncio
async def test_process_auto_ingest():
    """auto_ingest=True → resolve + store called."""
    app, pool = _make_app()
    preview = _make_web_preview()
    extraction = _make_extraction_result()

    mock_canonical = MagicMock()
    mock_canonical.uri = "orn:personal-koi.entity:practice-herring-abc"

    with patch("api.web_fetcher.fetch_and_preview", new_callable=AsyncMock, return_value=preview):
        with patch("api.llm_enricher.extract_from_content", new_callable=AsyncMock, return_value=extraction):
            with patch("api.personal_ingest_api.resolve_entity", new_callable=AsyncMock, return_value=(mock_canonical, True)):
                with patch("api.personal_ingest_api.store_new_entity", new_callable=AsyncMock):
                    transport = ASGITransport(app=app)
                    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                        resp = await client.post("/web/process", json={
                            "url": "https://example.com/article",
                            "auto_ingest": True,
                        })

    assert resp.status_code == 200


# =============================================================================
# POST /web/ingest
# =============================================================================


@pytest.mark.asyncio
async def test_ingest_creates_entities():
    app, pool = _make_app()
    mock_canonical = MagicMock()
    mock_canonical.uri = "orn:personal-koi.entity:practice-herring-abc"

    pool._fetchrow_map["web_submissions WHERE url"] = {"rid": "orn:web.page:example_com/abc"}
    # entity_registry lookups for duplicate_filter should return None (no duplicates)

    with patch("api.personal_ingest_api.resolve_entity", new_callable=AsyncMock, return_value=(mock_canonical, True)):
        with patch("api.personal_ingest_api.store_new_entity", new_callable=AsyncMock) as mock_store:
            transport = ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post("/web/ingest", json={
                    "url": "https://example.com/article",
                    "entities": [{"name": "Herring Monitoring", "type": "Practice"}],
                })

    assert resp.status_code == 200
    data = resp.json()
    assert data["entities_resolved"] == 1
    assert data["entities_created"] == 1


@pytest.mark.asyncio
async def test_ingest_skips_confidence_filter():
    """Ingest path uses skip_confidence=True."""
    app, pool = _make_app()
    mock_canonical = MagicMock()
    mock_canonical.uri = "orn:entity:test"

    pool._fetchrow_map["web_submissions WHERE url"] = {"rid": "orn:web:test"}

    with patch("api.personal_ingest_api.resolve_entity", new_callable=AsyncMock, return_value=(mock_canonical, False)):
        with patch("api.quality_gates.filter_entities", new_callable=AsyncMock) as mock_filter:
            mock_report = MagicMock()
            mock_report.total_input = 1
            mock_report.accepted = 1
            mock_report.rejected = 0
            mock_report.rejected_by_stage = {}
            mock_filter.return_value = mock_report

            with patch("api.quality_gates.get_accepted_entities") as mock_get:
                mock_get.return_value = [{"name": "Test Entity", "type": "Concept"}]
                transport = ASGITransport(app=app)
                async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                    resp = await client.post("/web/ingest", json={
                        "url": "https://example.com",
                        "entities": [{"name": "Test Entity", "type": "Concept", "confidence": 0.1}],
                    })

    assert resp.status_code == 200
    mock_filter.assert_called_once()
    _, kwargs = mock_filter.call_args
    assert kwargs.get("skip_confidence") is True


@pytest.mark.asyncio
async def test_ingest_quality_gate_rejection():
    """Pronoun entity rejected by quality gate."""
    app, pool = _make_app()
    pool._fetchrow_map["web_submissions WHERE url"] = {"rid": "orn:web:test"}

    # Don't mock quality_gates — let real filter run (it will reject "they")
    with patch("api.personal_ingest_api.resolve_entity", new_callable=AsyncMock) as mock_resolve:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/web/ingest", json={
                "url": "https://example.com",
                "entities": [{"name": "they", "type": "Person"}],
            })

    assert resp.status_code == 200
    data = resp.json()
    assert data["entities_resolved"] == 0
    assert data["quality_stats"]["rejected"] >= 1


@pytest.mark.asyncio
async def test_ingest_creates_relationships():
    """Relationship SQL executed for each relationship."""
    app, pool = _make_app()
    mock_canonical = MagicMock()
    mock_canonical.uri = "orn:entity:herring"
    pool._fetchrow_map["web_submissions WHERE url"] = {"rid": "orn:web:test"}

    with patch("api.personal_ingest_api.resolve_entity", new_callable=AsyncMock, return_value=(mock_canonical, False)):
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/web/ingest", json={
                "url": "https://example.com",
                "entities": [{"name": "Herring", "type": "Concept"}],
                "relationships": [{"subject": "Herring", "predicate": "located_in", "object": "Salish Sea"}],
            })

    assert resp.status_code == 200
    data = resp.json()
    assert data["relationships_created"] == 1


@pytest.mark.asyncio
async def test_ingest_no_duplication():
    """Regression: 1 accepted entity → entities_resolved==1 (not 3 from previous bug)."""
    app, pool = _make_app()
    mock_canonical = MagicMock()
    mock_canonical.uri = "orn:entity:single"
    pool._fetchrow_map["web_submissions WHERE url"] = {"rid": "orn:web:test"}

    with patch("api.personal_ingest_api.resolve_entity", new_callable=AsyncMock, return_value=(mock_canonical, False)):
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/web/ingest", json={
                "url": "https://example.com",
                "entities": [{"name": "Single Entity", "type": "Concept"}],
            })

    assert resp.status_code == 200
    data = resp.json()
    assert data["entities_resolved"] == 1


@pytest.mark.asyncio
async def test_ingest_store_before_link():
    """is_new=True path calls store_new_entity() before document_entity_links INSERT."""
    app, pool = _make_app()
    mock_canonical = MagicMock()
    mock_canonical.uri = "orn:entity:new-thing"
    pool._fetchrow_map["web_submissions WHERE url"] = {"rid": "orn:web:test"}

    call_order = []

    async def mock_store(*args, **kwargs):
        call_order.append("store")

    async def mock_execute(query, *args):
        if "document_entity_links" in query:
            call_order.append("link")

    with patch("api.personal_ingest_api.resolve_entity", new_callable=AsyncMock, return_value=(mock_canonical, True)):
        with patch("api.personal_ingest_api.store_new_entity", side_effect=mock_store):
            pool._mock_conn.execute.side_effect = mock_execute
            transport = ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post("/web/ingest", json={
                    "url": "https://example.com",
                    "entities": [{"name": "New Thing", "type": "Concept"}],
                })

    assert resp.status_code == 200
    # store should come before link
    if "store" in call_order and "link" in call_order:
        assert call_order.index("store") < call_order.index("link")


# =============================================================================
# GET /web/submissions
# =============================================================================


@pytest.mark.asyncio
async def test_submissions_list():
    app, pool = _make_app()
    pool._mock_conn.fetch.return_value = [
        {"url": "https://example.com", "rid": "orn:web:test", "status": "previewed",
         "title": "Test", "relevance_score": None, "word_count": 100,
         "submitted_by": None, "submitted_via": "api", "created_at": None,
         "fetched_at": None, "evaluated_at": None, "ingested_at": None},
    ]

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/web/submissions")

    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) == 1
    assert data[0]["url"] == "https://example.com"


# =============================================================================
# GET /web/monitor
# =============================================================================


@pytest.mark.asyncio
async def test_monitor_status():
    app, pool = _make_app()

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/web/monitor")

    assert resp.status_code == 200
    data = resp.json()
    assert "enabled" in data or "urls_monitored" in data


# =============================================================================
# POST /web/monitor/add
# =============================================================================


@pytest.mark.asyncio
async def test_monitor_add_creates_receipt():
    app, pool = _make_app()

    with patch("api.web_sensor.WebSensor") as MockSensor:
        instance = AsyncMock()
        instance.add_url.return_value = {"status": "added", "url": "https://example.com"}
        MockSensor.return_value = instance

        with patch("api.cat_receipts.create_receipt", new_callable=AsyncMock) as mock_receipt:
            transport = ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post("/web/monitor/add", json={
                    "url": "https://example.com",
                    "title": "Example Site",
                })

    assert resp.status_code == 200
    mock_receipt.assert_called_once()
    call_str = str(mock_receipt.call_args)
    assert "sensor_registration" in call_str


# =============================================================================
# GET /web/health
# =============================================================================


@pytest.mark.asyncio
async def test_web_health():
    app, pool = _make_app()
    pool._fetchrow_map["FILTER"] = {
        "submissions_24h": 10,
        "errors_24h": 2,
        "monitored": 3,
        "pending_eval": 1,
    }

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/web/health")

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["submissions_24h"] == 10
    assert data["errors_24h"] == 2
    assert data["monitored_urls"] == 3
    assert data["pending_evaluations"] == 1


@pytest.mark.asyncio
async def test_web_health_degraded():
    """Error count >= 5 → status=degraded."""
    app, pool = _make_app()
    pool._fetchrow_map["FILTER"] = {
        "submissions_24h": 20,
        "errors_24h": 7,
        "monitored": 0,
        "pending_eval": 0,
    }

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/web/health")

    assert resp.status_code == 200
    assert resp.json()["status"] == "degraded"


# =============================================================================
# GET /web/provenance/{url}
# =============================================================================


@pytest.mark.asyncio
async def test_provenance_chain():
    """Provenance returns receipt chain for a URL."""
    from api.cat_receipts import CATReceipt
    from datetime import datetime, timezone

    app, pool = _make_app()
    receipt = CATReceipt(
        receipt_id="abc123",
        transformation_type="web_fetch",
        input_rid="https://example.com",
        output_rid="orn:web:test",
        processor_name="web_fetcher",
        source_sensor="api",
        created_at=datetime(2026, 2, 28, tzinfo=timezone.utc),
    )

    pool._fetchrow_map["web_submissions WHERE url"] = {"rid": "orn:web:test"}
    pool._mock_conn.fetch.return_value = []

    with patch("api.cat_receipts.get_receipts_for_url", new_callable=AsyncMock, return_value=[receipt]):
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/web/provenance/https://example.com")

    assert resp.status_code == 200
    data = resp.json()
    assert data["receipt_count"] >= 1
    assert data["receipts"][0]["transformation_type"] == "web_fetch"


@pytest.mark.asyncio
async def test_provenance_not_found():
    """No receipts → 404."""
    app, pool = _make_app()
    pool._mock_conn.fetch.return_value = []

    with patch("api.cat_receipts.get_receipts_for_url", new_callable=AsyncMock, return_value=[]):
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/web/provenance/https://unknown.example.com")

    assert resp.status_code == 404
