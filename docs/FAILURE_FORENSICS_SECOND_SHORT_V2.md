# Failure forensics — Lumi second short

Episode: `ep_lumi_formas_002` — “Lumi y el jardín de las formas”  
Evidence boundary: immutable original assets and QA records; no provider calls; no repair artifacts.  
Analyzed compiler: `lib/lumi-second-short-v1.js` at staging commit `a896c0b` plus `SCENE_PLAN_V2.json`.

## Shared prompt evidence

Every old source-image prompt contained the scene's exact `visual_prompt_compilation.blocks`, followed by the shared shape contract and output block. The conflicting shared world block was:

> Original twilight lantern garden; rounded ivy arches, soft violet-blue sky, warm path lights, same three stone pedestals; fixed order circle-left, triangle-center, square-right whenever all are visible.

The old Kling compiler appended a general temporal shape lock and a camera instruction that said only “the restrained planned camera movement.” It did not compile a canonical inventory, explicit counts/positions, a closed motion allowlist, or an end-state contract.

## Scene findings

### s22

- `SCENE_ID`: `s22`
- `EDUCATIONAL_OBJECTIVE`: teach one circle; zero corners.
- `SOURCE_IMAGE_PROMPT`: action “Lumi points once to a large round blue lantern on its own pedestal”; object lock `one_circle_zero_corners`; motion “wand point and gentle glow only; circle silhouette remains rigid”; plus the conflicting shared three-pedestal continuity block above.
- `SOURCE_IMAGE_QA_BLOCKER`: triangle and square remained present in a single-circle teaching scene.
- `KLING_PROMPT`: character identity lock + the same pointing action + wand point/glow + symbolic lock `one_circle_zero_corners` + generic three-shape lock + generic continuity/camera/negative blocks. No video was emitted because source QA blocked it.
- `TEMPORAL_QA_BLOCKER`: none; no Kling call for this scene.
- `WHICH_CONSTRAINT_WAS_MISSING`: an exclusive inventory stating exactly one educational object, count `1`, circle geometry, center position, and zero other teaching shapes/pedestals.
- `WHICH_CONSTRAINT_WAS_AMBIGUOUS`: “same three stone pedestals” and “whenever all are visible” competed with the single-circle intent.
- `UNNECESSARY_MOTION_REQUESTED`: the source keyframe prompt carried wand/glow motion language.
- `OBJECTS_MODEL_WAS_ALLOWED_TO_INVENT`: triangle lantern, square lantern, unused teaching pedestals.
- `ROOT_CAUSE_CLASS`: `SOURCE_IMAGE_AMBIGUOUS`, `PROMPT_UNDERSPECIFIED`, `OBJECT_COUNT_UNLOCKED`.

### s23

- `SCENE_ID`: `s23`
- `EDUCATIONAL_OBJECTIVE`: teach one triangle with exactly three visible sides and three corners.
- `SOURCE_IMAGE_PROMPT`: action “Lumi traces the air near a large yellow triangular lantern without touching it”; object lock `one_triangle_three_sides_three_corners`; motion “short wand trace; triangle remains rigid and fully visible”; plus the shared three-pedestal continuity block.
- `SOURCE_IMAGE_QA_BLOCKER`: circle and square remained present in the single-triangle scene.
- `KLING_PROMPT`: character lock + wand trace + symbolic triangle lock + generic three-shape lock and continuity/camera/negative blocks. No video was emitted.
- `TEMPORAL_QA_BLOCKER`: none.
- `WHICH_CONSTRAINT_WAS_MISSING`: exact exclusive count and object set; one frontal triangle only, exactly three visible sides, no circle, no square.
- `WHICH_CONSTRAINT_WAS_AMBIGUOUS`: continuity authorized three pedestals while the semantic lock requested one triangle.
- `UNNECESSARY_MOTION_REQUESTED`: source prompt included an air-trace action; for video the trace was broader than a single point and could compete with geometry stability.
- `OBJECTS_MODEL_WAS_ALLOWED_TO_INVENT`: circle lantern, square lantern, unused teaching pedestals.
- `ROOT_CAUSE_CLASS`: `SOURCE_IMAGE_AMBIGUOUS`, `PROMPT_UNDERSPECIFIED`, `OBJECT_COUNT_UNLOCKED`.

### s24

- `SCENE_ID`: `s24`
- `EDUCATIONAL_OBJECTIVE`: teach one square with four equal readable sides.
- `SOURCE_IMAGE_PROMPT`: action “Lumi presents a large coral square lantern on its own pedestal”; object lock `one_square_four_equal_sides`; motion “single presenting gesture; square remains rigid and frontal”; plus the shared three-pedestal continuity block.
- `SOURCE_IMAGE_QA_BLOCKER`: circle and triangle remained present in the single-square scene.
- `KLING_PROMPT`: character lock + presenting gesture + symbolic square lock + generic three-shape lock and continuity/camera/negative blocks. No video was emitted.
- `TEMPORAL_QA_BLOCKER`: none.
- `WHICH_CONSTRAINT_WAS_MISSING`: exclusive object set and count: exactly one square, no other teaching geometry.
- `WHICH_CONSTRAINT_WAS_AMBIGUOUS`: “same three stone pedestals” preserved the previous group despite the one-square scene.
- `UNNECESSARY_MOTION_REQUESTED`: source prompt carried a presenting action even though it was a still keyframe.
- `OBJECTS_MODEL_WAS_ALLOWED_TO_INVENT`: circle lantern, triangle lantern, unused teaching pedestals.
- `ROOT_CAUSE_CLASS`: `SOURCE_IMAGE_AMBIGUOUS`, `PROMPT_UNDERSPECIFIED`, `OBJECT_COUNT_UNLOCKED`.

