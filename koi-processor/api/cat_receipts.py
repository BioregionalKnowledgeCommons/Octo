"""CAT (Content Addressable Transformation) receipt chain for provenance tracking.

Records every transformation in the web curation pipeline:
- web_fetch: URL fetched and content extracted
- llm_extraction: LLM extracted entities/relationships from content
- entity_resolution: Entities resolved against knowledge graph
- sensor_registration: URL added to web sensor monitoring
- user_submission: User-submitted information (no web source)

Receipt IDs are SHA-256 hashes of (transformation_type + input_rid + output_rid + timestamp).
Parent receipt IDs form a chain showing the full provenance path.
"""

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class CATReceipt:
    """A single transformation receipt."""
    receipt_id: str
    transformation_type: str
    input_rid: str
    output_rid: str
    parent_receipt_id: Optional[str] = None
    processor_name: str = ""
    source_sensor: str = "unknown"
    metadata: Dict[str, Any] = field(default_factory=dict)
    content_hash: Optional[str] = None
    created_at: Optional[datetime] = None


def generate_receipt_id(
    transformation_type: str,
    input_rid: str,
    output_rid: str,
    timestamp: Optional[str] = None,
) -> str:
    """Generate a deterministic receipt ID from transformation parameters."""
    ts = timestamp or datetime.now(timezone.utc).isoformat()
    payload = f"{transformation_type}:{input_rid}:{output_rid}:{ts}"
    return hashlib.sha256(payload.encode()).hexdigest()


async def create_receipt(
    conn,
    transformation_type: str,
    input_rid: str,
    output_rid: str,
    processor_name: str,
    source_sensor: str = "unknown",
    parent_receipt_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    content_hash: Optional[str] = None,
) -> CATReceipt:
    """Create and persist a new CAT receipt.

    Args:
        conn: Database connection
        transformation_type: One of web_fetch, llm_extraction, entity_resolution,
                            sensor_registration, user_submission
        input_rid: RID of the input (e.g., URL RID, document RID)
        output_rid: RID of the output (e.g., extraction result, entity URI)
        processor_name: Name of the processor (e.g., "web_fetcher", "gemini", "koi_entity_resolver")
        source_sensor: Source sensor type (e.g., "web", "telegram", "api")
        parent_receipt_id: ID of the parent receipt in the chain
        metadata: Additional metadata (JSONB)
        content_hash: SHA-256 of content at this stage

    Returns:
        The created CATReceipt
    """
    receipt_id = generate_receipt_id(transformation_type, input_rid, output_rid)

    try:
        await conn.execute("""
            INSERT INTO koi_transformation_receipts
                (receipt_id, transformation_type, input_rid, output_rid,
                 parent_receipt_id, processor_name, source_sensor,
                 metadata, content_hash)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
            ON CONFLICT (receipt_id) DO NOTHING
        """,
            receipt_id,
            transformation_type,
            input_rid,
            output_rid,
            parent_receipt_id,
            processor_name,
            source_sensor,
            json.dumps(metadata or {}),
            content_hash,
        )
    except Exception as e:
        logger.error(f"Failed to create CAT receipt: {e}")
        # Non-fatal — don't break the pipeline for provenance failures
        return CATReceipt(
            receipt_id=receipt_id,
            transformation_type=transformation_type,
            input_rid=input_rid,
            output_rid=output_rid,
            parent_receipt_id=parent_receipt_id,
            processor_name=processor_name,
            source_sensor=source_sensor,
            metadata=metadata or {},
            content_hash=content_hash,
        )

    logger.info(f"CAT receipt created: {transformation_type} [{input_rid} → {output_rid}]")

    return CATReceipt(
        receipt_id=receipt_id,
        transformation_type=transformation_type,
        input_rid=input_rid,
        output_rid=output_rid,
        parent_receipt_id=parent_receipt_id,
        processor_name=processor_name,
        source_sensor=source_sensor,
        metadata=metadata or {},
        content_hash=content_hash,
    )


async def get_receipt_chain(conn, receipt_id: str) -> List[CATReceipt]:
    """Walk the parent chain from a receipt back to the root.

    Returns receipts in reverse chronological order (most recent first).
    """
    chain = []
    current_id = receipt_id
    seen = set()

    while current_id and current_id not in seen:
        seen.add(current_id)
        row = await conn.fetchrow(
            "SELECT * FROM koi_transformation_receipts WHERE receipt_id = $1",
            current_id,
        )
        if not row:
            break
        chain.append(CATReceipt(
            receipt_id=row["receipt_id"],
            transformation_type=row["transformation_type"],
            input_rid=row["input_rid"],
            output_rid=row["output_rid"],
            parent_receipt_id=row["parent_receipt_id"],
            processor_name=row["processor_name"],
            source_sensor=row["source_sensor"],
            metadata=json.loads(row["metadata"]) if isinstance(row["metadata"], str) else (row["metadata"] or {}),
            content_hash=row["content_hash"],
            created_at=row["created_at"],
        ))
        current_id = row["parent_receipt_id"]

    return chain


async def get_receipts_for_url(conn, url_rid: str) -> List[CATReceipt]:
    """Get all receipts where the URL RID appears as input or output."""
    rows = await conn.fetch("""
        SELECT * FROM koi_transformation_receipts
        WHERE input_rid = $1 OR output_rid = $1
        ORDER BY created_at ASC
    """, url_rid)

    return [
        CATReceipt(
            receipt_id=row["receipt_id"],
            transformation_type=row["transformation_type"],
            input_rid=row["input_rid"],
            output_rid=row["output_rid"],
            parent_receipt_id=row["parent_receipt_id"],
            processor_name=row["processor_name"],
            source_sensor=row["source_sensor"],
            metadata=json.loads(row["metadata"]) if isinstance(row["metadata"], str) else (row["metadata"] or {}),
            content_hash=row["content_hash"],
            created_at=row["created_at"],
        )
        for row in rows
    ]
