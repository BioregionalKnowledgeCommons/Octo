"""Web curation endpoints (preview, evaluate, process, ingest, submissions, monitor).

Wraps the web_fetcher and llm_enricher modules to provide a REST API for
web content curation.  Only included when caps.web_sensor is True.
"""

import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from api.llm_enricher import LLM_BACKEND

logger = logging.getLogger(__name__)


# -- Request / Response models -----------------------------------------------

class WebPreviewRequest(BaseModel):
    url: str = Field(..., description="URL to fetch and preview")
    submitted_by: Optional[str] = None
    submitted_via: str = "api"


class WebPreviewResponse(BaseModel):
    url: str
    rid: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    author: Optional[str] = None
    published_date: Optional[str] = None
    word_count: int = 0
    content_hash: Optional[str] = None
    matching_entities: List[Dict[str, Any]] = []
    is_duplicate: bool = False
    error: Optional[str] = None


class WebEvaluateRequest(BaseModel):
    url: str = Field(..., description="URL of content to evaluate")
    content: Optional[str] = Field(None, description="Pre-fetched content (skips re-fetch)")
    criteria: Optional[str] = None


class WebEvaluateResponse(BaseModel):
    url: str
    relevance_score: float = Field(0.0, ge=0.0, le=1.0)
    summary: str = ""
    suggested_entities: List[Dict[str, Any]] = []
    rationale: str = ""


class WebProcessRequest(BaseModel):
    url: str
    hint_entities: List[str] = Field(default_factory=list)
    auto_ingest: bool = Field(False, description="If true, ingest after processing")


class WebProcessResponse(BaseModel):
    url: str
    status: str
    preview: Optional[WebPreviewResponse] = None
    evaluation: Optional[WebEvaluateResponse] = None
    entities: List[Dict[str, Any]] = []
    relationships: List[Dict[str, Any]] = []
    quality_stats: Optional[Dict[str, Any]] = None
    ingestion_stats: Optional[Dict[str, Any]] = None
    model_used: Optional[str] = None
    error: Optional[str] = None


class WebIngestEntity(BaseModel):
    name: str
    type: str
    context: Optional[str] = None
    confidence: Optional[float] = None


class WebIngestRelationship(BaseModel):
    subject: str
    predicate: str
    object: str


class WebIngestRequest(BaseModel):
    url: str
    entities: List[WebIngestEntity] = Field(default_factory=list)
    relationships: List[WebIngestRelationship] = Field(default_factory=list)


class WebIngestResponse(BaseModel):
    url: str
    status: str
    entities_resolved: int = 0
    entities_created: int = 0
    relationships_created: int = 0
    quality_stats: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class WebMonitorAddRequest(BaseModel):
    url: str
    title: str = ""


class WebMonitorRemoveRequest(BaseModel):
    url: str


# -- Router factory ----------------------------------------------------------

_web_sensor_instances: Dict[int, Any] = {}  # keyed by pool id to allow lazy init


