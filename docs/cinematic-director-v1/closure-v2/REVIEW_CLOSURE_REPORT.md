# LUMI CINEMATIC DIRECTOR V1 — ENDPOINT EVIDENCE BLOCKER PRESERVED

Esta revisión continúa desde local `9cc81f71bf431a79d78c5b13c8664d37a2d00e6c` y remoto `3935b9ab47d47e1f8fc9d1178d4f882b7117b32d`, árboles exactos. No se reaplicó ningún ZIP. LAST_COMPLETED_ACTION recuperada: bindings auténticos, replay canónico y CI 37358116848 verde (200 tests). FIRST_PENDING_ACTION recuperada: revisión visual completa y evidencia de endpoint antes de staging.

## Trabajo ejecutado

SHA original y full decode verificados nuevamente. Inspección estática de los **97 frames de cada MP4** en secuencia, comparación con fuentes y ampliación de las ventanas de riesgo. Los manifests FRAME_COVERAGE registran hashes y timestamps de cada frame. Son derivados QA, no fuentes originales. **Reproducción perceptiva a velocidad nativa no realizada**: la herramienta visual utilizada presenta imágenes estáticas; ni ffmpeg ni las planchas certifican el ritmo a 1×. FULL_VISUAL_REVIEW no es PASS.

| Plano | Evidencia y decisión |
|---|---|
| q31-PRO2 | Aprobación humana preservada. Saludo restringido, contacto visual, respuesta pequeña de cabeza/alas, cámara sin desplazamiento perceptible. Asentamiento observado aproximadamente 2.708–3.417 s; hold final hasta 4.042 s. No se inventaron grados de giro. La fuente y el clip muestran un contorno amarillo bajo el brazo izquierdo de pantalla que exige reconciliar el nuevo lock, sin revocar la aprobación histórica ni ampliarla. Golden GREETING solamente. |
| q32 | Fuente sin masa posterior separada: PASS para ese defecto. No se puede cerrar el **Source Gate V2 completo** por el pequeño contorno inferior de alas: la aceptación de q31 no se hereda. Video: POSTERIOR_BODY_MUTATION. Precursor parcialmente ocluido frame 20 / 0.833 s; primer volumen inequívoco frame 75 / 3.125 s; peor frame 80 / 3.333 s; persiste hasta frame 96 / 4.000 s. Visibilidad inequívoca 22 frames / 0.917 s. El volumen está debajo de las alas y fuera del overol; no se explica como sombra o solapamiento alar. SOURCE_REUSE sigue REVIEW_REQUIRED por alas, no por masa posterior en la fuente. |
| q33 | Fuente BLOCKER: REAR_BULB, volumen amarillo detrás de mano izquierda de pantalla fuera del overol. SOURCE_STRIPED_ABDOMEN no confirmado. Video: defecto heredado desde frame 0 y TEMPORAL_STRIPED_ABDOMEN desde frame 69 / 2.875 s, máximo frame 89 / 3.708 s, sin recuperación al final. SOURCE_REGEN_REQUIRED + VIDEO_REPAIR_REQUIRED. |

## Integración y pruebas

Se reutilizan `runLumiV2Step → reviewAtCanonicalBoundary → compileDirectorPacket`, V3 de diez bloques, el contrato V2 y los gates existentes. Sin dispatcher, proveedor o sistema nuevo de aprobación. Feature flag OFF y legacy intactos. La integración sigue restringida a `local_offline`; **no es una prueba de staging**.

Cambios mínimos: gramática GREETING explícita (proyección/gramática revisión 2), política PRESENT_OBJECT de no añadir rotación corporal/torso/hombro, cobertura topológica de fuente/primer frame/temporal/máximo riesgo/final/playback, auditoría de campos solicitados e invalidación creativa incluyendo políticas. Los ceros de rotación son objetivos normativos, no ángulos medidos ni garantías del modelo. Actuación pendiente de aprobación por plano.

