# Lumi Animated v1

## Goal
Build a repeatable 2D preschool mini-series format for YouTube Shorts/Reels that is more engaging than narrated static images while staying consistent, inexpensive to render, and scalable.

## Stage 1 — Stable vertical output
The current production renderer must remain a strict full-screen vertical baseline:

- 1080x1920
- 9:16 by geometry, not by display-aspect overrides
- square pixels (SAR 1:1)
- no letterboxing
- no camera-motion filters in the stable renderer
- unique output URL per render

This stable renderer is the fallback and quality-control reference.

## Stage 2 — Character asset pack
Create Lumi as reusable transparent PNG layers rather than one flattened scene.

### Required Lumi v1 layers
1. body_base
2. wings_back
3. wing_left
4. wing_right
5. eyes_open
6. eyes_blink
7. mouth_closed
8. mouth_small
9. mouth_open
10. arm_left_down
11. arm_left_up
12. arm_right_down
13. arm_right_up
14. happy_expression
15. surprised_expression
16. thinking_expression

All layers must share the same canvas, pivot alignment and character proportions so they can be swapped without repositioning.

## Stage 3 — Reusable backgrounds
Minimum pack:

- classroom_day
- classroom_board
- park_day
- farm_day
- bedroom_soft
- color_world

Backgrounds should be 1080x1920 master compositions or larger 9:16 sources.

## Stage 4 — Educational props
Reusable transparent assets:

- numbers 0-10
- alphabet A-Z
- circle / square / triangle / star / heart
- primary and secondary color cards
- apple / banana / orange / strawberry
- cat / dog / cow / duck / sheep
- ball / book / pencil / toy blocks
- stars / sparkles / question mark / check mark

## Stage 5 — Animation primitives
Lumi Animated v1 should initially support only cheap, deterministic motion:

- blink
- mouth open/close rhythm
- wing flutter
- gentle character bob
- arm pose swap
- prop pop-in
- prop bounce
- slide-in / slide-out
- scale punch
- text pop
- simple background parallax

Avoid AI video generation as the primary renderer. It is less consistent and more expensive.

## Stage 6 — Scene templates

### intro
Lumi enters, greets the child and introduces the topic.

### teach_one
Lumi + one large educational prop + highlighted keyword.

### choose_two
Two answer options, short pause, then reveal.

### count_objects
1-5 repeated objects enter with small bounce timing.

### color_match
Object + color card + spoken prompt.

### animal_sound
Animal asset + name + optional sound effect.

### celebration
Stars/confetti + Lumi happy pose + positive feedback.

### outro
Short recap + invitation to watch another episode.

## Stage 7 — Scene data contract
Future scene rendering should be driven by structured data instead of a fully flattened image.

Example:

```json
{
  "template": "choose_two",
  "background": "classroom_day",
  "character": {
    "id": "lumi",
    "pose": "happy",
    "position": "left",
    "blink": true,
    "mouth_sync": true
  },
  "props": [
    {"asset": "apple", "position": "center_left", "animation": "pop"},
    {"asset": "banana", "position": "center_right", "animation": "pop"}
  ],
  "text": "¿Cuál es amarillo?",
  "narration": "¿Cuál de estas frutas es amarilla?"
}
```

## Stage 8 — Renderer direction
Recommended long-term visual renderer: Remotion (React) or another deterministic timeline renderer.

FFmpeg remains useful for:

- final encoding
- concatenation
- audio normalization
- muxing
- final validation

The animation system should not depend on expensive generative video for every scene.

## Stage 9 — Channel quality rules
Every episode should have:

- a visual change in the first second
- one learning objective per Short
- no long static holds
- clear preschool-safe language
- consistent Lumi design
- 2-4 meaningful visual events per scene
- readable text in the safe central area
- total duration driven by retention, not arbitrary filler

## First pilot
Build one 3-scene Lumi Animated pilot before migrating the full pipeline:

1. intro — Lumi greets the child
2. interaction — choose between two colors/objects
3. celebration — correct answer + stars + Lumi reaction

Use the existing narration/TTS pipeline, but render the visual layer from reusable character/background/prop assets.