### s25

- `SCENE_ID`: `s25`
- `EDUCATIONAL_OBJECTIVE`: map circle→moon disc, triangle→pennant, square→window.
- `SOURCE_IMAGE_PROMPT`: action “Three spaced examples appear in separate alcoves; Lumi's gaze moves left to right”; props `moon_disc`, `pennant_triangle`, `window_square`; symbolic lock `one_example_per_shape`; motion “very slow pan”; plus a world block describing the three lantern pedestals.
- `SOURCE_IMAGE_QA_BLOCKER`: moon, triangular pennant, and square window were absent; three shape lanterns were substituted.
- `KLING_PROMPT`: character lock + appearance/gaze action + pan + symbolic example lock + world continuity preserving lantern garden/pedestals. No video was emitted.
- `TEMPORAL_QA_BLOCKER`: none.
- `WHICH_CONSTRAINT_WAS_MISSING`: immutable identity for each real-world example, exact one-per-example count, separate named alcove position, and an explicit ban on lantern substitution.
- `WHICH_CONSTRAINT_WAS_AMBIGUOUS`: “three spaced examples appear” did not say they must already exist in the canonical first frame; the shared world continuity strongly favored the earlier lantern trio.
- `UNNECESSARY_MOTION_REQUESTED`: camera pan plus gaze shift; neither is required to prove object identity.
- `OBJECTS_MODEL_WAS_ALLOWED_TO_INVENT`: three lantern substitutes and generic alcove contents.
- `ROOT_CAUSE_CLASS`: `SOURCE_IMAGE_INCOMPLETE`, `SOURCE_IMAGE_AMBIGUOUS`, `PROMPT_UNDERSPECIFIED`, `OBJECT_COUNT_UNLOCKED`, `SCENE_TOO_COMPLEX`, `OTHER:OBJECT_IDENTITY_UNLOCKED`.

### s27

- `SCENE_ID`: `s27`
- `EDUCATIONAL_OBJECTIVE`: child selects the round lantern from exactly three fixed options during a real 2.5-second pause.
- `SOURCE_IMAGE_PROMPT`: exactly three options, circle-left/triangle-center/square-right; source Visual QA `PASS`.
- `SOURCE_IMAGE_QA_BLOCKER`: none.
- `KLING_PROMPT`: child-listening pose + `1.5%` push-in + blink + breathing + symbolic fixed-option lock + generic geometry/camera/negative blocks.
- `TEMPORAL_QA_BLOCKER`: triangle and square rotated edge-on, lost readable side counts, and did not remain fixed answer options.
- `WHICH_CONSTRAINT_WAS_MISSING`: closed motion allowlist; explicit front-facing orientation; object rotation prohibition; exact end state matching the start inventory, counts, geometry, positions, and visibility.
- `WHICH_CONSTRAINT_WAS_AMBIGUOUS`: “remain fixed” constrained position but did not unambiguously freeze orientation; “only restrained planned camera movement” still left transformation freedom.
- `UNNECESSARY_MOTION_REQUESTED`: breathing plus generative push-in; the response pause only needs a blink. Push-in can remain editorial if required.
- `OBJECTS_MODEL_WAS_ALLOWED_TO_INVENT`: object rotations, edge-on orientations, option reconfiguration.
- `ROOT_CAUSE_CLASS`: `PROMPT_UNDERSPECIFIED`, `TOO_MUCH_MOTION`, `GEOMETRY_UNLOCKED`, `CAMERA_TOO_COMPLEX`.

### s29

- `SCENE_ID`: `s29`
- `EDUCATIONAL_OBJECTIVE`: close with Lumi and recap the same circle, triangle, and square intact.
- `SOURCE_IMAGE_PROMPT`: three final lanterns with Visual QA `PASS`.
- `SOURCE_IMAGE_QA_BLOCKER`: none.
- `KLING_PROMPT`: one wave + wing shimmer + slow pull-out, while asking props not to move and the group not to reconfigure.
- `TEMPORAL_QA_BLOCKER`: triangle and square rotated edge-on and the final prop group reconfigured.
- `WHICH_CONSTRAINT_WAS_MISSING`: closed action list, front-facing orientation lock, explicit ban on object rotation, and final-frame equality for counts/geometry/positions.
- `WHICH_CONSTRAINT_WAS_AMBIGUOUS`: “no group reconfiguration” did not define the required final arrangement; the pull-out invited scene recomposition.
- `UNNECESSARY_MOTION_REQUESTED`: wing shimmer and pull-out in addition to the wave.
- `OBJECTS_MODEL_WAS_ALLOWED_TO_INVENT`: object rotations, depth/order changes, recomposed prop group.
- `ROOT_CAUSE_CLASS`: `PROMPT_UNDERSPECIFIED`, `TOO_MUCH_MOTION`, `GEOMETRY_UNLOCKED`, `CAMERA_TOO_COMPLEX`.

## Cross-scene conclusion

No evidence supports `QA_FALSE_POSITIVE` or `CHARACTER_ANATOMY_UNLOCKED` as the cause of these six blockers. The dominant failure was contract compilation: symbolic locks and prose intent were not converted into a closed, machine-checkable start state, source-readiness proof, motion allowlist, camera contract, and end state before provider claim.
