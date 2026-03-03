"""Commitment pooling endpoints: pledge lifecycle, pool management, evidence linking.

Implements the C0 commitment registry API:
  POST /commitments/create       — propose a new commitment pledge
  GET  /commitments/{rid}        — fetch commitment by RID
  PATCH /commitments/{rid}/state — transition state (steward action)
  POST /commitments/{rid}/link-evidence — attach Evidence entity
  GET  /commitments/             — list commitments (filterable)
  POST /pools/create             — create a new commitment pool
  GET  /pools/{rid}              — fetch pool by RID
  POST /pools/{rid}/pledge       — add an existing commitment to a pool
  GET  /pools/{rid}/status       — pool status + pledge summary

All state transitions are recorded in commitment_state_log (insert-only).
"""

import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class CommitmentCreateRequest(BaseModel):
    pledger_uri: str = Field(..., description="entity_registry.fuseki_uri of the pledger")
    title: str = Field(..., min_length=3, max_length=200)
    description: Optional[str] = None
    offer_type: str = Field("labor", description="labor | goods | service | knowledge | stewardship")
    quantity: Optional[float] = None
    unit: Optional[str] = None
    validity_start: Optional[datetime] = None
    validity_end: Optional[datetime] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)
    created_by: Optional[str] = None


class CommitmentResponse(BaseModel):
    commitment_rid: str
    pledger_uri: str
    pool_rid: Optional[str]
    title: str
    description: Optional[str]
    offer_type: str
    quantity: Optional[float]
    unit: Optional[str]
    validity_start: Optional[datetime]
    validity_end: Optional[datetime]
    state: str
    evidence_uri: Optional[str]
    metadata: Dict[str, Any]
    created_at: datetime
    updated_at: datetime


class StateTransitionRequest(BaseModel):
    new_state: str = Field(..., description="Target state: VERIFIED | ACTIVE | REJECTED | WITHDRAWN | EVIDENCE_LINKED | REDEEMED | DISPUTED | RESOLVED")
    actor: Optional[str] = None
    reason: Optional[str] = None


class EvidenceLinkRequest(BaseModel):
    evidence_uri: str = Field(..., description="entity_registry.fuseki_uri of the Evidence entity")
    actor: Optional[str] = None


class PoolCreateRequest(BaseModel):
    name: str = Field(..., min_length=3, max_length=200)
    description: Optional[str] = None
    steward_uri: Optional[str] = None
    bioregion_uri: Optional[str] = None
    activation_threshold_pct: float = Field(80.0, ge=0.0, le=100.0)
    activation_threshold_count: Optional[int] = None
    demurrage_rate_monthly: float = Field(0.0, ge=0.0)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    created_by: Optional[str] = None


class PoolResponse(BaseModel):
    pool_rid: str
    name: str
    description: Optional[str]
    steward_uri: Optional[str]
    bioregion_uri: Optional[str]
    activation_threshold_pct: float
    activation_threshold_count: Optional[int]
    demurrage_rate_monthly: float
    state: str
    metadata: Dict[str, Any]
    created_at: datetime
    updated_at: datetime


class PledgeToPoolRequest(BaseModel):
    commitment_rid: str
    actor: Optional[str] = None


# ---------------------------------------------------------------------------
# Valid state transitions
# ---------------------------------------------------------------------------

_VALID_TRANSITIONS = {
    "PROPOSED":        {"VERIFIED", "REJECTED", "WITHDRAWN"},
    "VERIFIED":        {"ACTIVE", "WITHDRAWN"},
    "ACTIVE":          {"EVIDENCE_LINKED", "WITHDRAWN", "DISPUTED"},
    "EVIDENCE_LINKED": {"REDEEMED", "DISPUTED"},
    "REDEEMED":        set(),
    "REJECTED":        set(),
    "WITHDRAWN":       set(),
    "DISPUTED":        {"RESOLVED"},
    "RESOLVED":        set(),
}


def _commitment_rid(pledger_uri: str, title: str) -> str:
    """Deterministic RID for a commitment pledge."""
    h = hashlib.sha256(f"commitment:{pledger_uri}:{title}".encode()).hexdigest()[:32]
    return f"orn:koi-net.commitment:{h}"


