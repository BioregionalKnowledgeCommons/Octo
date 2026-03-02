"""Tests for api/cat_receipts.py — CAT provenance receipt chain."""

import pytest
from unittest.mock import AsyncMock

from api.cat_receipts import (
    generate_receipt_id,
    create_receipt,
    get_receipt_chain,
    CATReceipt,
)


# =============================================================================
# generate_receipt_id — Pure function tests
# =============================================================================


def test_receipt_id_deterministic():
    """Same inputs + fixed timestamp → same hash."""
    ts = "2026-02-28T12:00:00+00:00"
    id1 = generate_receipt_id("web_fetch", "orn:web:input", "orn:web:output", timestamp=ts)
    id2 = generate_receipt_id("web_fetch", "orn:web:input", "orn:web:output", timestamp=ts)
    assert id1 == id2
    assert len(id1) == 64  # SHA-256 hex


def test_receipt_id_varies_with_type():
    """Different transformation_type → different hash."""
    ts = "2026-02-28T12:00:00+00:00"
    id_fetch = generate_receipt_id("web_fetch", "orn:in", "orn:out", timestamp=ts)
    id_extract = generate_receipt_id("llm_extraction", "orn:in", "orn:out", timestamp=ts)
    assert id_fetch != id_extract


def test_receipt_id_varies_with_rids():
    """Different input/output RIDs → different hash."""
    ts = "2026-02-28T12:00:00+00:00"
    id1 = generate_receipt_id("web_fetch", "orn:in:a", "orn:out:a", timestamp=ts)
    id2 = generate_receipt_id("web_fetch", "orn:in:b", "orn:out:b", timestamp=ts)
    assert id1 != id2


def test_receipt_id_without_timestamp_still_works():
    """Without explicit timestamp, uses current time — still returns valid hash."""
    rid = generate_receipt_id("web_fetch", "orn:in", "orn:out")
    assert len(rid) == 64


# =============================================================================
# create_receipt — Mock-DB tests
# =============================================================================


@pytest.mark.asyncio
async def test_create_receipt_success():
    """Happy path: receipt created and returned with correct fields."""
    mock_conn = AsyncMock()

    receipt = await create_receipt(
        mock_conn,
        transformation_type="web_fetch",
        input_rid="https://example.com",
        output_rid="orn:web.page:example_com/abc123",
        processor_name="web_fetcher",
        source_sensor="api",
        metadata={"title": "Example"},
    )

    assert receipt.transformation_type == "web_fetch"
    assert receipt.input_rid == "https://example.com"
    assert receipt.output_rid == "orn:web.page:example_com/abc123"
    assert receipt.processor_name == "web_fetcher"
    assert receipt.metadata == {"title": "Example"}
    assert len(receipt.receipt_id) == 64
    mock_conn.execute.assert_called_once()


@pytest.mark.asyncio
async def test_create_receipt_db_failure_non_fatal():
    """DB failure is non-fatal — receipt still returned."""
    mock_conn = AsyncMock()
    mock_conn.execute.side_effect = Exception("connection lost")

    receipt = await create_receipt(
        mock_conn,
        transformation_type="web_fetch",
        input_rid="https://example.com",
        output_rid="orn:web:out",
        processor_name="web_fetcher",
    )

    # Should still return a receipt (non-fatal)
    assert receipt.transformation_type == "web_fetch"
    assert len(receipt.receipt_id) == 64


# =============================================================================
# get_receipt_chain — Mock-DB tests
# =============================================================================


@pytest.mark.asyncio
async def test_get_receipt_chain_traversal():
    """Walk 3 linked receipts, verify chain order + cycle safety."""
    # Create mock rows that simulate a 3-receipt chain
    rows = {
        "receipt_c": {
            "receipt_id": "receipt_c",
            "transformation_type": "entity_resolution",
            "input_rid": "orn:in:c",
            "output_rid": "orn:out:c",
            "parent_receipt_id": "receipt_b",
            "processor_name": "resolver",
            "source_sensor": "api",
            "metadata": "{}",
            "content_hash": None,
            "created_at": None,
        },
        "receipt_b": {
            "receipt_id": "receipt_b",
            "transformation_type": "llm_extraction",
            "input_rid": "orn:in:b",
            "output_rid": "orn:out:b",
            "parent_receipt_id": "receipt_a",
            "processor_name": "gemini",
            "source_sensor": "api",
            "metadata": "{}",
            "content_hash": None,
            "created_at": None,
        },
        "receipt_a": {
            "receipt_id": "receipt_a",
            "transformation_type": "web_fetch",
            "input_rid": "orn:in:a",
            "output_rid": "orn:out:a",
            "parent_receipt_id": None,
            "processor_name": "web_fetcher",
            "source_sensor": "api",
            "metadata": "{}",
            "content_hash": None,
            "created_at": None,
        },
    }

    mock_conn = AsyncMock()
    mock_conn.fetchrow.side_effect = lambda query, rid: rows.get(rid)

    chain = await get_receipt_chain(mock_conn, "receipt_c")

    assert len(chain) == 3
    assert chain[0].receipt_id == "receipt_c"
    assert chain[1].receipt_id == "receipt_b"
    assert chain[2].receipt_id == "receipt_a"
    # Root has no parent
    assert chain[2].parent_receipt_id is None


@pytest.mark.asyncio
async def test_get_receipt_chain_cycle_safety():
    """Chain walking stops on cycle (seen-set guard)."""
    # receipt_a points to receipt_b which points back to receipt_a
    rows = {
        "receipt_a": {
            "receipt_id": "receipt_a",
            "transformation_type": "web_fetch",
            "input_rid": "orn:in",
            "output_rid": "orn:out",
            "parent_receipt_id": "receipt_b",
            "processor_name": "test",
            "source_sensor": "test",
            "metadata": "{}",
            "content_hash": None,
            "created_at": None,
        },
        "receipt_b": {
            "receipt_id": "receipt_b",
            "transformation_type": "llm_extraction",
            "input_rid": "orn:in",
            "output_rid": "orn:out",
            "parent_receipt_id": "receipt_a",  # cycle!
            "processor_name": "test",
            "source_sensor": "test",
            "metadata": "{}",
            "content_hash": None,
            "created_at": None,
        },
    }

    mock_conn = AsyncMock()
    mock_conn.fetchrow.side_effect = lambda query, rid: rows.get(rid)

    chain = await get_receipt_chain(mock_conn, "receipt_a")

    # Should stop after seeing both, not loop forever
    assert len(chain) == 2
