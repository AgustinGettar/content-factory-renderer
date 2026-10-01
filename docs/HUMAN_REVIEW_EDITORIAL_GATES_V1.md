# Human-review editorial gates V1

Scope: permanent future-preset rules plus the zero-provider repair plan for “Lumi y el jardín de las formas”. No provider call, repair, TTS, edit, or master is created by this design.

## Character text exclusion

`TEXT_OVER_LUMI=FORBIDDEN` applies to captions, educational words and numbers, labels, questions, graphics, stickers, and educational UI. The layout engine receives Lumi's bounding box or safe region, critical educational-object boxes, the frame safe area, and candidate text boxes.

Candidate layouts are evaluated at successively smaller readable scales. A valid placement must remain inside the frame safe area and have exactly zero overlap with Lumi and every critical educational object. The priority is Lumi visibility, then educational-object visibility, then text. If no region survives, optional text is suppressed or required text fails layout; Lumi is never covered.

Required QA before master:

- `TEXT_CHARACTER_OVERLAP=0`
- `EDUCATIONAL_OBJECT_OVERLAP=0` when the object is pedagogically critical
- `SAFE_AREA=PASS`
- `READABILITY=PASS`

## Pedagogical pause labels

The pause is timing metadata, not visual content. Captions and overlays suppress `PAUSA`, `Pausa`, `pause`, and technical equivalents (`wait`, `hold`, `espera`). Canonical narration remains independent: if the approved script speaks a term, audio may retain it while the editorial text layer suppresses it.

During `s27`, the frame keeps the question and the three fixed answer shapes. It adds no technical pause label. Required QA: `PEDAGOGICAL_PAUSE_TECHNICAL_LABEL_VISIBLE=false`.

## Natural pacing

The target is `PERCEIVED_PLAYBACK_SPEED=NATURAL_1X`. This is solved at scene planning, dialogue density, Kling direction, clip choice, transitions, silence, holds, and selective retiming—not by uniformly accelerating a finished master.

Every compiled Kling prompt requests natural real-time movement, normal conversational gesture speed, and natural blink/head/hand timing. It forbids slow motion, dreamy slow movement, and prolonged pose holds. `s27` is the sole declared exception: an exact 2.5-second child-response window with a static camera and one natural blink.

The episode target is content-driven: 43–47 seconds, with a 45.5-second working estimate. It must not be stretched to the old 49-second target. Before master, QA reports `STATIC_HOLD_DURATION`, `UNNECESSARY_SILENCE_DURATION`, `AVERAGE_TRANSITION_DURATION`, `MOTION_PACING`, and `PERCEIVED_SPEED`; unjustified `SLOW` blocks the master.
