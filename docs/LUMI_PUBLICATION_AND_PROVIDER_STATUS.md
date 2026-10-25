# Metricool direct integration — 2026-10-25

Status: **BLOCKED_BACKEND_OAUTH_REQUIRED**, not READY_FOR_HUMAN_PUBLICATION. The OAuth connection and local preparation are implemented; the end-to-end publisher is not operational.

## Deployed validation — 2026-10-25 19:16 UTC

- Live code: `4297ec0470a9d92eacf6cfa9b795a337a6948769`; exact-commit CI [40224809426](https://github.com/AgustinGettar/content-factory-renderer/actions/runs/40224809426) GREEN. Earlier implementation/fencing commits also remain in branch history.
- Render deploy `dep-dbf5a05g1s2s73ehi7c0` LIVE at `2026-10-25T19:14:58.964952Z`; both Studio and Telegram readiness report the same code SHA. DIRECT is configured and identity verified. Render remains Free, auto-deploy off.
- Served app SHA256 `2208c0060d958888ed9b3ea67eb970b68bc7919d9305b8fb706f0db86a3f434c`, publication module `bcf79d73d36bad7fdfaa8e2e79efb18172529964cd7c1fc212f5ad60fce6c4c7`, CSS `a62fc823ebe7fe0a3d27fba9dda5f15656e15dfc30c611a9f833fc44b3923106`; all byte-identical to the committed files.
- Anonymous state/session/publication status/episode GETs and connect/verify POSTs return 401. OAuth landing cannot claim successful authentication from a query parameter. No runtime error logs in the checked deployment window.
- Post-deploy staging still has no Metricool connection/credentials or publication packages. No human consent was fabricated. EP004 remains 38/50, pending image:q47, job NEEDS_ATTENTION, ceiling USD 8. Reservation digest `70f1ae94a0c170ceff71ba6cf198fc22` and review digest `f7b27af743366d904a7e08dea93586a3` are unchanged before/after. Existing session table RLS is enabled; anon/authenticated roles have no SELECT privilege.
- Local/browser and CI checks passed, including the existing synthetic Full HD/H.264/AAC playback, Range download and file-hash comparison. New browser tests use real mounted publication handlers and CAS persistence, not a successful fake publisher. Real Metricool authentication, remote video ingestion/publication and iPhone acceptance remain pending.
- This evidence-only follow-up must not redeploy. The branch HEAD may be a later documentation commit; the live executable remains the code SHA above.

## Current evidence (supersedes historical observations below)

- Starting HEAD and live code: `2bf56b33268b30616996917e4db0c83d04b0ad42`; CI `40218846288` successful; Render `dep-dbf46p0ae00c73enco8g` live. Free, one instance, auto-deploy off, staging branch/database pinned.
- EP004: 38/50 actions, six completed shots; pending `image:q47`; existing job `NEEDS_ATTENTION / PROVIDER_RESULT_FAILED`. No final master. Existing EP003 has a master. No production operation, approval, ledger or reservation was modified. The earlier USD 5 and q45 status are historical, not current. Ceiling remains USD 8.
- Connector read independently confirmed brand `7627207`, user/owner `5949429`, label `lumilaluciernaga`, timezone `Europe/Rome`; Instagram/TikTok `lumilaluciernaga`, YouTube `UC1ib2gAOQRCd45F5Ky1r-0Q`. This is connector evidence, **not backend authentication or autopublishing permission**.
- Staging durable state has no Metricool authorization or publication packages yet. No token was copied from ChatGPT and no existing secrets were replaced.

## Selected route and verified official discovery

Use official remote MCP + independent OAuth, not REST. On 2026-10-25, public metadata returned HTTP 200 from `https://ai.metricool.com/.well-known/oauth-protected-resource` and `https://ai.metricool.com/.well-known/oauth-authorization-server`. Resource `https://ai.metricool.com/mcp`; issuer `https://ai.metricool.com`; authorization/token/registration endpoints on `https://app.metricool.com/oauth/`; scopes `mcp:read mcp:write`; code + refresh grants; S256 PKCE. Unauthenticated MCP read returns HTTP 401.

Official registration accepted **Lumi Studio staging** with HTTP 201, public client `client_4d23246b94e346f4bcd3cffa00cb2c25`, token authentication `none`, and the sole redirect `https://content-factory-av2-staging.onrender.com/lumi/studio/publication/callback`. No client secret was returned. Registration does not authorize the account.

Studio → Ajustes → Publicación → Conectar Metricool starts the official consent. An authenticated, CSRF-protected POST stores a ten-minute, one-use handoff; the external-browser handoff sets a Secure/HttpOnly/SameSite=Lax browser cookie before redirecting to Metricool. Callback requires signed owner-bound state, durable nonce, cookie binding and PKCE. Code exchange is claimed before transport and never replayed after an uncertain response. Tokens are AES-256-GCM encrypted with owner AAD and a domain-separated key derived from the existing session secret (`LUMI_TELEGRAM_CALLBACK_SECRET`, or the existing bot-token fallback). No new Render secret is required for this public-client route. Secret rotation requires reconnection; credentials remain server-side.

After consent the Render backend initializes MCP, discovers actual tool schemas (bounded pages), calls only the discovered `getBrandSettings` / `get_brand_settings` read, and verifies the exact brand, owner and channels. It never selects the first brand. A mismatch blocks verification and preserves previous credentials. Token refresh uses a durable claim; lost refresh ACK requires fresh consent rather than blindly reusing a possibly rotated token. Discovery may be repeated after restart without exchanging the authorization code again. No provider calls occur while merely reading Studio state.

## Deliberate remaining publication blockers

Backend OAuth has not been completed by the owner. Therefore actual backend tool schemas, network permissions/account types, quota and video ingestion have **not** been verified. The ChatGPT connector exposes a scheduler with free-form `info` and optional `mediaFiles`; that schema is not evidence of the authenticated remote MCP contract or a durable VIDEO ingestion receipt. Official documentation also warns that unsupported/temporary media links can yield posts without media. No image-normalization endpoint is assumed to ingest video.

Accordingly, there is **no installed write/upload/schedule adapter**, no externally readable master capability URL, no publication worker, no remote drafts, no publication consent recorded, and no automatic enabling on OAuth completion. A closed `/publication/episodes/:episode/submit` handler rejects requests before any effect, including old master approvals. The app shows the precise missing contracts. This avoids building a publisher on an assumed endpoint; it is not a simulated successful integration.

The following must be verified against the authenticated provider before implementing/enabling the writer: video ingest + hosted media identity/attachment evidence; destination-specific mandatory fields and permitted TikTok privacy/disclosure, YouTube children classification, IG Reels; actual plan/counter; accepted/published states and lookup after lost ACK, including already published posts. Only then can a human publication decision bind master SHA/version + brand + destinations + texts/metadata/privacy + Rome/UTC schedule and authorize a durable per-network intent. No consent or per-network send receipts are fabricated here. Crash-after-send, partial publication, provider idempotency, remote reconciliation and DST scheduling are **not claimed tested or operational** because the transport is not installed.

## Useful preparation now available

- Reuses the deterministic, episode-specific generator. No text model or AI credit is used. Instagram, TikTok and YouTube versions are editable alongside the master in Videos/review/download. YouTube adds the relevant Shorts tag. Proposed children classification and AI disclosure are visible, not treated as approval. Privacy remains unselected until supported options are verified.
- Edits use the existing owner session row and revision CAS: `mini_app.publication_packages[episode].versions`. Versions record owner, master SHA, brand, texts and package hash. Same-content retries return the same version; conflicting changes require reviewing the stored version. Changed master invalidates the old package hash. Existing active/uncertain intents cannot be bypassed by editing. No schema or generative ledger changes.
- Autosave and explicit save show pending acknowledgement; unsaved owner/episode-scoped browser copies survive reopening, and confirmed versions survive backend restart. An uncertain save can be retried idempotently.
- Network text limits: IG 2,200, TikTok automatic 2,000, YouTube 5,000; title 100. These preparation bounds do not imply all account capabilities were verified.
- Settings distinguishes linked account, independently verified backend and automatic publication (blocked). No old brand is a default or cached destination. Existing download/review stays available despite Higgsfield funding notices.
- Plan/quota remain unknown for this account. Official Free limit is 20 published posts per calendar month, each network counts separately. It cannot support daily three-network publishing for a month. No plan upgrade, quota inference from scheduled posts, or promise of continuous Render Free execution.

## Validation and operational next action

Real operations: current GitHub/CI/Render/Supabase reads, connector brand read, public official OAuth discovery and registration. Zero account posts, schedules, remote drafts, video uploads, generative calls or new paid services.

Offline tests use real auth, mounted handlers and the existing CAS store with isolated fixtures: two episodes, ownership, duplicate clicks, restart, lost save ACK, package/master changes, stale versions, unapproved master, old approval without publication consent, wrong brand, missing/oversized fields, invalid privacy/children classification, expired access, declined OAuth, wrong browser/state, concurrent callback, lost OAuth/refresh ACK and read-only recovery. Negative arbitrary URL/media/quota inputs stay blocked; they are not remote ingestion or quota acceptance tests. Browser runs the actual Studio + handlers at a mobile viewport and checks persistent editing, lost response, reload, expired session, destination separation and disabled send actions. Existing workflow/media/download tests remain in CI. No fixtures are written to staging.

One next owner action: **Ajustes → Publicación → Conectar Metricool**, authorize the Lumi owner account, return to Telegram. The callback records independent identity/schema evidence; Settings reports any remaining provider-contract blockers. This is connection consent, not publication consent. On iPhone, manually verify that the official consent opens, returns successfully, and the saved message survives closing/reopening Telegram. Real publication/media acceptance remains untested and unauthorized.

## Official references revalidated 2026-10-25

- https://help.metricool.com/mcp-vs-api-access-what-is-the-difference-5y3ib
- https://help.metricool.com/how-to-connect-metricools-mcp-eqp9h
- https://help.metricool.com/mcp-limits-and-plan-requirements-h72jg
- https://help.metricool.com/basic-guide-for-api-integration-r97af
- https://app.metricool.com/resources/apidocs/index.html
- https://help.metricool.com/main-differences-between-free-and-paid-plans-bl0v9
- https://help.metricool.com/scheduling-and-posting-options-by-social-network-cwmb3

---

## Historical report, retained as evidence only (not active configuration)

# Provider wait diagnosis and publication copy — 2026-10-24

Scope: `lumi-telegram-review-v1`, `content-factory-av2-staging`, isolated database `mofjhwathxzfnjapvvst`. No new provider submissions, public posts, schedule, consent, budget changes, infrastructure or schema changes are performed by this intervention.

## Observed production

At 07:53 UTC, EP004 checkpoint revision 111 had 38/50 actions complete and six of seven shots finished. The pending action was `image:q47`. Its original provider request `574ed43e-129d-4e56-ba14-0d031f1670c2` was acknowledged at 06:00:49 UTC. The durable recovery loop was running (26 polls, latest check 07:53:14, no transport failures), returning `WAITING_EXISTING_RESULT`. The final image, clip, narration and assembly had not completed. A final master did not yet exist.

The recovery reader previously treated every provider response other than `completed` as pending, including `failed`, `nsfw` and `canceled`. Therefore these old stored wait records do not prove that the provider was still processing. The new reader distinguishes active, terminal and unknown states. Active status reaches the UI; a terminal failure immediately marks the recovery and existing job as requiring attention. The original claim, accepted request, checkpoint, reservations and human consents remain unchanged. No retry, cancellation, credit/refund assumption or replacement is introduced. The existing worker supplies the next fresh status after deployment.

## Publication preparation

Each episode in the Videos collection has an editable, copyable suggested message with emojis and relevant hashtags. Known Lumi stories have specific copy; future stories use their own title and learning objective when available. Copy is deterministic and does not call a text model or a publication provider. It is always a draft. Edits remain in the current UI session, are scoped to the owner and episode, and are cleared on session cleanup. Copying does not change video approval or publish anything.

The approved master download view also includes its publication text. Settings links to Metricool for account connection and scheduling. The application does not claim that a social account is connected or a post scheduled.

## TikTok connection

Metricool reported that brand `6912906` had no social network connected. That was the historical account, not the current destination. Active configuration now pins brand `7627207`; never reuse the former brand link.

Official Metricool documentation supports TikTok automatic publishing for personal/business accounts, with a video, caption, selected privacy, date/time and Auto Publish enabled. AI-generated disclosure is available for videos. Reference: https://help.metricool.com/schedule-and-post-on-tiktok-bkepi . A direct custom TikTok client requires an audit and is unsuitable as an internal upload utility under TikTok's published intended-use guidelines: https://developers.tiktok.com/doc/content-sharing-guidelines . No unapproved direct integration is created.

## Verification

Static assets now negotiate cached Brotli or gzip, computed once when the service starts. The script transfers in 32,918 bytes with Brotli (35,645 bytes with gzip fallback), including the new controls. Tests enforce absolute transfer budgets of 33 KiB and 36 KiB, decoded byte equality, encoding exclusion and distinct conditional-cache validators. Private responses remain uncompressed by this public-asset handler and `no-store`.

Focused unit and integration tests cover queued/processing/completed/failed/moderated/canceled/unknown responses, one GET of the accepted request, preserved claims and reservations, no re-emission, concurrent recovery, identity isolation, draft bounds and per-episode text. Browser fixtures verify copy, editing, navigation/poll retention, download/playback, existing approval gates and responsive layout. All provider/media calls in tests are synthetic. Live provider state must be read from the next persisted worker observation; fixture status is never written to staging.

## Lectura posterior al consentimiento · revisión de montaje 25-10-2026

Esta sección sustituye como estado actual las afirmaciones históricas de «OAuth pendiente» anteriores. El registro durable del backend está **BACKEND_VERIFIED**, lectura oficial guardada el **25-10-2026 a las19:47:59.672Z**, marca7627207/dueño5949429, Europe/Rome, Instagram/TikTok lumilaluciernaga y YouTube UC1ib2gAOQRCd45F5Ky1r-0Q. Se conservan las credenciales cifradas y el consentimiento; no se inició otra conexión. La auditoría leyó este recibo posterior, sin extraer tokens ni afirmar una nueva sesión privada autenticada desde el navegador.

El MCP autenticado descubrió nueve herramientas, incluyendo getBrandSettings, getScheduledPosts y createScheduledPost. No aporta entre ellas consulta de cuota ni opciones del creador TikTok. El contrato de creación describe URL pública para video; los archivos del selector ChatGPT no son transporte desde Render. Las escrituras y el adaptador de ingestión/recibos permanecen cerrados/no acreditados: no se declara publicación automática operativa. Cero publicaciones, programaciones, borradores remotos o cargas de prueba.

Studio conserva mensajes editables por episodio/versión y ahora diferencia conexión guardada de verificación reciente: una lectura vieja no pide OAuth de nuevo. Una reentrada cambia a «Comprobar acceso»; no implica aceptar difusión. Un master con otro SHA invalida el paquete anterior. Ver [revisión integral y limitaciones verificadas](LUMI_NATURAL_EDITING_REVIEW.md) y la evidencia de despliegue que acompaña el cierre.
