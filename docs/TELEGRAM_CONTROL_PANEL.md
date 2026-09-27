# Content Factory — Telegram control panel

## Deployed components

- Supabase project: `hdptwtzhpfdrqiuezjhu`, function `content-factory-bot`.
- Make 6224860: Telegram updates → JSON serialization → authenticated Edge request → returned Telegram actions; separate filtered branch for AI requests → result validation → Telegram notification.
- Make 6243271: existing rendered-video delivery, now with approve/reject/schedule/menu buttons.
- Existing Render service and FFmpeg renderer are unchanged.

Live validation found the project OpenAI connection has insufficient API credits (HTTP 429). New AI requests and generation are therefore paused in `cf_bot_settings` with an explicit Spanish explanation. After API funding is restored, verify a single request before setting `ai_enabled=true` and `generation_enabled=true`. The follow-up migration `lumi_bot_ai_availability` adds these AI availability fields on existing installations.

The bot is private to administrators in `cf_bot_admins`. `/start`, `/menu`, and `/cancel` return home. Inline keyboards cover idea history, five new related ideas, manual idea entry with confirmation, generated-video review, approved/rejected lists, publication proposals, date/network selection, cancellation, published history, statistics, and niche exploration. The existing channel timezone is displayed throughout.

## Data and guarantees

`db/control-panel.sql` is the additive schema applied by migration `lumi_telegram_control_panel`. Do not run it twice. `cf_bot_command` performs authorized, serialized mutations and records idempotency keys. Repeat selection does not create another idea. Pending AI jobs and completed results are reused; results expire from the suggestion cache after 24 hours. Six new AI requests per hour are allowed. Sessions and schedule proposals expire after 30 minutes.

Review decisions live in `cf_video_reviews`, preserving the renderer's original status machine. Scheduling requires a rendered asset, explicit approval, future unambiguous local time, selected enabled networks, and verified publishing integrations. It rejects duplicate active publications and overlapping days for the same network. Rejection of a scheduled/publishing/published video is blocked; cancel an unstarted scheduled publication first.

All new tables have RLS enabled, access revoked from anonymous/authenticated clients, and service-role-only access. The RPC is SECURITY INVOKER with an empty search_path; it is executable only by service_role. Administrator identity is checked again within the transaction.

The Edge Function intentionally uses `verify_jwt=false` because Make supplies custom `x-cf-secret` authentication. The secret is generated randomly, held in Supabase Vault (`lumi_bot_transport_token`) and Make's server-side HTTP header mapping. Only its SHA-256 hash is stored in `cf_bot_settings`. It is not in this repository. Rotate both the Vault value/Make headers and the hash together. No bot token or database service-role key is exported from existing connections.

## AI privacy and costs

No model is called for ordinary menus, review, dates, or statistics. OpenAI receives only a fixed Lumi creative brief and counts in eight educational topic categories. Original idea text, channel names, Telegram IDs, video URLs, and credentials are excluded. The builder uses `gpt-4.1-mini`, bounded output and `store:false` via the existing project connection.

Niche exploration uses the Responses web_search tool on demand. A candidate must have a direct HTTPS YouTube/TikTok video URL also present in returned search citations/sources. Unsupported metrics are not generated. Results are opportunities for original adaptations, not a guarantee or ranking of viral content. Empty verified results are reported honestly. Platform statistics in the dashboard come exclusively from stored publication metrics; missing values display “Sin datos,” not zero.

## Connections still required

Publishing and metric synchronization are NOT deployed. The existing account has no YouTube connection, no usable TikTok organic-publishing connection, and the Instagram connection could not authorize account discovery. All integrations remain `not_connected`. Proposals can be reviewed, but confirming a live upload fails with a clear explanation. Do not set an integration to `ready` until a publisher and metric synchronizer have been connected and tested for the correct Lumi account.

Next deployment must add provider-specific OAuth, a scheduled publication worker, provider upload state reconciliation (never blindly retry an ambiguous upload), and metrics refresh with `fetched_at`. TikTok Campaign Management is an advertising connector, not an organic content-publishing integration. Do not substitute it.

## Validation

Run `node --test tests/telegram-panel.test.mjs` for menu/auth/privacy/date/source tests. `tests/control-panel.sql` validates authorization, approval gating, duplicate decisions, network selection, missing integrations, scheduling deduplication, cancellation prerequisites, daylight-saving ambiguity, AI replay caching and RPC privileges in a transaction that rolls back. It requires one administrator and one existing rendered video.

Existing database advisory findings on legacy views, characters and functions are outside this change. New control tables deliberately have no end-user RLS policies because only the authenticated server controls the bot.

## Rollback

Deactivate scenario 6224860 to pause the panel. Set `cf_bot_settings.generation_enabled=false` to block new production requests. Existing generated assets, reviews and schedules are retained. The renderer remains independent. Old CF-01 behavior is not required for the new panel; restoring it should use Make's prior version after deactivating the panel.
