import { CreativeValidationError, canonicalStringify } from "./contracts.js";

export const AV2_CANONICALIZER_VERSION = "av2-canonicalizer/1";
export const AV2_TIMELINE_TICKS_PER_SECOND = 30_000;
export const AV2_DURATION_TOLERANCE_TICKS = 1_000; // One 30 fps frame.

export const AV2_AUTHORITY_MODEL = Object.freeze({
  llm: Object.freeze([
    "story", "narration", "educational_action", "acting", "expression", "gaze_intent",
    "camera_intent", "motion_intent", "transition_style", "transition_motivation", "world",
    "props", "interaction", "audio_intent",
  ]),
  engine: Object.freeze([
    "scene_order", "timeline", "scene_start", "scene_end", "anchor_aliases",
    "transition_from_scene", "transition_to_scene", "scene_transition_references",
    "planned_duration", "canonical_hashes",
  ]),
});

export const AV2_CANONICAL_ANCHOR_GRAMMAR = Object.freeze({
  canonical: Object.freeze(["scene.start", "scene.end", "<local_id>.start", "<local_id>.end"]),
  transport_aliases: Object.freeze(["scene_start", "scene_end", "mid_scene"]),
  scope: "scene_local",
});

function secondsToTicks(value) {
  return Math.round(Number(value) * AV2_TIMELINE_TICKS_PER_SECOND);
}

function ticksToSeconds(value) {
  return Number((value / AV2_TIMELINE_TICKS_PER_SECOND).toFixed(6));
}

function canonicalizationError(path, message, keyword = "canonicalization") {
  return new CreativeValidationError("episode_canonicalization_invalid", [{
    path, keyword, message, params: {},
  }]);
}

function visitTimeRefs(value, visitor, path = "") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitTimeRefs(entry, visitor, `${path}/${index}`));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (typeof value.anchor === "string"
      && Object.keys(value).every((key) => ["anchor", "offset_seconds"].includes(key))) {
    visitor(value, path || "/");
    return;
  }
  Object.entries(value).forEach(([key, entry]) => visitTimeRefs(entry, visitor, `${path}/${key}`));
}

function canonicalizeAnchors(scene, sceneIndex, durationTicks, changes) {
  visitTimeRefs(scene, (timeRef, path) => {
    const original = timeRef.anchor;
    let offsetTicks = secondsToTicks(timeRef.offset_seconds ?? 0);
    if (original === "scene_start") timeRef.anchor = "scene.start";
    else if (original === "scene_end") timeRef.anchor = "scene.end";
    else if (original === "mid_scene") {
      timeRef.anchor = "scene.start";
      offsetTicks += Math.round(durationTicks / 2);
    }
    if (timeRef.anchor !== original) {
      timeRef.offset_seconds = ticksToSeconds(offsetTicks);
      changes.push({ path: `/scenes/${sceneIndex}${path}/anchor`, from: original, to: timeRef.anchor });
    } else if (Object.hasOwn(timeRef, "offset_seconds") && timeRef.offset_seconds !== null) {
      timeRef.offset_seconds = ticksToSeconds(offsetTicks);
    }
  });
}

function canonicalizeTransitions(plan, changes) {
  const { scenes } = plan;
  const transitions = plan.episode.transitions;
  if (transitions.length !== Math.max(0, scenes.length - 1)) return;
  const ids = new Set();
  transitions.forEach((edge, index) => {
    if (ids.has(edge.id)) throw canonicalizationError(
      `/episode/transitions/${index}/id`, `duplicate transition id ${edge.id}`, "unique",
    );
    ids.add(edge.id);
    const from = scenes[index].id;
    const to = scenes[index + 1].id;
    if (edge.from_scene !== from) changes.push({ path: `/episode/transitions/${index}/from_scene`, from: edge.from_scene, to: from });
    if (edge.to_scene !== to) changes.push({ path: `/episode/transitions/${index}/to_scene`, from: edge.to_scene, to });
    edge.from_scene = from;
    edge.to_scene = to;
  });
  scenes.forEach((scene, index) => {
    const transitionIn = index === 0 ? null : transitions[index - 1].id;
    const transitionOut = index === scenes.length - 1 ? null : transitions[index].id;
    if (scene.transition_in !== transitionIn) changes.push({ path: `/scenes/${index}/transition_in`, from: scene.transition_in, to: transitionIn });
    if (scene.transition_out !== transitionOut) changes.push({ path: `/scenes/${index}/transition_out`, from: scene.transition_out, to: transitionOut });
    scene.transition_in = transitionIn;
    scene.transition_out = transitionOut;
  });
}

