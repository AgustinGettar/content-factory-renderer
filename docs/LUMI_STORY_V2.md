# Lumi: escenas por capas y dirección de voz

El render anterior de producción ensamblaba imágenes fijas. Los pilotos de Blender estaban aislados y no animaban los videos de Make. Además, el guion pedía 3D y la ficha del personaje pedía colores planos y prohibía accesorios; algunas narraciones incluían literalmente «Pausa...».

La referencia aportada es una grabación de 42,83 s de un video de conteo con personajes 3D, objetos, números grandes y cambios de plano. Se inspeccionaron fotogramas; la herramienta de esta sesión no admite audición directa. No se ha validado una equivalencia auditiva con esa voz.

## Comportamiento nuevo

- `lib/lumi-prompts.js` reúne guion, esquema JSON estricto, fondo, identidad y dirección TTS. El modelo y la voz siguen siendo `gpt-4o-mini-tts` / `marin`. Narración hablada cálida con entonación musical; este perfil no genera una canción.
- Ocho escenas, una habilidad y un foco por escena. El texto hablado no contiene instrucciones de actuación. Una pregunta deja 2 s reales de respuesta, más el margen de cola común.
- `metadata.production` declara versión, rol, silencio y foco. Make lo serializa con `toString` hacia el campo JSONB existente. El generador de fondos no redibuja a Lumi; el motor utiliza sus dos imágenes canónicas existentes.
- Fondo, Lumi, parpadeo y foco se componen por separado. La varita tiene un destello durante las respuestas; hay movimiento corporal suave del recorte completo. Letras, figuras, colores y cantidades se dibujan de forma determinista, sin pedir tipografía a la IA. Los conteos usan estrellas y una cantidad por escena.
- El audio decide la duración: redondeo hacia arriba a 30 fps, silencio explícito y 0,2 s de cola. No se acelera ni recorta la voz. Los intermedios animados usan PCM; el video completo se normaliza a objetivo −16 LUFS / −1,5 dBTP y codifica a AAC una sola vez.
- La vista previa congela los metadatos, tiempos y hashes del personaje además de las imágenes y la voz. Editar la producción invalida la aprobación. El HD usa ese mismo manifiesto. Los manifiestos anteriores conservan el compositor estático.

## Activación

1. Aplicar `20260915162153_lumi_story_production_snapshot.sql` (aplicada el 15-09-2026).
2. Desplegar este código; `/health` debe informar `story_renderer: lumi-story-v2`.
3. Actualizar LUMI 03 con `STORY_IMAGE`; LUMI 02 con `STORY_SCRIPT`, `STORY_SCHEMA`, máximo 6000 tokens y `metadata: {{toString(9.metadata)}}` en Create Scene. LUMI 04 y `characters.voice_profile.instructions` usan `LUMI_TTS`.
4. Generar una idea nueva para revisión LD. La aprobación manual sigue siendo necesaria para HD y publicación.

## Validación y límites

Pruebas locales reales FFmpeg: composición, variación de fotogramas, 360×640 y 1080×1920 a 30 fps, silencio al final de la voz, duración de ambos flujos y caracteres especiales. Se mantienen los tests de aprobación y seguridad. La migración se prueba con cambios de metadatos dentro de una transacción revertida, sin modificar videos existentes.

Esto es animación 2.5D por recortes: NO es un rig corporal articulado ni sincronización labial fonema por fonema. No produce actuación 3D ni canto como una producción musical de estudio. Para ese siguiente nivel hace falta crear y aprobar un rig o clips de actuación de Lumi, y una voz cantada/música originales. Tampoco se garantiza una duración exacta de 45 s desde TTS: el objetivo se guía con el guion, pero la duración real y las pausas se conservan. La calidad subjetiva de la voz y la coherencia artística de cada fondo deben revisarse en la vista previa.

Fuentes técnicas: [OpenAI TTS](https://developers.openai.com/api/docs/guides/text-to-speech), [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html), [Supabase functions](https://supabase.com/docs/guides/database/functions).