Se ejecutaron **233/233 tests PASS**, incluyendo 33 nuevos, V3, feature flag OFF, topología, actuación, capacidades, generalización a otras escenas/objetos y regresión relevante. El guard bloquea red/clientes generativos. Replay auténtico por entrada canónica ejecutado dos veces por plano con fingerprints idénticos, cero intentos salientes y payload siempre nulo. Clasificaciones: q31 ACCEPT_COMPATIBLE_WITH_HUMAN_GOLDEN; q32 CONTROLLED_REPAIR_REQUIRED; q33 SOURCE_REGEN_AND_VIDEO_REPAIR_REQUIRED. Estas clasificaciones no hacen despachables los paquetes.

## Evidencia de endpoint

Consulta ampliada `models_get(kling3_0)` confirma modos std/pro/4k, duración 3–15, sound on/off, roles start_image/end_image y ratios 16:9/9:16/1:1 **del conector**. Se mantiene separado del endpoint directo usado: `higgsfield_api / kling-video/v3.0/pro/image-to-video`. El directo documenta prompt, image_url, sound, duración entera 3–15, cfg_scale 0–1 y multi_shots. No se copian `mode`, `aspect_ratio`, `resolution` ni `mask` al request directo.

Referencia oficial reconsultada 2026-10-05: https://open.higgsfield.ai/models/kling-video/v3.0/pro/image-to-video/api-reference . El título/path Pro y requests persistidos prueban selección de Pro aunque falte echo; una línea errónea de prosa Standard se conserva como limitación documental. El resultado nativo 1080×1916/1912 no garantiza 9:16 exacto. No se normalizaron originales.

Sobres RECOVERED_REQUEST_ENVELOPE creados con procedencia por campo. Endpoint, job, SHA, storage y metadatos de salida recuperados. Prompt/hash, timestamp de envío y valores completos de submission permanecen indisponibles. `created_at` se rotula registro de finalización, no hora de submission; hash del payload de cotización no es hash del prompt. Campos no críticos ausentes no bloquean por sí solos. Los límites de prompt y medios del endpoint exacto siguen sin evidencia suficiente; no se inventó máximo universal. Estimador existente identificado, sin cotización nueva ni generación.

## Bloqueos abiertos y staging

1. Full playback a velocidad nativa pendiente. Los 291 frames inspeccionados no equivalen a esta revisión.
2. q32: resolver contorno inferior de alas bajo NO_EXTRA_WING_LOBES; no trasladar warning de q31. q31: POLICY_CONFLICT entre contorno aprobado histórico y uso futuro del lock estricto, sin cambiar el artifact aprobado.
3. Contratos auténticos recuperados conservan hashes de Character/World Lock nulos y faltan roles golden y aprobaciones verificadas requeridos por V2. El compilador devuelve SCHEMA_VALID=false y SOURCE_EVIDENCE_READY=false. No se rebajó ni cambió el contrato para forzar un PASS.
4. Prompt/media limits del endpoint directo sin confirmar; CAPABILITIES_VERIFIED=false. Envelopes históricos parcialmente recuperados; no se afirma reproducir el request original.
5. Paquetes R3 son borradores auditables bloqueados: sin prompt despachable, sin transporte inventado, sin nueva aprobación humana, presupuesto ni autorización.
6. Staging NO EJECUTADO porque los gates anteriores no pasaron. No es un deploy fallido. Además Render exige confirmar el workspace; `list_services` rechazó la consulta sin selección. Workspace disponible reportado antes: `My Workspace` (`tea-dahl5nh594qs73ffjhcg`), todavía no confirmado por el usuario.

La cotización actual de una reparación q32 no se solicitó: el usuario la condicionó a readiness completo. Referencias históricas USD 0.381 video y USD 0.608 imagen+video no son cotizaciones actuales ni autorización. Reparación q32 mínima sugerida: un video si Source Gate V2 aprueba reutilización; q33: fuente nueva y luego video. No se ejecutó ninguna.

NEXT_ACTION=CLOSE_VISUAL_SOURCE_AND_ENDPOINT_EVIDENCE_GATES; no AUTHORIZE_ONE_CONTROLLED_Q32_DIRECTOR_REPAIR todavía.

PRODUCTION_ACTIVATED=false; PROVIDER_CALLS=0; IMAGE_CALLS=0; VIDEO_CALLS=0; TTS_CALLS=0; NEW_GENERATION_COST=0; NEW_MEDIA_GENERATED=0; MASTER=NOT_CREATED; EPISODE_RESUMED=false. Se crearon únicamente derivados locales de inspección y documentos.
