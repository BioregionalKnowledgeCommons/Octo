# Interview Commoning MVP

## Purpose

This MVP turns local interviews into reviewed `Practice`, `Pattern`, and `Protocol` artifacts, then publishes only approved derived artifacts into the shared KOI graph.

## Scope

Implemented in this repo as:

- local OpenClaw plugin: `plugins/interview-commoning/`
- local workflow folders under `workspace/interviews/`
- protocol library staging folder under `workspace/protocol-library/`
- Front Range workspace/vault parity scaffolding under `fr-agent/`

## Tool Surface

The plugin exposes these node-local tools:

- `interview_intake_create`
- `interview_turn_append`
- `interview_transcript_import`
- `interview_session_finalize`
- `interview_list_artifacts`
- `interview_read_artifact`
- `interview_review_packet`
- `interview_publish_approved`

These are intentionally local workflow tools, not part of the shared 15-tool KOI contract.

## Workflow

### 1. Create intake

Create an intake record with title, bioregion, source mode, consent tier, and steward.

### 2. Capture source material

Use either:

- `interview_turn_append` for chat-mode capture
- `interview_transcript_import` for a reviewed transcript

### 3. Finalize and extract

`interview_session_finalize` normalizes the transcript and uses OpenAI extraction to create:

- `PracticePacket`
- `PatternCandidatePacket`
- `ProtocolCandidatePacket`
- review summary markdown
- transcript package and extraction bundle JSON

### 4. Review

Use `interview_review_packet` to mark packets as:

- `approved_local`
- `approved_shared`
- `needs_revision`
- `rejected`

Recommended defaults:

- practices remain `local_only` unless a redacted summary is explicitly approved
- patterns and protocols use `federated_derived` only after review

### 5. Publish

`interview_publish_approved` publishes approved shared artifacts by:

- writing graph entities via `/ingest`
- creating local vault notes for new shared artifacts when safe to do so
- registering those notes via `/register-entity`
- writing a publication manifest under `workspace/interviews/publication/`

## Sharing Policy in v0.1

Default policy:

- interviews stay local
- practices stay local
- patterns and protocols can be shared after review
- case studies can be published as redacted summaries when a practice packet is marked `shared_summary`

This creates a federated derived-artifact layer without assuming raw interview material should cross boundaries.

## Artifact Layout

### Workspace

- `workspace/interviews/intake/`
- `workspace/interviews/transcripts/`
- `workspace/interviews/review/`
- `workspace/interviews/publication/`
- `workspace/protocol-library/`

### Front Range parity

- `fr-agent/workspace/interviews/`
- `fr-agent/workspace/protocol-library/`
- `fr-agent/vault/Patterns/`
- `fr-agent/vault/Protocols/`
- `fr-agent/vault/CaseStudies/`
- `fr-agent/vault/Questions/`
- `fr-agent/vault/Claims/`
- `fr-agent/vault/Evidence/`

## Federation

Peer connect defaults now include `Protocol` artifacts, so approved protocols can federate along with practices, patterns, and case studies.

## Current Constraints

- extraction requires `OPENAI_API_KEY`
- transcript import currently expects reviewed text, not direct audio transcription
- existing notes are not overwritten during publication; the plugin skips them and emits a warning
- deeper access negotiation for local practice detail is still manual