def _pool_rid(name: str, steward_uri: str = "") -> str:
    """Deterministic RID for a commitment pool."""
    h = hashlib.sha256(f"pool:{name}:{steward_uri}".encode()).hexdigest()[:32]
    return f"orn:koi-net.commitment-pool:{h}"


# ---------------------------------------------------------------------------
# Router factory
# ---------------------------------------------------------------------------

def create_router(pool, caps=None):
    """Return an APIRouter for commitment pooling endpoints."""
    router = APIRouter(prefix="/commitments", tags=["commitments"])

    # ------------------------------------------------------------------ #
    # Commitment CRUD                                                       #
    # ------------------------------------------------------------------ #

    @router.post("/create", response_model=CommitmentResponse, status_code=201)
    async def create_commitment(body: CommitmentCreateRequest):
        """Propose a new commitment pledge. Initial state: PROPOSED."""
        rid = _commitment_rid(body.pledger_uri, body.title)
        async with pool.acquire() as conn:
            # Verify pledger exists
            pledger = await conn.fetchrow(
                "SELECT fuseki_uri FROM entity_registry WHERE fuseki_uri = $1",
                body.pledger_uri,
            )
            if not pledger:
                raise HTTPException(status_code=404, detail=f"Pledger entity not found: {body.pledger_uri}")

            # Upsert commitment (idempotent by RID)
            row = await conn.fetchrow("""
                INSERT INTO commitments
                    (commitment_rid, pledger_uri, title, description, offer_type,
                     quantity, unit, validity_start, validity_end, state, metadata, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PROPOSED',$10::jsonb,$11)
                ON CONFLICT (commitment_rid) DO UPDATE SET
                    updated_at = NOW()
                RETURNING *
            """,
                rid,
                body.pledger_uri,
                body.title,
                body.description,
                body.offer_type,
                body.quantity,
                body.unit,
                body.validity_start,
                body.validity_end,
                _json_dumps(body.metadata),
                body.created_by,
            )

            # Log initial state
            await conn.execute("""
                INSERT INTO commitment_state_log
                    (commitment_rid, from_state, to_state, actor, reason)
                VALUES ($1, NULL, 'PROPOSED', $2, 'created')
                ON CONFLICT DO NOTHING
            """, rid, body.created_by)

            # Write pledges_commitment relationship
            try:
                await conn.execute("""
                    INSERT INTO entity_relationships (subject_uri, predicate, object_uri, source)
                    VALUES ($1, 'pledges_commitment', $2, 'commitment_registry')
                    ON CONFLICT DO NOTHING
                """, body.pledger_uri, rid)
            except Exception as e:
                logger.warning(f"Failed to create pledges_commitment relationship: {e}")

        logger.info(f"commitment.create rid={rid} pledger={body.pledger_uri}")
        return _row_to_commitment(row)

    @router.get("/", response_model=List[CommitmentResponse])
    async def list_commitments(
        state: Optional[str] = Query(None, description="Filter by state"),
        pledger_uri: Optional[str] = Query(None),
        pool_rid: Optional[str] = Query(None),
        limit: int = Query(50, ge=1, le=200),
        offset: int = Query(0, ge=0),
    ):
        """List commitments with optional filters."""
        async with pool.acquire() as conn:
            conditions = []
            params = []
            i = 1
            if state:
                conditions.append(f"state = ${i}::commitment_state")
                params.append(state.upper())
                i += 1
            if pledger_uri:
                conditions.append(f"pledger_uri = ${i}")
                params.append(pledger_uri)
                i += 1
            if pool_rid:
                conditions.append(f"pool_id = (SELECT id FROM commitment_pools WHERE pool_rid = ${i})")
                params.append(pool_rid)
                i += 1

            where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
            params.extend([limit, offset])
            rows = await conn.fetch(f"""
                SELECT c.*, cp.pool_rid AS pool_rid_text
                FROM commitments c
                LEFT JOIN commitment_pools cp ON cp.id = c.pool_id
                {where}
                ORDER BY c.created_at DESC
                LIMIT ${i} OFFSET ${i+1}
            """, *params)

        return [_row_to_commitment(r) for r in rows]

    @router.get("/{rid}", response_model=CommitmentResponse)
    async def get_commitment(rid: str):
        """Fetch a commitment by RID."""
        async with pool.acquire() as conn:
            row = await conn.fetchrow("""
                SELECT c.*, cp.pool_rid AS pool_rid_text
                FROM commitments c
                LEFT JOIN commitment_pools cp ON cp.id = c.pool_id
                WHERE c.commitment_rid = $1
            """, rid)
        if not row:
            raise HTTPException(status_code=404, detail=f"Commitment not found: {rid}")
        return _row_to_commitment(row)

    @router.patch("/{rid}/state", response_model=CommitmentResponse)
    async def transition_state(rid: str, body: StateTransitionRequest):
        """Steward-controlled state transition. Validates against the state machine."""
        new_state = body.new_state.upper()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM commitments WHERE commitment_rid = $1", rid
            )
            if not row:
                raise HTTPException(status_code=404, detail=f"Commitment not found: {rid}")

            current_state = row["state"]
            allowed = _VALID_TRANSITIONS.get(current_state, set())
            if new_state not in allowed:
                raise HTTPException(
                    status_code=409,
                    detail=f"Invalid transition {current_state} → {new_state}. Allowed: {sorted(allowed) or 'none (terminal state)'}",
                )

            updated = await conn.fetchrow("""
                UPDATE commitments
                SET state = $2::commitment_state, updated_at = NOW()
                WHERE commitment_rid = $1
                RETURNING *
            """, rid, new_state)

            await conn.execute("""
                INSERT INTO commitment_state_log
                    (commitment_rid, from_state, to_state, actor, reason)
                VALUES ($1, $2::commitment_state, $3::commitment_state, $4, $5)
            """, rid, current_state, new_state, body.actor, body.reason)

        logger.info(f"commitment.state_transition rid={rid} {current_state}→{new_state} actor={body.actor}")
        return _row_to_commitment(updated)

    @router.post("/{rid}/link-evidence", response_model=CommitmentResponse)
    async def link_evidence(rid: str, body: EvidenceLinkRequest):
        """Attach an Evidence entity to a commitment and transition to EVIDENCE_LINKED."""
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM commitments WHERE commitment_rid = $1", rid
            )
            if not row:
                raise HTTPException(status_code=404, detail=f"Commitment not found: {rid}")

            if row["state"] not in ("ACTIVE", "EVIDENCE_LINKED"):
                raise HTTPException(
                    status_code=409,
                    detail=f"Cannot link evidence in state {row['state']}. Commitment must be ACTIVE or EVIDENCE_LINKED.",
                )

            # Verify evidence entity exists
            evidence = await conn.fetchrow(
                "SELECT fuseki_uri FROM entity_registry WHERE fuseki_uri = $1",
                body.evidence_uri,
            )
            if not evidence:
                raise HTTPException(status_code=404, detail=f"Evidence entity not found: {body.evidence_uri}")

            updated = await conn.fetchrow("""
                UPDATE commitments
                SET evidence_uri = $2, state = 'EVIDENCE_LINKED'::commitment_state, updated_at = NOW()
                WHERE commitment_rid = $1
                RETURNING *
            """, rid, body.evidence_uri)

            await conn.execute("""
                INSERT INTO commitment_state_log
                    (commitment_rid, from_state, to_state, actor, reason)
                VALUES ($1, $2::commitment_state, 'EVIDENCE_LINKED', $3, 'evidence linked')
            """, rid, row["state"], body.actor)

            # Insert proves_commitment relationship into entity_relationships
            try:
                await conn.execute("""
                    INSERT INTO entity_relationships (subject_uri, predicate, object_uri, source)
                    VALUES ($1, 'proves_commitment', $2, 'commitment_registry')
                    ON CONFLICT DO NOTHING
                """, body.evidence_uri, rid)
            except Exception as e:
                logger.warning(f"Failed to create proves_commitment relationship: {e}")

        logger.info(f"commitment.link_evidence rid={rid} evidence={body.evidence_uri}")
        return _row_to_commitment(updated)

    return router


