# LUMI_APP_PRODUCTION_READINESS_REPORT_V1

Generated: 2026-10-04

## Result

`LUMI APP — PRODUCTION READINESS BLOCKER PRESERVED`

The operational recovery implementation is complete and locally validated. Controlled production readiness is blocked only at the publication boundary: the isolated branch could not be pushed because the execution security control did not verify the GitHub destination. CI and staging deployment therefore remain pending. No provider call, production change, global activation, or master mutation occurred.

| Field | Status |
|---|---|
| APPROVED_PILOTS | `Lumi y los cinco huevos perdidos` APPROVED; `Lumi y el jardín de las formas` HUMAN_APPROVED |
| PRESET_VERSION | `1.1.2` HUMAN_VALIDATED, frozen baseline |
| RECOVERY_MANAGER_STATUS | IMPLEMENTED_LOCAL |
| TELEGRAM_INTEGRATION_STATUS | IMPLEMENTED_AND_DRY_TESTED; single existing message edited |
| EXACTLY_ONCE_STATUS | PASS_LOCAL; request ID preserved and recovered without duplicate |
| ARTIFACT_VALIDATION_STATUS | PASS_LOCAL for image/video/audio/master contracts |
| BUDGET_GATE_STATUS | PASS_LOCAL; blocks before provider and reports shortfall |
| TTS_STORAGE_GATE_STATUS | PASS_LOCAL; upload/download/hash/decode/cleanup required before TTS |
| LOCAL_SALVAGE_STATUS | FORMALIZED; deterministic repair preferred; generative repair limited to fatal defects |
| CI | NOT_STARTED_REMOTE_PUSH_BLOCKED |
| STAGING | NOT_DEPLOYED |
| PRODUCTION_IMPACT | NONE; `main@5fe5556` unchanged; default `legacy`; runners OFF |
| OPEN_BLOCKERS | Verify/authorize remote push, obtain GREEN CI, deploy staging, execute authenticated 0-provider dry endpoint |

## Approved second master

- File: `LUMI_SHORT_JARDIN_FORMAS_V1.mp4`
- SHA-256: `d112b2de82bd6741aeaa71182176d664649406ee0b5b7904fc2f95e10ece5183`
- Human Review: `APPROVED`
- Cost: `USD 4.156622`
- Video: 1080x1920, H.264 High, CRF 17, preset slow, yuv420p
- Audio: AAC stereo, 48 kHz
- Duration: 50.178 s
- Decode/black/freeze defects: 0/0/0

## Implementation evidence

- Isolated branch: `lumi-app-recovery-manager-v1`
- Local commit: `346717a151c2cb9373e39d8da006036dd57523ed`
- Focused tests: `16/16 PASS`
- Repository regression: `200/201 PASS`; only the pre-existing missing external visual benchmark fixture failed.
- Phase provider calls: `0`
- Candidate autorun: `false`
- Candidate runners: `OFF`
- Default feature selection: `LUMI_PIPELINE_VERSION=legacy`

## Recovery guarantees

A provider-backed action becomes complete only after provider success, artifact persistence, SHA verification, and artifact decode/read verification. Resume always inspects persistent state and any existing request before continuing. A request with ambiguous dispatch state and no durable request ID fails closed. Storage failure after synthesis recovers existing bytes first and never resynthesizes automatically. Cancellation stops future calls but preserves artifacts, ledger, costs, and history.

## Required next controlled step

Verify the authorized repository destination for this runtime, push the isolated branch, require GREEN CI, deploy only staging with runners OFF and autorun false, then invoke the authenticated zero-provider dry-run endpoint. Production and the global default must remain unchanged.

