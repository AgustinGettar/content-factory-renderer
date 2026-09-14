# Content Factory Renderer

Cloud production service for Lumi. The existing FFmpeg renderer stays available
while a deterministic Blender character pipeline and direct YouTube publisher
are introduced behind separate endpoints.

## Endpoints
- GET /health
- POST /render
  - Header: x-render-token: <RENDER_API_TOKEN>
  - Body: {"video_id": 123}
- POST /lumi/pilot
  - Header: x-render-token
  - Body: {"quality":"smoke"} or {"quality":"review"}
  - `smoke` is a compact 270x480/8 fps Workbench proof; `review` is 720x1280/24 fps with Eevee
  - Returns an asynchronous job id; poll GET /lumi/pilot/:jobId
- GET /youtube/status
- POST /youtube/oauth/start
- GET /youtube/oauth/callback
- POST /youtube/upload
  - Requires a rendered video and the latest review verdict `approved`
  - Defaults to `private`; pass `privacy_status` only after editorial approval

## Required environment variables
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
RENDER_API_TOKEN
ADMIN_API_TOKEN
BUCKET_RENDERED=rendered-videos
PORT=3000
BLENDER_BIN=blender
BLENDER_TIMEOUT_MS=1800000
TOKEN_ENCRYPTION_KEY=<base64 32-byte key>
YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET
YOUTUBE_OAUTH_STATE
YOUTUBE_REDIRECT_URI=https://content-factory-renderer.onrender.com/youtube/oauth/callback
YOUTUBE_ALLOW_PUBLIC=false

Do not commit secrets.

`RENDER_API_TOKEN` remains dedicated to the automated renderer. Use the
separate `ADMIN_API_TOKEN` for the Blender pilot and YouTube administration
endpoints so testing cannot invalidate the automation credential.

## Production order

1. Deploy and run the low-resolution Blender smoke pilot.
2. Review Lumi's official model, motion and voice before enabling episode renders.
3. Configure Google OAuth and connect the actual channel once.
4. Upload the first approved episode as `private` and review it in YouTube Studio.
5. Only then schedule or publish it.

The Google OAuth refresh token is encrypted with AES-256-GCM before it is stored
in Supabase. Browser users never see or copy the token.
