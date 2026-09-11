# Content Factory Renderer

Docker renderer for CF-05.

## Endpoints
- GET /health
- POST /render
  - Header: x-render-token: <RENDER_API_TOKEN>
  - Body: {"video_id": 123}

## Required environment variables
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
RENDER_API_TOKEN
BUCKET_RENDERED=rendered-videos
PORT=3000

Do not commit secrets.
