// Read-only inventory of the existing CF-03 -> Supabase -> renderer contract.
// This module changes neither Make nor the renderer.
export const CURRENT_VISUAL_PIPELINE_AUDIT_V1 = Object.freeze({
  source: "CF-03 - Generar imágenes escenas",
  image_generation: {
    provider: "OpenAI",
    make_module: "openai-gpt-3:editImage",
    model: "gpt-image-2-2026-04-21",
    reference: "characters/lumi-reference.png",
    outputs_per_scene: 1,
    size: { width: 1024, height: 1536 },
    source_aspect_ratio: "2:3",
    delivery_aspect_ratio: "9:16 center crop",
    quality: "high",
    format: "png",
    seed: null,
  },
  consistency: {
    character_reference_each_scene: true,
    deterministic_seed: false,
    scene_level_identity_lock: false,
    reusable_environment_assets: false,
    reusable_prop_assets: false,
    independent_generated_layers: false,
  },
  storage: {
    bucket: "generated-images",
    public: true,
    object_key: "channel-{channel_id}-video-{video_id}-scene-{scene_number}.png",
    scene_record_field: "public.scenes.image_url",
    provider_metadata_persisted: false,
  },
  renderer_consumption: {
    scene_fields: ["image_url", "audio_url", "narration", "on_screen_text", "metadata.production"],
    background: "scene image decoded as one full-frame still and center-cropped to 9:16",
    character: "approved local open/blink Lumi PNGs overlaid independently",
    teaching_prop: "deterministic SVG focus card overlaid independently",
    layers: ["background_still", "lumi_open_or_blink", "focus_card", "magic_fx", "caption"],
  },
});
