# Production recovery and scoped episode execution

The existing Recovery Manager, stage receipts, provider journal, budget gate and Mini App CAS store remain authoritative. No new queue service, database or generative runner was introduced.

## Confirmed incident

The acknowledged q42 replacement had a complete materialization receipt and verified PNG. The checkpoint handler expected estimated_cost.usd, while the real receipt contained estimate_usd and reserve_usd. usd_amount_invalid prevented checkpoint incorporation and was masked by the HTTP route as MINI_ACTION_UNAVAILABLE. Normalization now preserves the actual reservation of the active replacement attempt; the historical original reservation is separate and unchanged.

The live evidence in lumi-improvement/production-recovery-evidence.json records the same request and PNG arriving at one pending review. It is not artistic approval, billing proof or a newly generated image.

## Durable continuation

MiniAppService drains accepted receipts and explicitly started episode jobs on process startup and periodically while the service is active. Durable rows and CAS leases survive browser/session loss and process restart. The timer is a wakeup mechanism, not the authority or queue. GET progress is read-only.

Accepted IMAGE/VIDEO recovery binds owner, episode, action, attempt and acknowledged provider request. A complete receipt first reuses stored bytes and verifies their hash; it does not poll or download the provider output again. Otherwise the same accepted job is polled, with a 45-second transport deadline, 120-second lease, heartbeat and backoff. At 120 poll cycles or eight consecutive failures the record requires attention; no new submission is enabled. Late original evidence remains a separate record and never creates a third request.

A persisted human review whose response was lost is reconciled only when its original operation, identity, decision, checklist, artifact SHA and review version match the authoritative request. Existing strict artifact and reviewer checks still run. This recovery does not fabricate approval or depend on a renewed browser session.

A human approves a sealed, expiring episode plan and explicitly starts its job. An internal lease-bound principal may execute only that owner/episode/job and approved action set. Global autorun and generative runners remain OFF. The executor advances existing technical stages, pauses for mandatory human reviews, then continues the same job. Current prices are obtained internally only for a new covered action; actual reserve, per-action ceiling, remaining episode exposure and forecast coverage are checked before dispatch. A real unknown submission is never retried. A material change needs a new plan decision in Studio.

Pure local stages can reuse their interrupted deterministic claim. Paid stages cannot reset an uncertain claim. TTS resumes the original request set; its proposed authorization allows existing subscription quota only, without paid overage or top-up. No automatic variant, model substitution, quality reduction or social publication is authorized.

## User path

Studio shows the episode objective, known estimate, actual progress and one contextual primary action. Economic limits and models remain available in expandable details. The path is: review saved q42, approve/start the remaining plan when offered, review required results, then review and download the master. No technical continuation prompt or normal manual quote/recovery button is required.

The remaining image/video forecast uses documented historical same-model receipts and frozen durations: USD4.18, with proposed future reservation ceilings totaling USD5.225. Existing exposure is USD1.57125, so the proposed combined ceiling is USD6.79625 within USD8. These are estimates and reservations, not provider charges. Voice subscription, storage and infrastructure allocation are unknown. No fresh provider quote was requested by this intervention. Compatible direct reuse is evaluated before a new spend; references alone are not savings.

Frozen quality bindings remain Lumi V2 premium 3D, canonical character/animals and educational scene objectives; no text over Lumi, no automatic quality downgrade. Fernanda remains frozen. The final assembly contract is 1080×1920 H.264/AAC, natural pacing and required human master review.

## Validation and limits

The incident regression uses an acknowledged request, complete storage receipt, DISPATCHING checkpoint and WAITING UI. It proves idempotent arrival at one review under restart, CAS conflict and expired session, without an extra reservation, provider call or object. Saved review ACK loss and forged binding are also covered.

Two synthetic seven-shot episodes traversed the real Mini App service, handlers, validators, durable executors, media inspection, local ffmpeg assembly, master review and private download. Only external services were simulated. Their reviewed masters are test artifacts, not EP004 progress. No fixtures were inserted in staging.

Real EP004 remains8/50 until the user reviews q42. Future real provider/voice behavior, artistic quality, billing and final delivery are not established by simulation. Render free may suspend: work does not execute while suspended and resumes from durable state after the service wakes. No new hosting, keep-alive, Make, webhook or secrets changes were made.
