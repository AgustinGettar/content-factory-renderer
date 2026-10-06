# Lumi V2 — real executor inventory

13/14 executable component wrappers; live pipeline binding remains BLOCKED. This is not production acceptance.

| Stage | Existing executor/location | Classification | Binding scope |
|---|---|---|---|
| PLANNING | acceptEpisodeGeneration; lib/av2/creative-engine.js | READY_TO_BIND | REAL_EXECUTOR_BOUND |
| SOURCE_PLANNING | adaptEpisodeToLegacy; lib/av2/compat.js | READY_TO_BIND | REAL_EXECUTOR_BOUND |
| IMAGE | imageInput + submitSeriesProviderRequest; lib/lumi-series-v2-continuation.js; lib/lumi-series-v2-execution.js | ADAPTER_SHIM_REQUIRED | REAL_EXECUTOR_BOUND |
| SOURCE_QA | sourceGate; lib/lumi-series-v2-gates.js | READY_TO_BIND | REAL_EXECUTOR_BOUND |
| DIRECTOR | compileDirectorPacket via compileGenericV2Direction; lib/cinematic-director-v1/director.js | READY_TO_BIND | REAL_EXECUTOR_BOUND |
| VIDEO | submitSeriesProviderRequest; lib/lumi-series-v2-execution.js | ADAPTER_SHIM_REQUIRED | REAL_EXECUTOR_BOUND |
| TEMPORAL_QA | verifyArtifact + evaluateTemporalTopology; lib/lumi-recovery-incident-manager-v1.js; lib/cinematic-director-v1/temporal-topology-qa-v2.js | READY_TO_BIND | REAL_EXECUTOR_BOUND |
| SHOT_REVIEW | artifactReview; lib/telegram-review-v1/core.js | READY_TO_BIND | REAL_EXECUTOR_BOUND |
| TTS | NO MATCHING EXISTING RUNNER; lib/lumi-third-short-media-v1.js:runThirdShortTts uses OpenAI/Marin | REAL_EXECUTOR_MISSING | BLOCKED_FROZEN_PROVIDER_CONTRACT_MISMATCH |
| TTS_STORAGE | verifyTtsStorageGate + assertTtsStorageGate + verifyArtifact; lib/lumi-recovery-incident-manager-v1.js | READY_TO_BIND | REAL_EXECUTOR_BOUND |
| CAPTIONS | validateCaptionQa; lib/lumi-editorial-readiness-v1.js | READY_TO_BIND | REAL_EXECUTOR_BOUND |
| ASSEMBLY | buildAssemblyCommand + executeAssemblyCommand; lib/lumi-third-short-master-v1.js | ADAPTER_SHIM_REQUIRED | REAL_EXECUTOR_BOUND |
| MASTER | verifyArtifact; lib/lumi-recovery-incident-manager-v1.js | READY_TO_BIND | REAL_EXECUTOR_BOUND |
| MASTER_REVIEW | renderTelegramPanel + artifactReview; lib/telegram-review-v1/core.js | READY_TO_BIND | REAL_EXECUTOR_BOUND |

The full input/output contracts, side effects, recovery boundaries and idempotency mechanisms are exported by EXECUTOR_BINDING_MATRIX in lib/lumi-v2-executor-bindings.js.

## Open blockers

- No deployed project runner implements the frozen Higgsfield text2speech_v2 / ElevenLabs / Annie contract. runThirdShortTts implements OpenAI / Marin. No fallback is permitted.
- Generic live artifact materialization, provider polling/persistence handoff, and review receipt continuation are not complete. No incomplete adapter is registered in production routing. Existing historical executors remain intact.

## Diagnostic evidence

The new listening fixture enters the real wrapper paths under REAL_EXECUTOR_DRY_MODE. Image/video submitters stop at DRY_PROVIDER_BOUNDARY; assembly stops before ffmpeg encoding. TTS storage probes use isolated memory storage. Audio, temporal and master technical evidence is explicitly synthetic metadata. The sequential run stops at TTS. Downstream probes demonstrate component contracts independently; they do not produce a completed E2E episode.

The 56-row recovery matrix contains 52 actual fault injections on 13 connected components and four missing-executor rows for TTS. Lost durable receipts fail closed as EMISSION_AMBIGUOUS. Committed receipts permit checkpoint recovery without redispatch. Real provider side effects cannot be exercised during this zero-provider task.

## Commands

```sh
node --import ./scripts/director-offline-guard.mjs scripts/lumi-real-executor-readiness-v2.mjs /tmp/real-executor-v2.json
```

Diagnostic validation PASS is distinct from production readiness BLOCKED. The signed staging operation real_executor_dry_run invokes the same code using the existing canonical message identity, without editing the live panel, creating an approval, or writing production artifacts. Publication remains out of scope.
