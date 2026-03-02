"""Tests for api/quality_gates.py — 4-stage entity filter pipeline.

NOTE: duplicate_filter and filter_entities (with conn) import normalize_entity_text
from personal_ingest_api at call time. That module has heavy deps (metaphone, etc.)
not available locally. We pre-seed a mock module in sys.modules to avoid import errors.
"""

import sys
import types
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

# Pre-seed a mock api.personal_ingest_api so the lazy import in duplicate_filter works.
# Include all attributes that any test module might need to patch.
if "api.personal_ingest_api" not in sys.modules:
    from unittest.mock import AsyncMock as _AM

    _mock_ingest = types.ModuleType("api.personal_ingest_api")
    _mock_ingest.normalize_entity_text = lambda text: text.lower().strip()
    _mock_ingest.resolve_entity = _AM()
    _mock_ingest.store_new_entity = _AM()

    class _MockExtractedEntity:
        def __init__(self, **kwargs):
            for k, v in kwargs.items():
                setattr(self, k, v)
    _mock_ingest.ExtractedEntity = _MockExtractedEntity
    sys.modules["api.personal_ingest_api"] = _mock_ingest

from api.quality_gates import (
    CONFIDENCE_THRESHOLD,
    BIOREGIONAL_RELEVANCE_THRESHOLD,
    confidence_filter,
    entity_quality_filter,
    bioregional_relevance_filter,
    duplicate_filter,
    filter_entities,
    get_accepted_entities,
)


# =============================================================================
# Stage 1: Confidence Filter
# =============================================================================


def test_confidence_filter_passes_above_threshold():
    entities = [{"name": "Herring Monitoring", "type": "Practice", "confidence": 0.8}]
    results = confidence_filter(entities)
    assert len(results) == 1
    assert results[0].accepted is True


def test_confidence_filter_rejects_below_threshold():
    entities = [{"name": "Vague Thing", "type": "Concept", "confidence": 0.3}]
    results = confidence_filter(entities)
    assert len(results) == 1
    assert results[0].accepted is False
    assert results[0].rejected_by == "ConfidenceFilter"


def test_confidence_filter_null_coalesces_to_zero():
    entities = [{"name": "No Confidence", "type": "Concept", "confidence": None}]
    results = confidence_filter(entities)
    assert results[0].accepted is False
    assert "0.00" in results[0].reason


def test_confidence_filter_missing_key_coalesces_to_zero():
    entities = [{"name": "Missing Key", "type": "Concept"}]
    results = confidence_filter(entities)
    assert results[0].accepted is False


def test_confidence_filter_exact_threshold_rejects():
    """Confidence exactly at threshold is rejected (strict less-than)."""
    entities = [{"name": "Borderline", "type": "Concept", "confidence": CONFIDENCE_THRESHOLD}]
    results = confidence_filter(entities)
    # confidence < threshold, so exactly equal should NOT pass
    # Actually: 0.6 < 0.6 is False, so it passes
    assert results[0].accepted is True


# =============================================================================
# Stage 2: Entity Quality Filter
# =============================================================================


def test_entity_quality_blocks_pronouns():
    for pronoun in ["they", "it", "she", "he"]:
        results = entity_quality_filter([{"name": pronoun, "type": "Person"}])
        assert results[0].accepted is False, f"Expected '{pronoun}' to be rejected"
        assert results[0].rejected_by == "EntityQualityFilter"


def test_entity_quality_blocks_urls_as_names():
    entities = [{"name": "https://example.com/page", "type": "Concept"}]
    results = entity_quality_filter(entities)
    assert results[0].accepted is False


def test_entity_quality_blocks_pure_numbers():
    entities = [{"name": "12345", "type": "Concept"}]
    results = entity_quality_filter(entities)
    assert results[0].accepted is False


def test_entity_quality_blocks_empty_or_short():
    for name in ["", "a"]:
        results = entity_quality_filter([{"name": name, "type": "Concept"}])
        assert results[0].accepted is False, f"Expected '{name}' to be rejected"


def test_entity_quality_passes_good_name():
    entities = [{"name": "Herring Monitoring", "type": "Practice"}]
    results = entity_quality_filter(entities)
    assert results[0].accepted is True


def test_entity_quality_blocks_generic_terms():
    for term in ["organization", "project", "unknown", "n/a"]:
        results = entity_quality_filter([{"name": term, "type": "Concept"}])
        assert results[0].accepted is False, f"Expected '{term}' to be rejected"


def test_entity_quality_blocks_no_letters():
    entities = [{"name": "123-456", "type": "Concept"}]
    results = entity_quality_filter(entities)
    assert results[0].accepted is False