def create_router(pool, caps):
    """Return an APIRouter for web sensor endpoints."""
    router = APIRouter(prefix="/web", tags=["web"])

    @router.post("/preview", response_model=WebPreviewResponse)
    async def web_preview(body: WebPreviewRequest):
        """Fetch a URL and return metadata plus entity matches."""
        t0 = time.monotonic()
        from api.web_fetcher import fetch_and_preview

        try:
            preview = await fetch_and_preview(body.url, db_pool=pool)
        except Exception as e:
            logger.error(f"Preview failed for {body.url}: {e}")
            raise HTTPException(status_code=500, detail=str(e))

        if preview.fetch_error:
            return WebPreviewResponse(
                url=body.url, error=preview.fetch_error
            )

        # Check for duplicate in web_submissions
        is_duplicate = False
        async with pool.acquire() as conn:
            existing = await conn.fetchrow(
                "SELECT id, status FROM web_submissions WHERE url = $1 LIMIT 1",
                body.url,
            )
            if existing:
                is_duplicate = True

            # Record the submission
            await conn.execute("""
                INSERT INTO web_submissions (url, rid, domain, submitted_by, submitted_via,
                    status, title, description, content_hash, word_count,
                    matching_entities, fetched_at, content_text)
                VALUES ($1, $2, $3, $4, $5, 'previewed', $6, $7, $8, $9, $10::jsonb, NOW(), $11)
                ON CONFLICT (url) DO UPDATE SET
                    status = CASE WHEN web_submissions.status = 'pending' THEN 'previewed' ELSE web_submissions.status END,
                    title = EXCLUDED.title,
                    description = EXCLUDED.description,
                    content_hash = EXCLUDED.content_hash,
                    word_count = EXCLUDED.word_count,
                    matching_entities = EXCLUDED.matching_entities,
                    fetched_at = NOW(),
                    content_text = EXCLUDED.content_text
            """,
                body.url,
                preview.rid,
                preview.domain,
                body.submitted_by,
                body.submitted_via,
                preview.title,
                preview.description,
                preview.content_hash,
                preview.word_count,
                _serialize_matching_entities(preview.matching_entities),
                preview.content_text[:50000] if preview.content_text else None,
            )

        # Create CAT receipt for web fetch
        async with pool.acquire() as conn:
            try:
                from api.cat_receipts import create_receipt
                await create_receipt(
                    conn,
                    transformation_type="web_fetch",
                    input_rid=body.url,
                    output_rid=preview.rid or body.url,
                    processor_name="web_fetcher",
                    source_sensor=body.submitted_via or "api",
                    content_hash=preview.content_hash,
                    metadata={"title": preview.title, "word_count": preview.word_count},
                )
            except Exception as e:
                logger.warning(f"CAT receipt creation failed (non-fatal): {e}")

        elapsed = (time.monotonic() - t0) * 1000
        logger.info(f"web.preview url={body.url} status=ok elapsed_ms={elapsed:.0f}")

        return WebPreviewResponse(
            url=body.url,
            rid=preview.rid,
            title=preview.title,
            description=preview.description,
            author=preview.metadata.author if preview.metadata else None,
            published_date=preview.metadata.published_date if preview.metadata else None,
            word_count=preview.word_count,
            content_hash=preview.content_hash,
            matching_entities=[_entity_to_dict(e) for e in (preview.matching_entities or [])],
            is_duplicate=is_duplicate,
        )

    @router.post("/evaluate", response_model=WebEvaluateResponse)
    async def web_evaluate(body: WebEvaluateRequest):
        """Evaluate content relevance using LLM enrichment."""
        if not caps.llm_enrichment:
            raise HTTPException(status_code=501, detail="LLM enrichment not enabled")

        from api.llm_enricher import extract_from_content
        from api.web_fetcher import fetch_and_preview

        # Get content — either from request or by fetching
        content = body.content
        title = ""
        if not content:
            preview = await fetch_and_preview(body.url, db_pool=pool)
            if preview.fetch_error:
                raise HTTPException(status_code=502, detail=f"Fetch failed: {preview.fetch_error}")
            content = preview.content_text
            title = preview.title or ""

        # Get existing entities for matching context
        existing_entities = []
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT entity_text AS name, entity_type AS type FROM entity_registry LIMIT 200"
            )
            existing_entities = [dict(r) for r in rows]

        result = await extract_from_content(content, title, body.url, existing_entities)

        # Compute relevance from extraction quality
        entity_count = len(result.entities)
        has_summary = bool(result.summary)
        relevance = min(1.0, (entity_count * 0.15) + (0.3 if has_summary else 0.0))

        suggested = [
            {"name": e.name, "type": e.type, "confidence": e.confidence}
            for e in result.entities
        ]

        # Update web_submissions with evaluation
        async with pool.acquire() as conn:
            await conn.execute("""
                UPDATE web_submissions SET
                    status = 'evaluated',
                    relevance_score = $2,
                    relevance_reasoning = $3,
                    evaluated_at = NOW()
                WHERE url = $1
            """, body.url, relevance, result.summary)

        return WebEvaluateResponse(
            url=body.url,
            relevance_score=relevance,
            summary=result.summary,
            suggested_entities=suggested,
            rationale=f"Found {entity_count} entities, {len(result.relationships)} relationships",
        )

    @router.post("/process", response_model=WebProcessResponse)
    async def web_process(body: WebProcessRequest):
        """Full pipeline: fetch, preview, extract entities, optionally ingest."""
        t0 = time.monotonic()
        from api.web_fetcher import fetch_and_preview
        from api.llm_enricher import extract_from_content
        from api.quality_gates import filter_entities, get_accepted_entities

        # Step 1: Preview
        try:
            preview = await fetch_and_preview(body.url, db_pool=pool)
        except Exception as e:
            return WebProcessResponse(url=body.url, status="error", error=str(e))

        if preview.fetch_error:
            return WebProcessResponse(url=body.url, status="error", error=preview.fetch_error)

        preview_resp = WebPreviewResponse(
            url=body.url,
            rid=preview.rid,
            title=preview.title,
            description=preview.description,
            word_count=preview.word_count,
            content_hash=preview.content_hash,
            matching_entities=[_entity_to_dict(e) for e in (preview.matching_entities or [])],
        )

        # Record submission
        async with pool.acquire() as conn:
            await conn.execute("""
                INSERT INTO web_submissions (url, rid, domain, status, title, description,
                    content_hash, word_count, matching_entities, fetched_at, content_text)
                VALUES ($1, $2, $3, 'previewed', $4, $5, $6, $7, $8::jsonb, NOW(), $9)
                ON CONFLICT (url) DO UPDATE SET
                    status = 'previewed',
                    title = EXCLUDED.title,
                    content_hash = EXCLUDED.content_hash,
                    word_count = EXCLUDED.word_count,
                    matching_entities = EXCLUDED.matching_entities,
                    fetched_at = NOW(),
                    content_text = EXCLUDED.content_text
            """,
                body.url, preview.rid, preview.domain,
                preview.title, preview.description,
                preview.content_hash, preview.word_count,
                _serialize_matching_entities(preview.matching_entities),
                preview.content_text[:50000] if preview.content_text else None,
            )

        # Step 2: LLM extraction
        eval_resp = None
        entities_raw = []
        relationships_raw = []
        model_used = None

        if caps.llm_enrichment and preview.content_text:
            existing_entities = []
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT entity_text AS name, entity_type AS type FROM entity_registry LIMIT 200"
                )
                existing_entities = [dict(r) for r in rows]

            extraction = await extract_from_content(
                preview.content_text, preview.title or "", body.url, existing_entities
            )
            model_used = extraction.model_used

            entities_raw = [
                {"name": e.name, "type": e.type, "confidence": e.confidence, "context": getattr(e, "context", "")}
                for e in extraction.entities
            ]
            relationships_raw = [
                {"subject": r.subject, "predicate": r.predicate, "object": r.object}
                for r in extraction.relationships
            ]

            relevance = min(1.0, len(extraction.entities) * 0.15 + (0.3 if extraction.summary else 0.0))
            eval_resp = WebEvaluateResponse(
                url=body.url,
                relevance_score=relevance,
                summary=extraction.summary,
                suggested_entities=[
                    {"name": e.name, "type": e.type, "confidence": e.confidence}
                    for e in extraction.entities
                ],
                rationale=f"Extracted {len(extraction.entities)} entities, {len(extraction.relationships)} relationships",
            )

            # Update submission status
            async with pool.acquire() as conn:
                await conn.execute("""
                    UPDATE web_submissions SET status = 'evaluated', relevance_score = $2,
                        relevance_reasoning = $3, evaluated_at = NOW()
                    WHERE url = $1
                """, body.url, relevance, extraction.summary)

                # CAT receipt for LLM extraction
                try:
                    from api.cat_receipts import create_receipt
                    # Find parent (web_fetch) receipt
                    parent = await conn.fetchrow(
                        "SELECT receipt_id FROM koi_transformation_receipts WHERE input_rid = $1 AND transformation_type = 'web_fetch' ORDER BY created_at DESC LIMIT 1",
                        body.url,
                    )
                    await create_receipt(
                        conn,
                        transformation_type="llm_extraction",
                        input_rid=preview.rid or body.url,
                        output_rid=f"{preview.rid or body.url}:extraction",
                        processor_name=extraction.model_used or LLM_BACKEND,
                        source_sensor="api",
                        parent_receipt_id=parent["receipt_id"] if parent else None,
                        metadata={
                            "entities_extracted": len(extraction.entities),
                            "relationships_extracted": len(extraction.relationships),
                            "relevance_score": relevance,
                        },
                    )
                except Exception as e:
                    logger.warning(f"CAT receipt creation failed (non-fatal): {e}")

        # Step 3: Quality gates on extracted entities
        quality_stats = None
        if entities_raw:
            async with pool.acquire() as conn:
                source_relevance = eval_resp.relevance_score if eval_resp else None
                report = await filter_entities(entities_raw, conn=conn, source_relevance_score=source_relevance)
                entities_raw = get_accepted_entities(report)
                quality_stats = {
                    "total_input": report.total_input,
                    "accepted": report.accepted,
                    "rejected": report.rejected,
                    "rejected_by_stage": report.rejected_by_stage,
                }

        # Step 4: Auto-ingest if requested
        entities_created = 0
        entities_resolved = 0
        if body.auto_ingest and entities_raw:
            async with pool.acquire() as conn:
                from api.personal_ingest_api import resolve_entity, store_new_entity, ExtractedEntity
                for ent in entities_raw:
                    extracted = ExtractedEntity(
                        name=ent["name"],
                        type=ent.get("type", "Concept"),
                        confidence=ent.get("confidence") if ent.get("confidence") is not None else 0.9,
                    )
                    canonical, is_new = await resolve_entity(conn, extracted)
                    entities_resolved += 1
                    if is_new:
                        await store_new_entity(conn, extracted, canonical, preview.rid or body.url, source="web_process")
                        entities_created += 1

                await conn.execute("""
                    UPDATE web_submissions SET status = 'ingested', ingested_at = NOW()
                    WHERE url = $1
                """, body.url)

        elapsed = (time.monotonic() - t0) * 1000
        logger.info(f"web.process url={body.url} entities={len(entities_raw)} elapsed_ms={elapsed:.0f}")

        return WebProcessResponse(
            url=body.url,
            status="processed",
            preview=preview_resp,
            evaluation=eval_resp,
            entities=entities_raw,
            relationships=relationships_raw,
            quality_stats=quality_stats,
            ingestion_stats={
                "new_entities": entities_created,
                "resolved_entities": entities_resolved,
                "new_relationships": 0,
            } if body.auto_ingest else None,
            model_used=model_used,
        )

    @router.post("/ingest", response_model=WebIngestResponse)
    async def web_ingest(body: WebIngestRequest):
        """Ingest entities from a previously-processed URL into the knowledge graph."""
        t0 = time.monotonic()
        from api.personal_ingest_api import resolve_entity, store_new_entity, ExtractedEntity
        from api.quality_gates import filter_entities, get_accepted_entities

        # Convert request entities to dicts for quality gates
        entities_raw = [
            {"name": e.name, "type": e.type, "context": e.context, "confidence": e.confidence}
            for e in body.entities
        ]

        entities_created = 0
        entities_resolved = 0
        relationships_created = 0
        quality_stats = None

        async with pool.acquire() as conn:
            # Quality gates on ingest path (skip confidence for agent-curated entities)
            if entities_raw:
                report = await filter_entities(entities_raw, conn=conn, skip_confidence=True)
                entities_raw = get_accepted_entities(report)
                quality_stats = {
                    "total_input": report.total_input,
                    "accepted": report.accepted,
                    "rejected": report.rejected,
                    "rejected_by_stage": report.rejected_by_stage,
                }

            # Look up submission RID once (used for linking)
            submission = await conn.fetchrow(
                "SELECT rid FROM web_submissions WHERE url = $1 LIMIT 1",
                body.url,
            )

            # Resolve entities
            for ent in entities_raw:
                extracted = ExtractedEntity(
                    name=ent["name"],
                    type=ent.get("type", "Concept"),
                    confidence=ent.get("confidence") if ent.get("confidence") is not None else 0.9,
                )
                canonical, is_new = await resolve_entity(conn, extracted)
                entities_resolved += 1
                if is_new:
                    doc_rid = submission["rid"] if submission else body.url
                    await store_new_entity(conn, extracted, canonical, doc_rid, source="web_ingest")
                    entities_created += 1

                # Link document to entity
                if submission and canonical.uri:
                    await conn.execute("""
                        INSERT INTO document_entity_links (document_rid, entity_uri, context)
                        VALUES ($1, $2, $3)
                        ON CONFLICT (document_rid, entity_uri) DO NOTHING
                    """, submission["rid"], canonical.uri, ent.get("context", "web_ingest"))

            # Create relationships
            for rel in body.relationships:
                try:
                    await conn.execute("""
                        INSERT INTO entity_relationships (subject_uri, predicate, object_uri, source)
                        SELECT s.fuseki_uri, $3, o.fuseki_uri, 'web_ingest'
                        FROM entity_registry s, entity_registry o
                        WHERE s.normalized_text = lower(trim($1))
                        AND o.normalized_text = lower(trim($2))
                        ON CONFLICT DO NOTHING
                    """, rel.subject, rel.object, rel.predicate)
                    relationships_created += 1
                except Exception as e:
                    logger.warning(f"Failed to create relationship {rel}: {e}")

            # Update submission status
            await conn.execute("""
                UPDATE web_submissions SET
                    status = 'ingested',
                    ingested_entities = $2::jsonb,
                    ingested_at = NOW()
                WHERE url = $1
            """, body.url, _json_dumps([
                {"name": e["name"], "type": e.get("type")} for e in entities_raw
            ]))

        # CAT receipt for entity resolution
        async with pool.acquire() as conn:
            try:
                from api.cat_receipts import create_receipt
                parent = await conn.fetchrow(
                    "SELECT receipt_id FROM koi_transformation_receipts WHERE input_rid = $1 ORDER BY created_at DESC LIMIT 1",
                    body.url,
                )
                submission = await conn.fetchrow(
                    "SELECT rid FROM web_submissions WHERE url = $1 LIMIT 1", body.url,
                )
                await create_receipt(
                    conn,
                    transformation_type="entity_resolution",
                    input_rid=submission["rid"] if submission else body.url,
                    output_rid=f"{body.url}:ingested",
                    processor_name="koi_entity_resolver",
                    source_sensor="api",
                    parent_receipt_id=parent["receipt_id"] if parent else None,
                    metadata={
                        "entities_resolved": entities_resolved,
                        "entities_created": entities_created,
                        "relationships_created": relationships_created,
                    },
                )
            except Exception as e:
                logger.warning(f"CAT receipt creation failed (non-fatal): {e}")

        elapsed = (time.monotonic() - t0) * 1000
        logger.info(f"web.ingest url={body.url} resolved={entities_resolved} created={entities_created} elapsed_ms={elapsed:.0f}")

        return WebIngestResponse(
            url=body.url,
            status="ingested",
            entities_resolved=entities_resolved,
            entities_created=entities_created,
            relationships_created=relationships_created,
            quality_stats=quality_stats,
        )

    @router.get("/submissions")
    async def web_submissions(
        status: Optional[str] = Query(None),
        limit: int = Query(50, ge=1, le=200),
        offset: int = Query(0, ge=0),
    ):
        """List web content submissions and their processing status."""
        async with pool.acquire() as conn:
            if status:
                rows = await conn.fetch("""
                    SELECT url, rid, status, title, relevance_score, word_count,
                           submitted_by, submitted_via, created_at, fetched_at, evaluated_at, ingested_at
                    FROM web_submissions WHERE status = $1
                    ORDER BY created_at DESC LIMIT $2 OFFSET $3
                """, status, limit, offset)
            else:
                rows = await conn.fetch("""
                    SELECT url, rid, status, title, relevance_score, word_count,
                           submitted_by, submitted_via, created_at, fetched_at, evaluated_at, ingested_at
                    FROM web_submissions
                    ORDER BY created_at DESC LIMIT $1 OFFSET $2
                """, limit, offset)

        return [dict(r) for r in rows]

    @router.get("/monitor")
    async def web_monitor_status():
        """Return web sensor health and activity metrics."""
        pool_key = id(pool)
        if pool_key in _web_sensor_instances:
            status = await _web_sensor_instances[pool_key].get_status()
            return status
        return {
            "enabled": caps.web_sensor,
            "urls_monitored": 0,
            "urls_processed": 0,
            "last_scan_at": None,
        }

    @router.post("/monitor/add")
    async def web_monitor_add(body: WebMonitorAddRequest):
        """Add a URL to the monitoring list."""
        from api.web_sensor import WebSensor

        pool_key = id(pool)
        if pool_key not in _web_sensor_instances:
            _web_sensor_instances[pool_key] = WebSensor(pool)

        result = await _web_sensor_instances[pool_key].add_url(body.url, body.title)

        # CAT receipt for sensor registration
        async with pool.acquire() as conn:
            try:
                from api.cat_receipts import create_receipt
                from api.web_fetcher import generate_web_rid
                url_rid = generate_web_rid(body.url)
                await create_receipt(
                    conn,
                    transformation_type="sensor_registration",
                    input_rid=body.url,
                    output_rid=f"{url_rid}:monitor",
                    processor_name="web_sensor",
                    source_sensor="api",
                    metadata={"title": body.title, "action": "add"},
                )
            except Exception as e:
                logger.warning(f"CAT receipt creation failed (non-fatal): {e}")

        return result

    @router.post("/monitor/remove")
    async def web_monitor_remove(body: WebMonitorRemoveRequest):
        """Remove a URL from the monitoring list."""
        pool_key = id(pool)
        if pool_key not in _web_sensor_instances:
            raise HTTPException(status_code=404, detail="No web sensor active")

        result = await _web_sensor_instances[pool_key].remove_url(body.url)
        return result

    @router.get("/monitor/status")
    async def web_monitor_detailed_status():
        """Detailed monitoring status (alias for /monitor)."""
        return await web_monitor_status()

    @router.get("/health")
    async def web_health():
        """Web pipeline health: submission counts, error rates, monitoring stats."""
        async with pool.acquire() as conn:
            stats = await conn.fetchrow("""
                SELECT
                    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS submissions_24h,
                    COUNT(*) FILTER (WHERE status = 'error' AND created_at > NOW() - INTERVAL '24 hours') AS errors_24h,
                    COUNT(*) FILTER (WHERE status = 'monitoring') AS monitored,
                    COUNT(*) FILTER (WHERE status = 'previewed' AND evaluated_at IS NULL) AS pending_eval
                FROM web_submissions
            """)
        return {
            "status": "ok" if (stats["errors_24h"] or 0) < 5 else "degraded",
            "submissions_24h": stats["submissions_24h"],
            "errors_24h": stats["errors_24h"],
            "monitored_urls": stats["monitored"],
            "pending_evaluations": stats["pending_eval"],
        }

    @router.get("/provenance/{url:path}")
    async def web_provenance(url: str):
        """Get full CAT receipt chain for a URL."""
        from api.cat_receipts import get_receipts_for_url

        async with pool.acquire() as conn:
            # Collect all identifiers for this URL
            search_rids = {url}

            submission = await conn.fetchrow(
                "SELECT rid FROM web_submissions WHERE url = $1 LIMIT 1", url,
            )
            if submission:
                search_rids.add(submission["rid"])

            # Also look for derived RIDs (e.g., url:extraction, url:ingested)
            all_receipts = {}
            for rid in search_rids:
                for receipt in await get_receipts_for_url(conn, rid):
                    all_receipts[receipt.receipt_id] = receipt
                # Also search for derived output RIDs
                derived_rows = await conn.fetch(
                    "SELECT DISTINCT receipt_id, transformation_type, input_rid, output_rid, "
                    "parent_receipt_id, processor_name, source_sensor, metadata, content_hash, created_at "
                    "FROM koi_transformation_receipts WHERE input_rid LIKE $1 OR output_rid LIKE $1",
                    f"{rid}%",
                )
                for row in derived_rows:
                    import json as _json
                    r_id = row["receipt_id"]
                    if r_id not in all_receipts:
                        from api.cat_receipts import CATReceipt
                        all_receipts[r_id] = CATReceipt(
                            receipt_id=r_id,
                            transformation_type=row["transformation_type"],
                            input_rid=row["input_rid"],
                            output_rid=row["output_rid"],
                            parent_receipt_id=row["parent_receipt_id"],
                            processor_name=row["processor_name"],
                            source_sensor=row["source_sensor"],
                            metadata=_json.loads(row["metadata"]) if isinstance(row["metadata"], str) else (row["metadata"] or {}),
                            content_hash=row["content_hash"],
                            created_at=row["created_at"],
                        )

            receipts = sorted(all_receipts.values(), key=lambda r: r.created_at or datetime.min)

        if not receipts:
            raise HTTPException(status_code=404, detail=f"No provenance records for {url}")

        return {
            "url": url,
            "receipt_count": len(receipts),
            "receipts": [
                {
                    "receipt_id": r.receipt_id,
                    "transformation_type": r.transformation_type,
                    "input_rid": r.input_rid,
                    "output_rid": r.output_rid,
                    "parent_receipt_id": r.parent_receipt_id,
                    "processor_name": r.processor_name,
                    "source_sensor": r.source_sensor,
                    "metadata": r.metadata,
                    "content_hash": r.content_hash,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                }
                for r in receipts
            ],
        }

    return router


# -- Helpers -----------------------------------------------------------------

def _entity_to_dict(entity) -> Dict[str, Any]:
    """Convert a MatchingEntity to a dict."""
    if isinstance(entity, dict):
        return entity
    return {
        "name": getattr(entity, "name", getattr(entity, "entity_text", "")),
        "type": getattr(entity, "type", getattr(entity, "entity_type", "")),
        "uri": getattr(entity, "uri", getattr(entity, "fuseki_uri", "")),
        "similarity": getattr(entity, "similarity", None),
    }


def _serialize_matching_entities(entities) -> str:
    """Serialize matching entities to JSON string."""
    import json
    if not entities:
        return "[]"
    return json.dumps([_entity_to_dict(e) for e in entities])


def _json_dumps(obj) -> str:
    """JSON serialize helper."""
    import json
    return json.dumps(obj)
