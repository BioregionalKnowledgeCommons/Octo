"""Quality gates for web content entity extraction.

4-stage pipeline that filters extracted entities before ingestion:
1. ConfidenceFilter — null confidence → 0.0, reject below threshold
2. EntityQualityFilter — block pronouns, generic nouns, URLs-as-names, etc.
3. DuplicateFilter — check entity_registry for existing matches
4. BioregionalRelevanceFilter — skip entities from low-relevance sources

Module order matters: cheapest checks first, DB-dependent checks last.
"""

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# -- Filter configuration ---------------------------------------------------

CONFIDENCE_THRESHOLD = 0.6

# Pronouns and generic terms to reject
BLOCKED_NAMES = {
    "he", "she", "it", "they", "them", "his", "her", "its", "their",
    "this", "that", "these", "those", "who", "what", "which", "where",
    "the", "a", "an", "someone", "something", "everyone", "everything",
    "nothing", "nobody", "anybody", "anything", "none", "other", "others",
    "people", "person", "thing", "things", "group", "groups",
    "organization", "company", "project", "concept", "location",
    "unknown", "n/a", "na", "null", "undefined", "tbd",
}

# Patterns that indicate bad entity names
BAD_NAME_PATTERNS = [
    re.compile(r"^https?://", re.IGNORECASE),          # URLs as names
    re.compile(r"^[a-zA-Z]$"),                          # Single characters
    re.compile(r"^\d+$"),                                # Pure numbers
    re.compile(r"^[^a-zA-Z]*$"),                         # No letters at all
    re.compile(r"\b(is|are|was|were|the|and|or)\b.*\b(is|are|was|were|the|and|or)\b", re.IGNORECASE),  # Sentence fragments
    re.compile(r"^.{0,1}$"),                             # Empty or single char
    re.compile(r"^.{200,}$"),                            # Absurdly long names
]

BIOREGIONAL_RELEVANCE_THRESHOLD = 0.3


# -- Result types -----------------------------------------------------------

@dataclass
class FilterResult:
    """Result of filtering a single entity."""
    entity: Dict[str, Any]
    accepted: bool
    rejected_by: Optional[str] = None
    reason: Optional[str] = None


@dataclass
class QualityReport:
    """Summary of quality gate filtering."""
    total_input: int = 0
    accepted: int = 0
    rejected: int = 0
    rejected_by_stage: Dict[str, int] = field(default_factory=dict)
    details: List[FilterResult] = field(default_factory=list)


# -- Filters ----------------------------------------------------------------

def confidence_filter(entities: List[Dict[str, Any]]) -> List[FilterResult]:
    """Stage 1: Filter by confidence. Null confidence coalesces to 0.0."""
    results = []
    for entity in entities:
        confidence = entity.get("confidence")
        if confidence is None:
            confidence = 0.0
        confidence = float(confidence)

        if confidence < CONFIDENCE_THRESHOLD:
            results.append(FilterResult(
                entity=entity,
                accepted=False,
                rejected_by="ConfidenceFilter",
                reason=f"confidence {confidence:.2f} < {CONFIDENCE_THRESHOLD}",
            ))
        else:
            results.append(FilterResult(entity=entity, accepted=True))
    return results


def entity_quality_filter(entities: List[Dict[str, Any]]) -> List[FilterResult]:
    """Stage 2: Filter by entity name quality."""
    results = []
    for entity in entities:
        name = (entity.get("name") or "").strip()
        name_lower = name.lower()

        # Check blocked names
        if name_lower in BLOCKED_NAMES:
            results.append(FilterResult(
                entity=entity,
                accepted=False,
                rejected_by="EntityQualityFilter",
                reason=f"blocked name: '{name}'",
            ))
            continue

        # Check bad patterns
        rejected = False
        for pattern in BAD_NAME_PATTERNS:
            if pattern.search(name):
                results.append(FilterResult(
                    entity=entity,
                    accepted=False,
                    rejected_by="EntityQualityFilter",
                    reason=f"bad pattern match: '{name}'",
                ))
                rejected = True
                break

        if not rejected:
            results.append(FilterResult(entity=entity, accepted=True))

    return results


