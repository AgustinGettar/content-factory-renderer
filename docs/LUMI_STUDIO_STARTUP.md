# Lumi Studio startup performance — 2026-10-24

Scope: existing `lumi-telegram-review-v1` and `content-factory-av2-staging`, Render Free; no schema changes, infrastructure purchase, keep-alive, provider generation, new plan or consent. Existing episode progression remains authoritative (EP004 had already advanced to `image:q47` when read).

## Evidence and implementation

Read-only staging SQL measured the review state at 1,160,450 JSON bytes and EP004 checkpoint at 1,192,927 bytes. The previous state projection read the full review row three times and the checkpoint five times, plus three linked-source reads, in series. Authentication also loaded the full review history for every session, state and media request. Render's observed Node process startup was about 9 seconds; no authenticated iPhone end-to-end baseline was available.

- `miniAppStatus` loads each large record once, reads independent owner/journal/source information concurrently, and derives cost/quote displays from that snapshot. `context` retains its retry on concurrent review revision changes using a small fresh revision query. It does not cache authorization or episode state across requests.
- Budget calculation is extracted without changing the calculation or the fresh read required by spending gates. Imported liabilities, reservations, existing job identities and all consent/CAS checks remain intact.
- Session authentication selects only identity and the requested session, still checking expiry, revocation, owner and CSRF on every call. The measured equivalent JSON projection is 190 bytes. Media catalog reads select only necessary fields (review projection 56,786 bytes); original integrity checks and private signed access remain required.
- An existing session can fetch its initial state in the same GET (`session?state=1`). API/media stay `no-store`; no private snapshot or CSRF is saved in a browser cache.
- Telegram's SDK loads asynchronously. Official raw launch data from the URL fragment may reach the existing signature/replay verifier while the SDK is loading; no browser identity is trusted. SDK enhancements attach when available.
- Public HTML is revalidated; app/CSS URLs are content-versioned, compressed and cacheable. Conditional requests preserve ETag/Vary semantics. Old unversioned URLs revalidate.
- A failed first read shows a visible retry; the UI avoids overlapping startup polling and waits a complete polling interval after a finished read. Read retries cannot submit a generation.
- Safe `Server-Timing` and staging `lumi_studio_read_timing` logs report auth/state durations without IDs, credentials, URLs or raw state.

## Validation

Controlled same-fixture measurement with 40 ms added per storage read: 11 reads / 468 ms before, 4 reads / approximately 172–179 ms after. This is a synthetic transport benchmark, not an iPhone latency claim. The four calls are one review, one checkpoint, one linked-source query and one revision check; owner/journal reads are additionally retained.

Script transfer in the local HTTP fixture: 112,631 raw bytes to 33,666 gzip bytes (about 70% smaller). Browser tests hold Telegram's SDK indefinitely and verify the app becomes usable with an existing session, a fresh launch and a recovered failed read. Additional tests cover read-only GETs, revoked sessions, concurrent revision changes, private media, unchanged budget results, production locks, review controls, playback and download.

Local Chromium download was unavailable in this executor; browser acceptance is run by the repository's GitHub CI. Do not label desktop/fixture results as real Telegram/iPhone acceptance.

Render Free's sleeping-service delay still applies before the first HTTP response. No keep-alive or paid-plan change is included. A cold-start-free guarantee would be false under this constraint.