function canonicalizeDuration(plan, changes) {
  const durationTicks = plan.scenes.map((scene, index) => {
    const ticks = secondsToTicks(scene.duration_target_seconds);
    const canonical = ticksToSeconds(ticks);
    if (canonical !== scene.duration_target_seconds) {
      changes.push({ path: `/scenes/${index}/duration_target_seconds`, from: scene.duration_target_seconds, to: canonical });
      scene.duration_target_seconds = canonical;
    }
    return ticks;
  });
  const overlapTicks = plan.episode.transitions.map((edge) => Number(edge.overlap_frames) * 1_000);
  const minTicks = secondsToTicks(plan.episode.duration_target.min_seconds);
  const maxTicks = secondsToTicks(plan.episode.duration_target.max_seconds);
  let totalTicks = durationTicks.reduce((sum, value) => sum + value, 0)
    - overlapTicks.reduce((sum, value) => sum + value, 0);
  const boundaryTicks = totalTicks < minTicks ? minTicks : (totalTicks > maxTicks ? maxTicks : null);
  const deviationTicks = boundaryTicks == null ? 0 : Math.abs(totalTicks - boundaryTicks);
  let adjusted = false;
  if (boundaryTicks != null && deviationTicks <= AV2_DURATION_TOLERANCE_TICKS && durationTicks.length) {
    const index = durationTicks.length - 1;
    const replacement = durationTicks[index] + (boundaryTicks - totalTicks);
    if (replacement <= 0) throw canonicalizationError(`/scenes/${index}/duration_target_seconds`, "duration tolerance adjustment would make the scene non-positive", "timing");
    changes.push({
      path: `/scenes/${index}/duration_target_seconds`,
      from: plan.scenes[index].duration_target_seconds,
      to: ticksToSeconds(replacement),
    });
    durationTicks[index] = replacement;
    plan.scenes[index].duration_target_seconds = ticksToSeconds(replacement);
    totalTicks = boundaryTicks;
    adjusted = true;
  }
  return { durationTicks, overlapTicks, totalTicks, deviationTicks, adjusted };
}

function timelineFor(plan, duration) {
  let cursor = 0;
  const scenes = plan.scenes.map((scene, index) => {
    const startTicks = cursor;
    const endTicks = startTicks + duration.durationTicks[index];
    cursor = endTicks - (duration.overlapTicks[index] || 0);
    return {
      scene_id: scene.id,
      start_ticks: startTicks,
      end_ticks: endTicks,
      start_seconds: ticksToSeconds(startTicks),
      end_seconds: ticksToSeconds(endTicks),
    };
  });
  return {
    version: "av2-timeline/1",
    ticks_per_second: AV2_TIMELINE_TICKS_PER_SECOND,
    planned_duration_ticks: duration.totalTicks,
    planned_duration_seconds: ticksToSeconds(duration.totalTicks),
    duration_adjusted: duration.adjusted,
    scenes,
  };
}

export function canonicalizeAv2Timeline(domainPlan) {
  if (!domainPlan || typeof domainPlan !== "object" || Array.isArray(domainPlan)) {
    throw canonicalizationError("/", "episode plan must be an object");
  }
  const plan = structuredClone(domainPlan);
  const creativeBefore = plan.scenes?.map((scene) => ({
    beat_ref: scene.beat_ref,
    educational_goal: scene.educational_goal,
    actions: scene.actions?.map(({ start: _start, ...action }) => action),
    utterances: scene.audio?.utterances,
  }));
  const changes = [];
  canonicalizeTransitions(plan, changes);
  const duration = canonicalizeDuration(plan, changes);
  plan.scenes.forEach((scene, index) => canonicalizeAnchors(scene, index, duration.durationTicks[index], changes));
  const creativeAfter = plan.scenes?.map((scene) => ({
    beat_ref: scene.beat_ref,
    educational_goal: scene.educational_goal,
    actions: scene.actions?.map(({ start: _start, ...action }) => action),
    utterances: scene.audio?.utterances,
  }));
  if (canonicalStringify(creativeBefore) !== canonicalStringify(creativeAfter)) {
    throw canonicalizationError("/scenes", "canonicalization changed LLM-authoritative creative content");
  }
  return {
    version: AV2_CANONICALIZER_VERSION,
    plan,
    timeline: timelineFor(plan, duration),
    changes,
  };
}