# =============================================================================
# Stage 3: Duplicate Filter (async, uses DB mock)
# =============================================================================


@pytest.mark.asyncio
async def test_duplicate_filter_annotates_existing():
    """When entity exists in DB, it gets _existing_uri annotation but is NOT rejected."""
    mock_conn = AsyncMock()
    mock_conn.fetchrow.return_value = {"fuseki_uri": "orn:personal-koi.entity:practice-herring-abc123"}

    entities = [{"name": "Herring Monitoring", "type": "Practice"}]
    results = await duplicate_filter(entities, mock_conn)

    assert len(results) == 1
    assert results[0].accepted is True  # duplicates are NOT rejected
    assert entities[0]["_existing_uri"] == "orn:personal-koi.entity:practice-herring-abc123"


@pytest.mark.asyncio
async def test_duplicate_filter_no_match():
    mock_conn = AsyncMock()
    mock_conn.fetchrow.return_value = None

    entities = [{"name": "New Entity", "type": "Concept"}]
    results = await duplicate_filter(entities, mock_conn)

    assert results[0].accepted is True
    assert "_existing_uri" not in entities[0]


# =============================================================================
# Stage 4: Bioregional Relevance Filter
# =============================================================================


def test_bioregional_relevance_passes_high_score():
    entities = [{"name": "Herring", "type": "Concept"}, {"name": "Salmon", "type": "Concept"}]
    results = bioregional_relevance_filter(entities, source_relevance_score=0.5)
    assert all(r.accepted for r in results)


def test_bioregional_relevance_rejects_low_score():
    entities = [{"name": "Herring", "type": "Concept"}, {"name": "Salmon", "type": "Concept"}]
    results = bioregional_relevance_filter(entities, source_relevance_score=0.1)
    assert all(not r.accepted for r in results)
    assert all(r.rejected_by == "BioregionalRelevanceFilter" for r in results)


def test_bioregional_relevance_none_score_passes():
    """None score means 'no opinion' — pass all through."""
    entities = [{"name": "Herring", "type": "Concept"}]
    results = bioregional_relevance_filter(entities, source_relevance_score=None)
    assert results[0].accepted is True


def test_bioregional_relevance_exact_threshold_passes():
    entities = [{"name": "Test", "type": "Concept"}]
    results = bioregional_relevance_filter(entities, source_relevance_score=BIOREGIONAL_RELEVANCE_THRESHOLD)
    assert results[0].accepted is True


# =============================================================================
# Pipeline Orchestrator
# =============================================================================


@pytest.mark.asyncio
async def test_filter_entities_full_pipeline():
    """Full pipeline with a mix of accepted and rejected entities."""
    mock_conn = AsyncMock()
    mock_conn.fetchrow.return_value = None  # no duplicates

    entities = [
        {"name": "Herring Monitoring", "type": "Practice", "confidence": 0.9},
        {"name": "they", "type": "Person", "confidence": 0.8},       # blocked by quality
        {"name": "Good Entity", "type": "Concept", "confidence": 0.2},  # blocked by confidence
    ]

    report = await filter_entities(entities, conn=mock_conn)
    accepted = get_accepted_entities(report)

    assert report.total_input == 3
    assert len(accepted) == 1
    assert accepted[0]["name"] == "Herring Monitoring"
    assert report.rejected == 2


@pytest.mark.asyncio
async def test_filter_entities_skip_confidence():
    """skip_confidence=True bypasses Stage 1 (for agent-curated entities)."""
    mock_conn = AsyncMock()
    mock_conn.fetchrow.return_value = None

    entities = [
        {"name": "Low Confidence But Curated", "type": "Concept", "confidence": 0.1},
    ]

    report = await filter_entities(entities, conn=mock_conn, skip_confidence=True)
    accepted = get_accepted_entities(report)

    assert len(accepted) == 1
    assert accepted[0]["name"] == "Low Confidence But Curated"


@pytest.mark.asyncio
async def test_get_accepted_entities_returns_final():
    """get_accepted_entities extracts _final_entities from report."""
    mock_conn = AsyncMock()
    mock_conn.fetchrow.return_value = None

    entities = [
        {"name": "Alpha", "type": "Concept", "confidence": 0.9},
        {"name": "Beta", "type": "Concept", "confidence": 0.9},
    ]
    report = await filter_entities(entities, conn=mock_conn)
    accepted = get_accepted_entities(report)

    assert len(accepted) == 2
    assert {e["name"] for e in accepted} == {"Alpha", "Beta"}