async def duplicate_filter(
    entities: List[Dict[str, Any]], conn
) -> List[FilterResult]:
    """Stage 3: Filter entities that already exist in entity_registry."""
    results = []
    for entity in entities:
        name = (entity.get("name") or "").strip()
        entity_type = entity.get("type", "")

        # Check for exact match in entity_registry
        from api.personal_ingest_api import normalize_entity_text
        normalized = normalize_entity_text(name)

        if entity_type:
            existing = await conn.fetchrow(
                "SELECT fuseki_uri FROM entity_registry WHERE normalized_text = $1 AND entity_type = $2 LIMIT 1",
                normalized, entity_type,
            )
        else:
            existing = await conn.fetchrow(
                "SELECT fuseki_uri FROM entity_registry WHERE normalized_text = $1 LIMIT 1",
                normalized,
            )

        if existing:
            # Not rejected — duplicates are still valid, they just resolve to existing entities
            # Mark them so the caller knows they already exist
            entity["_existing_uri"] = existing["fuseki_uri"]

        results.append(FilterResult(entity=entity, accepted=True))

    return results


def bioregional_relevance_filter(
    entities: List[Dict[str, Any]], source_relevance_score: Optional[float] = None
) -> List[FilterResult]:
    """Stage 4: Skip entity creation for low-relevance sources."""
    results = []

    if source_relevance_score is None or source_relevance_score >= BIOREGIONAL_RELEVANCE_THRESHOLD:
        # No score or above threshold — pass all through
        for entity in entities:
            results.append(FilterResult(entity=entity, accepted=True))
        return results

    # Below threshold — reject all entities from this source
    for entity in entities:
        results.append(FilterResult(
            entity=entity,
            accepted=False,
            rejected_by="BioregionalRelevanceFilter",
            reason=f"source relevance {source_relevance_score:.2f} < {BIOREGIONAL_RELEVANCE_THRESHOLD}",
        ))

    return results


# -- Pipeline orchestrator --------------------------------------------------

async def filter_entities(
    entities: List[Dict[str, Any]],
    conn=None,
    source_relevance_score: Optional[float] = None,
    skip_confidence: bool = False,
) -> QualityReport:
    """Run all quality gates on a list of extracted entities.

    Args:
        entities: List of entity dicts with at least 'name', 'type', optional 'confidence'
        conn: Database connection (required for duplicate filter)
        source_relevance_score: Optional relevance score of the source document
        skip_confidence: If True, skip the ConfidenceFilter (for agent-curated entities)

    Returns:
        QualityReport with accepted entities and rejection details
    """
    report = QualityReport(total_input=len(entities))
    current = entities

    # Stage 1: Confidence (skipped for agent-curated, user-approved entities)
    if not skip_confidence:
        stage_results = confidence_filter(current)
        current = _apply_stage(stage_results, report)

    # Stage 2: Entity quality
    stage_results = entity_quality_filter(current)
    current = _apply_stage(stage_results, report)

    # Stage 3: Duplicate check (requires DB)
    if conn and current:
        stage_results = await duplicate_filter(current, conn)
        current = _apply_stage(stage_results, report)

    # Stage 4: Bioregional relevance
    stage_results = bioregional_relevance_filter(current, source_relevance_score)
    current = _apply_stage(stage_results, report)

    report.accepted = len(current)
    report._final_entities = current  # store final survivors for get_accepted_entities
    logger.info(
        f"Quality gates: {report.total_input} input → {report.accepted} accepted, "
        f"{report.rejected} rejected ({report.rejected_by_stage})"
    )

    return report


def _apply_stage(results: List[FilterResult], report: QualityReport) -> List[Dict[str, Any]]:
    """Apply stage results: collect rejections and return accepted entities."""
    accepted = []
    for r in results:
        report.details.append(r)
        if r.accepted:
            accepted.append(r.entity)
        else:
            report.rejected += 1
            stage = r.rejected_by or "unknown"
            report.rejected_by_stage[stage] = report.rejected_by_stage.get(stage, 0) + 1
    return accepted


def get_accepted_entities(report: QualityReport) -> List[Dict[str, Any]]:
    """Extract the final list of entities that passed ALL quality gates."""
    return list(getattr(report, "_final_entities", []))
