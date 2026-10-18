# Lumi reusable asset library V1

Permanent section of the existing Telegram-authenticated Studio: `/lumi/studio#biblioteca`.
No new application, bucket, provider integration or generation path. Only staging is enabled by the existing Mini App environment pin.

The catalog points to unchanged private storage objects. Server-side import downloads and SHA-256 checks every candidate, reads exact-hash durable human approvals, and inserts immutable catalog versions. The preserved q31 human source approval is read from the historical quality-gate manifest. Missing staging bytes are skipped; no production or cross-environment download is attempted. Unapproved available originals remain `PENDING_VERIFICATION` with no reuse modes.

Character/scene references can describe a subject visible within an approved whole image. They retain that image's original bytes and approval scope. They are not extracted characters, independent 3D models or standalone backgrounds. Asset identity includes owner, source episode/shot, type and subject; references sharing bytes do not create duplicate storage objects.

Tables `lumi_library_assets` and `lumi_library_selections` use RLS and service-role-only privileges. The version allocator uses an advisory transaction lock. Inserts are idempotent and versions cannot be updated/deleted. Assets keep exact approval provenance and a decision fingerprint. Neither table has a trigger writing production state.

Library routes reuse Mini App Telegram signature verification, active-owner checks, secure session cookie, CSRF and origin protections. Media uses session/owner/asset/hash-bound five-minute HMAC tickets through the same-origin server, with SHA verification before every response and byte-range support. No permanent public or private storage URL is returned. Anonymous Supabase roles cannot read or insert catalog data.

## Reuse contracts

`POST /lumi/studio/api/library/selections` accepts only asset ID, target episode ID, target shot ID and mode. It checks human approval, policy, current original bytes and target ownership, then saves an idempotent immutable selection. Existing and future episode IDs are supported. The selection never applies itself to a production checkpoint.

`GET /lumi/studio/api/library/selections/:id` rechecks ownership, policy, exact version, hash and original bytes, returning the bound contract and short-lived original-media link. Downloading directly delivers the approved existing file with no regeneration.

- `REFERENCE_REUSE`: identity/scene reference for future work. New generation still needs a quote and explicit spending authorization.
- `DIRECT_MEDIA_REUSE`: exact approved original media. No provider generation. A future episode assembler must explicitly adopt the resolved contract through its normal gates.
- `DERIVED_ASSET`: planning only; processing is not authorized and source approval is not inherited. A new output requires its own asset version and human approval.

All selections are `DRAFT_NOT_APPLIED`; provider calls and generation authorization are zero/false. EP004, its checkpoint, reviews, journal, reservations and budget ledger are read only. No operation can unlock q42 or change production order.

## Validation and rollout

Focused offline acceptance covers catalog, exact approval provenance, corrupt bytes, private buckets, forged principal, cross-owner and cross-session media, expiration, SQL versioning/RLS/grants, duplicates, multi-episode contracts, unchanged production fixtures, and the existing Mini App lock/read-only-progress regressions. The existing CI workflow selects this focused path only for library-scoped changes; other changes retain the historical validation path.

Apply the additive migration only to `mofjhwathxzfnjapvvst`, require green CI for the exact branch head, then deploy only `content-factory-av2-staging`. Authorized startup reconciliation reads the original files and registers verified metadata. Compare the pre/post protected-state fingerprints and storage inventory after deployment.
