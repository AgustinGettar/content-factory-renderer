# ElevenLabs TTS V3 — preparation

Only TTS will migrate to ElevenLabs Direct. Higgsfield image/video, the durable
TTS lifecycle, materialization, QA, recovery, StageResult and continuation remain
unchanged. This initial commit adds **read-only discovery**, not a TTS binding.

`LUMI_VOICE_PROFILE_V3` is VOICE_SELECTION_PENDING. Its voice/model/output format
are intentionally unset. V2 Annie remains historically approved for its episode
with no supported deployable Higgsfield server TTS API.

Configure `ELEVENLABS_API_KEY` only in the staging service's Render environment.
The value must never be submitted in chat, source, reports or Telegram. Prefer
restricted TTS permission, the read permissions required for Models/Voices and
subscription quota, and a limited key quota. No unrelated write scopes.

The authorized staging-only GET `/lumi/tts/elevenlabs/discovery` and existing
signed Make operation `elevenlabs_voice_discovery` query the official endpoints:

- GET `/v1/models`
- GET `/v2/voices` (Spanish, female; studio-quality first, disclosed fallback)
- GET `/v1/user/subscription` (optional read-only quota metadata)

Unknown metadata remains null. Model IDs come from the authenticated catalog.
No model/voice is selected automatically and no synthesis method exists in this
preparation client. HTTP redirects are rejected; errors omit provider bodies,
credentials and headers. Startup logs show only credential presence and pending
status, with zero provider calls.

Next: authenticate using the staging secret, inspect enough existing previews,
shortlist at most two voices, and deliver through canonical AUDIO_REVIEW panel
138. Prefer zero generated samples. If Spanish pronunciation requires generated
samples, use the exact authorized common text, one attempt per candidate, durable
journal and immediate original storage; ambiguity forbids resubmission.

Stop for the user's A/B choice. Only then freeze V3, replace the transport/profile
adapter in the existing executor, verify quota budget with explicit units, run
recovery tests and all 14 real wrappers to dry boundaries, CI and staging checks.
Subscription quota alone does not establish a restricted key's remaining quota.
Keep episode USD accounting separate. No fourth short, global activation or
publication is authorized.

Official references:

- https://elevenlabs.io/docs/api-reference/models/list
- https://elevenlabs.io/docs/api-reference/voices/search
- https://elevenlabs.io/docs/api-reference/user/subscription/get
- https://elevenlabs.io/docs/api-reference/text-to-speech/convert
- https://elevenlabs.io/docs/overview/administration/workspaces/api-keys