# ---------------------------------------------------------------------------
# Pool sub-router (separate prefix)
# ---------------------------------------------------------------------------

def create_pool_router(pool, caps=None):
    """Return an APIRouter for CommitmentPool endpoints."""
    router = APIRouter(prefix="/pools", tags=["commitment-pools"])

    @router.post("/create", response_model=PoolResponse, status_code=201)
    async def create_pool(body: PoolCreateRequest):
        """Create a new commitment pool."""
        rid = _pool_rid(body.name, body.steward_uri or "")
        async with pool.acquire() as conn:
            row = await conn.fetchrow("""
                INSERT INTO commitment_pools
                    (pool_rid, name, description, steward_uri, bioregion_uri,
                     activation_threshold_pct, activation_threshold_count,
                     demurrage_rate_monthly, state, metadata, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'forming',$9::jsonb,$10)
                ON CONFLICT (pool_rid) DO UPDATE SET updated_at = NOW()
                RETURNING *
            """,
                rid, body.name, body.description, body.steward_uri, body.bioregion_uri,
                body.activation_threshold_pct, body.activation_threshold_count,
                body.demurrage_rate_monthly, _json_dumps(body.metadata), body.created_by,
            )

            await conn.execute("""
                INSERT INTO commitment_pool_events (pool_rid, event_type, actor)
                VALUES ($1, 'created', $2)
            """, rid, body.created_by)

            # Write governs_pool relationship
            if body.steward_uri:
                try:
                    await conn.execute("""
                        INSERT INTO entity_relationships (subject_uri, predicate, object_uri, source)
                        VALUES ($1, 'governs_pool', $2, 'commitment_registry')
                        ON CONFLICT DO NOTHING
                    """, body.steward_uri, rid)
                except Exception as e:
                    logger.warning(f"Failed to create governs_pool relationship: {e}")

        logger.info(f"pool.create rid={rid} name={body.name}")
        return _row_to_pool(row)

    @router.get("/{rid}", response_model=PoolResponse)
    async def get_pool(rid: str):
        """Fetch a pool by RID."""
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM commitment_pools WHERE pool_rid = $1", rid
            )
        if not row:
            raise HTTPException(status_code=404, detail=f"Pool not found: {rid}")
        return _row_to_pool(row)

    @router.post("/{rid}/pledge", response_model=Dict[str, Any])
    async def add_pledge_to_pool(rid: str, body: PledgeToPoolRequest):
        """Add an existing VERIFIED or PROPOSED commitment to this pool."""
        async with pool.acquire() as conn:
            pool_row = await conn.fetchrow(
                "SELECT id, state FROM commitment_pools WHERE pool_rid = $1", rid
            )
            if not pool_row:
                raise HTTPException(status_code=404, detail=f"Pool not found: {rid}")
            if pool_row["state"] not in ("forming", "active"):
                raise HTTPException(status_code=409, detail=f"Pool is {pool_row['state']}; cannot add pledges.")

            commitment = await conn.fetchrow(
                "SELECT id, state FROM commitments WHERE commitment_rid = $1",
                body.commitment_rid,
            )
            if not commitment:
                raise HTTPException(status_code=404, detail=f"Commitment not found: {body.commitment_rid}")

            await conn.execute("""
                UPDATE commitments SET pool_id = $1, updated_at = NOW()
                WHERE commitment_rid = $2
            """, pool_row["id"], body.commitment_rid)

            await conn.execute("""
                INSERT INTO commitment_pool_events (pool_rid, event_type, actor, payload)
                VALUES ($1, 'pledge_added', $2, $3::jsonb)
            """, rid, body.actor, _json_dumps({"commitment_rid": body.commitment_rid}))

            # Write aggregates_commitments relationship
            try:
                await conn.execute("""
                    INSERT INTO entity_relationships (subject_uri, predicate, object_uri, source)
                    VALUES ($1, 'aggregates_commitments', $2, 'commitment_registry')
                    ON CONFLICT DO NOTHING
                """, rid, body.commitment_rid)
            except Exception as e:
                logger.warning(f"Failed to create aggregates_commitments relationship: {e}")

            # Check if threshold is now met and auto-activate
            total = await conn.fetchval(
                "SELECT COUNT(*) FROM commitments WHERE pool_id = $1", pool_row["id"]
            )
            verified = await conn.fetchval(
                "SELECT COUNT(*) FROM commitments WHERE pool_id = $1 AND state IN ('VERIFIED','ACTIVE','EVIDENCE_LINKED','REDEEMED')",
                pool_row["id"],
            )
            pool_full = await conn.fetchrow(
                "SELECT * FROM commitment_pools WHERE pool_rid = $1", rid
            )
            threshold_met = _check_threshold(pool_full, int(total), int(verified))
            activated = False
            if threshold_met and pool_full["state"] == "forming":
                await conn.execute(
                    "UPDATE commitment_pools SET state = 'active', updated_at = NOW() WHERE pool_rid = $1",
                    rid,
                )
                await conn.execute("""
                    INSERT INTO commitment_pool_events (pool_rid, event_type, actor, payload)
                    VALUES ($1, 'activated', 'system', $2::jsonb)
                """, rid, _json_dumps({"total": total, "verified": verified}))
                activated = True
                logger.info(f"pool.activated rid={rid} total={total} verified={verified}")

        return {
            "pool_rid": rid,
            "commitment_rid": body.commitment_rid,
            "pool_activated": activated,
            "total_pledges": int(total),
            "verified_pledges": int(verified),
        }

    @router.get("/{rid}/status")
    async def pool_status(rid: str):
        """Pool summary: state, pledge counts by state, threshold progress."""
        async with pool.acquire() as conn:
            pool_row = await conn.fetchrow(
                "SELECT * FROM commitment_pools WHERE pool_rid = $1", rid
            )
            if not pool_row:
                raise HTTPException(status_code=404, detail=f"Pool not found: {rid}")

            counts = await conn.fetch("""
                SELECT state::text, COUNT(*) AS n
                FROM commitments WHERE pool_id = $1
                GROUP BY state
            """, pool_row["id"])

        state_counts = {r["state"]: int(r["n"]) for r in counts}
        total = sum(state_counts.values())
        verified_states = {"VERIFIED", "ACTIVE", "EVIDENCE_LINKED", "REDEEMED"}
        verified = sum(state_counts.get(s, 0) for s in verified_states)
        pct = round(verified / total * 100, 1) if total else 0.0

        return {
            "pool_rid": rid,
            "pool_state": pool_row["state"],
            "name": pool_row["name"],
            "total_pledges": total,
            "verified_pledges": verified,
            "threshold_pct_required": float(pool_row["activation_threshold_pct"]),
            "threshold_pct_current": pct,
            "threshold_met": pct >= float(pool_row["activation_threshold_pct"]),
            "pledge_counts_by_state": state_counts,
            "demurrage_rate_monthly": float(pool_row["demurrage_rate_monthly"]),
        }

    return router


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _check_threshold(pool_row, total: int, verified: int) -> bool:
    if total == 0:
        return False
    if pool_row["activation_threshold_count"] is not None:
        return verified >= pool_row["activation_threshold_count"]
    return (verified / total * 100) >= float(pool_row["activation_threshold_pct"])


