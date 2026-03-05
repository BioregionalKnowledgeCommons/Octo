# Membrane Governance Deploy — 2026-03-05

## SHAs
- **koi-processor** (`regen-prod`): `e47fbaf446b64160c369110a5382a8f32bff7641`
- **Octo** (`main`): `4c07157`
- **Vendor pin**: `e47fbaf4`

## Migration 061: edge_status_index
Applied to all 3 nodes:
- **octo_koi**: 2026-03-05 08:01:28 UTC
- **fr_koi**: 2026-03-05 08:00:16 UTC
- **gv_koi**: 2026-03-05 08:00:52 UTC
- **Checksum**: `caeb0efbb547f14f425361674abb5328377e9506a85964c0796eb63c1280cd47`
- **Index verified** on all 3 nodes: `idx_koi_net_edges_status`

## Phase 0 Config (coordinator only)
```
KOI_NET_REQUIRE_APPROVED_EDGE_FOR_POLL=true   # was already set
KOI_NET_DEFER_UNKNOWN_HANDSHAKE=true           # added this deploy
```
Admin token generated at `/root/koi-state/admin_token` (chmod 600).

## Preflight
All 18 active peers have public keys (no "NO KEY" entries).

## Federation Test
```
PASSED: Federation test successful!
  GV practice -> event -> Octo cross-reference
```
Existing nodes (FR, GV, CV) unaffected — APPROVED edges preserved.

## What's Live
- All KOI-net data endpoints (poll, fetch, broadcast, confirm) gated by edge approval
- Unknown handshakes create PROPOSED edges (not auto-APPROVED)
- `POST /koi-net/edges/reject` endpoint available
- `GET /koi-net/edges?status=` filter for admin
- `admin-edges.sh` CLI on coordinator

## Known Issues
- Pre-existing: `/entity-search` returns 200 on non-BKC profiles (contract test `test_bkc_endpoints_disabled_on_personal` — unrelated to membrane work)
