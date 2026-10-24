# Provider wait diagnosis and publication copy — 2026-10-24

Scope: `lumi-telegram-review-v1`, `content-factory-av2-staging`, isolated database `mofjhwathxzfnjapvvst`. No new provider submissions, public posts, schedule, consent, budget changes, infrastructure or schema changes are performed by this intervention.

## Observed production

At 07:53 UTC, EP004 checkpoint revision 111 had 38/50 actions complete and six of seven shots finished. The pending action was `image:q47`. Its original provider request `574ed43e-129d-4e56-ba14-0d031f1670c2` was acknowledged at 06:00:49 UTC. The durable recovery loop was running (26 polls, latest check 07:53:14, no transport failures), returning `WAITING_EXISTING_RESULT`. The final image, clip, narration and assembly had not completed. A final master did not yet exist.

The recovery reader previously treated every provider response other than `completed` as pending, including `failed`, `nsfw` and `canceled`. Therefore these old stored wait records do not prove that the provider was still processing. The new reader distinguishes active, terminal and unknown states. Active status reaches the UI; a terminal failure immediately marks the recovery and existing job as requiring attention. The original claim, accepted request, checkpoint, reservations and human consents remain unchanged. No retry, cancellation, credit/refund assumption or replacement is introduced. The existing worker supplies the next fresh status after deployment.

## Publication preparation

Each episode in the Videos collection has an editable, copyable suggested message with emojis and relevant hashtags. Known Lumi stories have specific copy; future stories use their own title and learning objective when available. Copy is deterministic and does not call a text model or a publication provider. It is always a draft. Edits remain in the current UI session, are scoped to the owner and episode, and are cleared on session cleanup. Copying does not change video approval or publish anything.

The approved master download view also includes its publication text. Settings links to Metricool for account connection and scheduling. The application does not claim that a social account is connected or a post scheduled.

## TikTok connection

Metricool reported that brand `6912906` had no social network connected. Account authorization must be completed by the user at `https://app.metricool.com/brands/connections?blogId=6912906`.

Official Metricool documentation supports TikTok automatic publishing for personal/business accounts, with a video, caption, selected privacy, date/time and Auto Publish enabled. AI-generated disclosure is available for videos. Reference: https://help.metricool.com/schedule-and-post-on-tiktok-bkepi . A direct custom TikTok client requires an audit and is unsuitable as an internal upload utility under TikTok's published intended-use guidelines: https://developers.tiktok.com/doc/content-sharing-guidelines . No unapproved direct integration is created.

## Verification

Static assets now negotiate cached Brotli or gzip, computed once when the service starts. The script transfers in 32,918 bytes with Brotli (35,645 bytes with gzip fallback), including the new controls. Tests enforce absolute transfer budgets of 33 KiB and 36 KiB, decoded byte equality, encoding exclusion and distinct conditional-cache validators. Private responses remain uncompressed by this public-asset handler and `no-store`.

Focused unit and integration tests cover queued/processing/completed/failed/moderated/canceled/unknown responses, one GET of the accepted request, preserved claims and reservations, no re-emission, concurrent recovery, identity isolation, draft bounds and per-episode text. Browser fixtures verify copy, editing, navigation/poll retention, download/playback, existing approval gates and responsive layout. All provider/media calls in tests are synthetic. Live provider state must be read from the next persisted worker observation; fixture status is never written to staging.