def _row_to_commitment(row) -> CommitmentResponse:
    import json as _json
    meta = row["metadata"]
    if isinstance(meta, str):
        meta = _json.loads(meta)
    return CommitmentResponse(
        commitment_rid=row["commitment_rid"],
        pledger_uri=row["pledger_uri"],
        pool_rid=row.get("pool_rid_text") or row.get("pool_rid"),
        title=row["title"],
        description=row.get("description"),
        offer_type=row["offer_type"],
        quantity=float(row["quantity"]) if row.get("quantity") is not None else None,
        unit=row.get("unit"),
        validity_start=row.get("validity_start"),
        validity_end=row.get("validity_end"),
        state=row["state"],
        evidence_uri=row.get("evidence_uri"),
        metadata=meta or {},
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _row_to_pool(row) -> PoolResponse:
    import json as _json
    meta = row["metadata"]
    if isinstance(meta, str):
        meta = _json.loads(meta)
    return PoolResponse(
        pool_rid=row["pool_rid"],
        name=row["name"],
        description=row.get("description"),
        steward_uri=row.get("steward_uri"),
        bioregion_uri=row.get("bioregion_uri"),
        activation_threshold_pct=float(row["activation_threshold_pct"]),
        activation_threshold_count=row.get("activation_threshold_count"),
        demurrage_rate_monthly=float(row["demurrage_rate_monthly"]),
        state=row["state"],
        metadata=meta or {},
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _json_dumps(obj) -> str:
    import json
    return json.dumps(obj)
