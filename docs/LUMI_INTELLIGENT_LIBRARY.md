# Intelligent library and progressive master playback

Continues the existing Biblioteca V2 at 5c36d85823b701d6aa1f15f8c334dafc82985590. No second planner, catalog, bucket, provider or approval store is introduced.

## Flores evidence and playback

The user confirmed real Telegram/iPhone acceptance for characters, images and the q41 clip, and failure for the Flores master. The actual original matches catalog SHA b6f9fe837d000a924608ed4bda13034ff30560ac48b5a085f7cb0a90f35a2624, 30,709,796 bytes, 41.125 seconds, 1080x1920, H.264 High/avc1/yuv420p at 24 fps and AAC-LC stereo 48 kHz. Its moov starts at byte 32, before mdat at byte 29,714. No remux or video re-encode is needed or performed.

Verified transport defects: V2 downloaded and hashed the entire video into a browser Blob before creating a player; its HTTP range handler rejected valid suffix and beyond-EOF ranges. The exact iPhone error is unavailable, so these defects are not presented as a device-level diagnosis.

Native video now uses the authenticated same-origin five-minute ticket and progressive byte ranges. HEAD, prefix, suffix, open-ended, clamped ranges and If-Range are handled; unsatisfiable/multiple ranges fail closed. Exact content length, MIME, private/no-store, attachment download and original SHA headers are explicit. Owner/session/expiry checks run on each request. Source bytes are verified before delivery. A bounded 100 MB, two-minute in-memory cache coalesces concurrent video reads; application of reuse still performs fresh original-byte verification. This cache is not a second persistent media store.

Cards load a static JPEG extracted locally from the original and create a player only when opened. The native player uses playsinline and metadata preload, with read-only retry on failure. Explicit original download requests fresh access independently of decoding. Biblioteca and Videos share this path. No permanent signed URL, altered original, external processing or original overwrite is introduced. The original Flores produces a valid 60,340-byte JPEG through the same helper. Post-fix Telegram/iPhone playback and download remain NOT_TESTED_REAL until human confirmation.

## Deterministic discovery and approval

The existing sessionCandidates/syncLibrary capture path now discovers CHARACTER_REFERENCE, SCENE_REFERENCE, OBJECT_REFERENCE and original images, clips and masters from exact media hashes, AV2 visible placements/entity types, review inventories and frozen contracts. An isolated BACKGROUND requires an explicit exact-file manifest plus original approval; an environment alone never establishes an isolated background. This is metadata evidence, not computer vision. Context references retain the complete original composition and never claim a separate crop or 3D model.

Discovery facts, evidence, input fingerprint, detector version AV2_METADATA_1 and lifecycle live in the existing reuse_policy JSONB. DETECTED_CANDIDATE and PENDING_APPROVAL/REJECTED carry no reuse rights. HUMAN_APPROVED references and originals expose REUSABLE_REFERENCE or DIRECTLY_REUSABLE respectively. Exact-hash owner approval is required. Generic capture compares both existing review records; a missing/split decision cannot approve a resource. Pending/rejected versions do not become approved from metadata alone.

Repeated callbacks and reopen reconciliation reuse the same catalog ID. Unchanged hashes/detector inputs skip byte loading. Changed evidence appends an immutable version; no old row or file is rewritten. The UI and planner project the latest series version while existing historical selections retain their exact original IDs. The only migration extends the existing asset_type constraint with OBJECT_REFERENCE; RLS, grants and immutable triggers are unchanged.

## Recommendations and safe application

Read-only planning runs automatically on the active shot/revision in Inicio/Producción, and can be refreshed manually. Classification uses structured ownership, approval, rights, canonical profile, entity version, visible placement, environment/lighting, narrative, composition, orientation, resolution, duration and educational pause. Direct reuse requires exact authored narrative/continuity compatibility; reference reuse can preserve an environment across different actions without claiming the whole scene is reusable as a clip. Ranking prioritizes compatible direct originals, then approved references matching the shot focus, then other references and derivations. Missing evidence produces INCOMPATIBLE or NEW_GENERATION_REQUIRED. Text similarity alone is never sufficient.

The existing selection, explicit human confirmation, checkpoint CAS, provider-journal conflicts, reservation guards and destination reviews remain mandatory. Suggestions never call providers, make quotes, apply drafts or alter budgets. Reference reuse has zero avoided-generation savings. Direct verified savings retain the existing quote-and-reviewed-application evidence requirement. Unknown prices remain unknown.

## EP004 read-only preparation

The seven frozen shots last 4, 4, 4, 4, 5, 5 and 3 seconds. q45 preserves the 2.5-second pedagogical pause. Narration segments, authored direction, stage dependencies, approved Fernanda voice profile and the 1080x1920 H.264/AAC master contract are exposed as preparation only. Sync/subtitles/assembly/final review remain dependent on real approved inputs.

q42–q47 can use the canonical Lumi, contextual cow/sheep/hen and full farm image/scene as visual references. Metadata discovery also identifies Lumi and the wand within the q41 composition. Focus-based recommendations favor cow for q42/q46, sheep for q43 and hen for q44. The q41 clip and Flores master do not satisfy those different narratives. No direct generation savings are established and no selection is applied to EP004.

Protected baseline: EP004 revision 23, PAUSED_INCIDENT, 8/50, last shot_review:q41, next image:q42; whole-checkpoint MD5 fcdf4f7a9760788f5000e22431a0688f. q42 remains EMISSION_UNKNOWN/NO_RESPONSE, original operation 125ed083ab1bc866e0c3670c60d7cadee1dc284dbcd48f97dc6bdca95795dc90, reserve USD 0.3275. Budget cap USD 8, reserved exposure USD 1.22625, remaining internal USD 6.77375; actual charges unverified. Runners OFF, autorun false, publication disabled.

## Validation and release

43 focused library/auth tests passed locally with outbound networking/provider imports blocked, followed by affected provenance/discovery/UI/planner tests after final edits. Tests cover actual SQL migration/RLS, HTTP ranges/HEAD/download, private hash-bound access, real local FFmpeg poster decoding, native browser transport, deterministic discovery, pending/rejected approval, owner/version/scene incompatibility, deduplication, both durable decisions, EP005/EP006 recommendations/application and paused-episode preservation. Existing application/review/CAS/budget tests remain in the focused gate. No synthetic fixtures are inserted in staging. No provider-generation calls are made.

Current task is staging-only: require green CI on the exact branch commit, apply the additive constraint migration only to mofjhwathxzfnjapvvst, deploy content-factory-av2-staging only, compare protected-state fingerprints and original storage metadata after rollout. Human iPhone acceptance is distinct from offline/integration success.
