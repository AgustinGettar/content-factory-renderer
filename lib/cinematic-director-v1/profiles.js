// Versioned offline policy. Neither a quote nor permission to resume an episode.
export const POLICY = Object.freeze({
  id: 'lumi-director-review/1', version: '1.0.0', episode_id: 'ep_lumi_flores_003',
  provider: 'higgsfield_api', endpoint: 'kling-video/v3.0/pro/image-to-video',
  language: 'en', style: 'premium stylized 3D CGI',
  durations: { q31: 4, q32: 4, q33: 4, q34: 4, q35: 5, q36: 5 },
  educational_objects: { q31: [], q32: ['flower_red'], q33: ['flower_yellow'], q34: ['flower_blue'], q35: ['flower_red','flower_yellow','flower_blue'], q36: ['flower_red','flower_yellow','flower_blue'] },
  ledger_aliases: { q35: 'q37', q36: 'q39' },
  controls: { sound: 'off', multi_shots: false, cfg_scale: 0.5 },
  automatic_retries: 0, automatic_variants: 0, automatic_resubmits: 0,
  budget_authorization: false, execution_authorization: false, incremental_generation_budget: 0,
  authority: [
    'Current user implementation instruction: offline only; preserve premium stylized CGI and q31-PRO2 approval.',
    'LUMI_SERIES_V2_QUALITY_BUDGET_REVIEW.json: scoped video_quality_profile Pro endpoint; historical costs are not current authorization.',
    'LUMI_q32_q33_REPAIR_PLAN.json: body lock and source/temporal distinction; no repairs authorized.'
  ],
  authority_records: [
    { file: 'LUMI_SERIES_V2_QUALITY_BUDGET_REVIEW.json', sha256: 'a2f72728081380277728d10043d03af32cf9438af895648723c1f777456d352c', scope: 'LUMI_VIDEO_QUALITY_PROFILE_V2 endpoint and q31-PRO2 approval; not renewed budget' },
    { file: 'LUMI_q32_q33_REPAIR_PLAN.json', sha256: '680dd20201922dae16367de53151296b96de433d0b0ff1fe37f83e47ccb0baaf', scope: 'source/temporal diagnosis and body lock; no execution permission' },
  ],
  explicit_supersession: ['V3 Standard requirement is historical for V3 consumers.', 'V3 USD 4 ceiling is not a new budget grant.', 'Historical ultra-realistic names are identifiers, not prompt vocabulary.'],
  conflicts: [],
});

export const CAPABILITIES = Object.freeze({
  id: 'higgsfield-kling3-pro-i2v/2026-10-05', version: '1', provider: 'higgsfield_api',
  endpoint: 'kling-video/v3.0/pro/image-to-video', verified_on: '2026-10-05',
  provenance: 'https://open.higgsfield.ai/models/kling-video/v3.0/pro/image-to-video/api-reference',
  verification: 'OFFICIAL_DOCUMENTATION_AND_LOCAL_ADAPTER_NO_REQUEST',
  fields: {
    prompt: { type: 'string' }, image_url: { type: 'string', required: true },
    sound: { type: 'string', enum: ['on', 'off'] },
    duration: { type: 'integer', minimum: 3, maximum: 15 },
    cfg_scale: { type: 'number', minimum: 0, maximum: 1 },
    multi_shots: { type: 'boolean' },
  },
  optional_disabled: ['elements', 'multi_prompt', 'last_image_url'],
  unsupported: ['negative_prompt', 'seed', 'camera_control', 'resolution', 'aspect_ratio', 'enhance_prompt', 'motion_control'],
  prompt_limit: null, media_constraints: null,
  pending: ['Documented prompt length limit', 'Detailed accepted image MIME/dimensions/size constraints'],
  limitations: ['Provider internal prompt transformations are not observable.', 'One prose line incorrectly says Standard beside the Pro endpoint; requested endpoint does not prove actual execution tier.', 'CFG is a numeric control, never an obedience percentage.'],
});
