# Supervised ambiguous-operation recovery

This release stops at REPLACEMENT_PROPOSAL. It creates no active provider operation, grant, reservation, quote or provider request. A proposal cannot resume the paused episode. The operation ID and journal attempt ID are different identities and are both bound explicitly.

The existing LumiRecoveryIncidentManager.proposeSupervisedReplacement reads the original checkpoint, operation, original human authorization, reservation and provider journal, then appends an immutable proposal through the existing review-store CAS. Proposals live in lumi_telegram_review_sessions.state.supervised_replacement_proposals. The existing recovery_state is a legacy scalar and is preserved. No new table, service, scheduler or media storage is introduced.

Repeated preparation returns the same proposal. A conflicting limit or changed original evidence fails closed. CAS re-reads retain concurrent review/session changes. The source checkpoint and journal are read again before writing; an evidence change immediately afterwards cannot activate an inert proposal, and the Studio projection marks a changed checkpoint for review. Future activation must revalidate all original evidence, not trust a stored status label.

Flow: AMBIGUOUS_OPERATION → EVIDENCE_REVIEW → REPLACEMENT_PROPOSAL → HUMAN_RISK_ACCEPTANCE → NEW_INDEPENDENT_OPERATION → PROVIDER_EMISSION → RESULT_RECOVERY → HUMAN_REVIEW.

Only the first three phases are available in real staging in this release. replacementRiskGate is a pure preflight contract, not a permission or emission capability. It requires a separately authenticated server-side risk grant bound to the exact proposal/digest/original/action/owner/maximum, an unexpired quote bound to the new operation/attempt/model/payload and budget for both exposures. It returns an inert descriptor with independent planned IDs. No HTTP route accepts grants, creates replacements, or invokes this descriptor. Before activation in a later authorized change, connect an authenticated decision, atomic reservation/claim, journal, immediate transport guard, original-result recovery and human review to the existing runtime. Never call a provider merely because this function returns a descriptor.

The original q42 quote was USD 0.262; original reservation USD 0.3275. The proposed maximum additional internal reservation is USD 0.3275, an estimate based on the historical reservation, not a current quote or authorization. Combined q42 exposure would be USD 0.655 and total episode exposure USD 1.55375; actual previous/new charges remain unknown. Current exposure stays USD 1.22625, headroom USD 6.77375, cap USD 8. No promise of a provider charge cap or absence of a duplicate charge is made.

## Evidence and safe persistence

Real EP004 is read-only: checkpoint revision 23, PAUSED_INCIDENT, 8/50, last shot_review:q41, next image:q42. The proposal was additionally persisted through the connector in the existing review row (revision 711 → 712), using an atomic conditional append, row locks and exact pre-write checkpoint/source/journal/operation/authorization fingerprints. Full proposal readback digest must equal the versioned q42-replacement-proposal.json. Original checkpoint, journal, operation and q41 review fingerprints remain identical after the write. The journal contains three rows before and after; no replacement journal row exists.

The Studio state projection reads the proposal and shows the disclosed risk, retained reserve, estimated new reserve, current headroom and missing approval. Generation, quoting and authorization capabilities for this preparation remain disabled. Refresh remains read-only. Native iPhone rendering/playback is NOT_TESTED_REAL; the DOM and service projection are integration/offline checks.

## Durable improvement loop

Inputs: docs/lumi-improvement/state.json and incidents.json. Each incident separates observed symptom, evidence, confidence and root cause; UNKNOWN root causes must remain null. Metrics distinguish actual checkpoint progress, technical fixes and simulated progress. Unknown historical totals or provider charges are null/UNKNOWN, not invented zeros.

Run node scripts/lumi-improvement-loop.mjs once after updating evidence. It deterministically writes docs/LUMI_RESUME_STATE.md, docs/LUMI_PROMPT_FEEDBACK.md and docs/LUMI_NEXT_PROMPT.txt, all bound to an input SHA-256. It reads only local files, has no network/provider/database integration, cannot change grants, and never executes a prompt. The older docs/RESUME_STATE_EP004.json is retained as historical evidence, superseded by the compact current state. Resolve current branch/live state before a later write.

Focused CI uses a strict changed-file allowlist for this recovery surface, retains existing journal/budget/Recovery Manager/auth/library checks, and checks regenerated output equality. Changes outside that set retain the broader existing gate. EP005/EP006 tests are synthetic, isolated in memory, and blocked from external networking. Their mock acceptance/emission/result/human-review sequence proves contracts only, never real generation or billing. No fixtures are inserted in staging.

## Release scope

Only lumi-telegram-review-v1 and content-factory-av2-staging, Supabase mofjhwathxzfnjapvvst. Require CI GREEN for the exact published commit before deploy. Verify the live SHA, original fingerprints, proposal readback, journal count and runtime isolation after deployment. Keep legacy/global V2 off, runners OFF, autorun false and publication disabled. No changes to Make or production.
