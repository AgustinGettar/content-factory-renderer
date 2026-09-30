export const R2 = Object.freeze({
  revision: "s19-r2", pilotId: "lumi_cinco_huevos_v1_s19_r2", sceneId: "s19",
  artifactId: "090490f8-0e75-47ca-8a2c-5f3340c7f413",
  parentAssetId: "883f54de-242d-4cd2-a80c-d1fc9999e8c0",
  parentImageRequest: "req_a40559d461ef42b182d219bd813e1b30",
  parentVideoRequest: "78fcf851-ba90-4206-b5eb-c09c5825d243",
  version: "scene-asset-manifest/production-pilot-v1-s19-r2",
  variant: "production_pilot_v1_source_s19_r2",
  imageMaxUsd: 0.15, videoMaxUsd: 0.30,
});

export const R2_CONSTRAINTS = Object.freeze({
  eggs: "EXACTLY FIVE eggs, egg_01 through egg_05, simultaneously fully visible, complete, clearly separated and individually countable throughout. No sixth egg or oval decoration. No hidden eggs, no appearance, disappearance, duplication, fusion or morphing. No count-changing movement inside/outside the basket.",
  lumi: "Preserve the full canonical Lumi Character Lock and rounded childlike body silhouette: warm yellow, turquoise eyes, rosy cheeks, violet-tipped antennae, tuft, translucent light-blue wings, denim overalls, white/light-blue shoes and star wand. NO added abdomen, abdominal growth, tail, new appendages, extra limbs, elongation, torso deformation, silhouette change or body mutation. Wings remain canonical; hands and arms remain anatomically coherent.",
  motion: "Locked stable camera. Natural tiny eye/head/hand gestures only; gentle blink and small smile. Keep the basket stationary. No basket lifting, no egg transfer, no walking, spinning or torso rotation. No aggressive body transformation. Preserve world, lighting, camera composition, recap_and_close narrative purpose and pedagogical readability.",
});

export function validateR2({ env, revision, sceneId, stage }) {
  if (env.LUMI_RUNTIME_ENV !== "staging") throw new Error("r2_production_rejected");
  if (env.LUMI_S19_R2_ENABLED !== "true") throw new Error("r2_disabled");
  if (revision !== R2.revision || sceneId !== R2.sceneId) throw new Error("r2_identity_rejected");
  if (!["IMAGE", "VIDEO"].includes(stage)) throw new Error("r2_stage_rejected");
  return { pilotId: R2.pilotId, sceneId, stage };
}

export async function readR2Run(supabase, stage) {
  const { data, error } = await supabase.from("lumi_pilot_runs").select("*")
    .eq("pilot_id", R2.pilotId).eq("scene_id", R2.sceneId).eq("stage", stage).maybeSingle();
  if (error) throw new Error("r2_ledger_read_failed");
  return data;
}

// An insert with the existing unique (pilot_id, scene_id, stage) is the sole
// authorization/dispatch opportunity. Never UPDATE an original S19 row.
export async function claimR2({ supabase, env, revision, sceneId, stage, estimatedUsd }) {
  validateR2({ env, revision, sceneId, stage });
  const max = stage === "IMAGE" ? R2.imageMaxUsd : R2.videoMaxUsd;
  if (!Number.isFinite(estimatedUsd) || estimatedUsd < 0 || estimatedUsd > max) throw new Error("r2_budget_rejected");
  if (stage === "VIDEO") {
    const image = await readR2Run(supabase, "IMAGE");
    if (image?.status !== "SUCCEEDED" || image.result?.visual_qa?.accepted !== true
      || image.result?.visual_qa?.blocker_count !== 0) throw new Error("r2_source_qa_required");
  }
  const row = {
    pilot_id: R2.pilotId, scene_id: R2.sceneId, stage, status: "CLAIMED",
    provider_calls: 0, estimated_cost_usd: estimatedUsd,
    claimed_at: new Date().toISOString(),
    result: { revision: R2.revision, authorization: "USER_EXPLICIT_S19_R2_IMAGE_ONCE_KLING_ONCE",
      lifecycle: "AUTHORIZED_CLAIMED", dispatch_consumed: false,
      lineage: { parent_asset_id: R2.parentAssetId, parent_scene_id: "s19",
        parent_image_request_id: R2.parentImageRequest, parent_video_request_id: R2.parentVideoRequest } },
  };
  const { data, error } = await supabase.from("lumi_pilot_runs").insert(row).select("*").single();
  if (error) throw new Error(error.code === "23505" ? "r2_duplicate_rejected" : "r2_claim_failed");
  return data;
}

export async function patchR2(supabase, row, patch) {
  if (row.pilot_id !== R2.pilotId || row.scene_id !== "s19") throw new Error("r2_original_immutable");
  const { data, error } = await supabase.from("lumi_pilot_runs").update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", row.id).eq("pilot_id", R2.pilotId).select("*").single();
  if (error || !data) throw new Error("r2_ledger_update_failed");
  Object.assign(row, data);
  return row;
}

export async function dispatchR2({ supabase, row, fetchImpl, url, options }) {
  if (row.result?.dispatch_consumed || row.status !== "CLAIMED") throw new Error("r2_dispatch_consumed");
  await patchR2(supabase, row, { status: "REQUESTED", result: { ...row.result,
    lifecycle: "PROVIDER_DISPATCH_COMMITTED", dispatch_consumed: true, provider_call_emitted: false } });
  // Only an acknowledged durable commit permits the single network emission.
  const promise = fetchImpl(url, options);
  await patchR2(supabase, row, { provider_calls: 1, result: { ...row.result,
    lifecycle: "PROVIDER_REQUEST_EMITTED", provider_call_emitted: true } });
  const response = await promise;
  const requestId = response.headers?.get?.("x-request-id");
  if (requestId) await patchR2(supabase, row, { provider_request_id: requestId });
  return response;
}
