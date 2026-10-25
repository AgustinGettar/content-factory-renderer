# Lumi: Editor y Resultados V1

Fecha de intervención: 26 octubre 2026. Rama autorizada `lumi-telegram-review-v1`. Base remota `88a4def272bc006b409533b10fc908f74bdd59ee`; live inicial `7467aac20b6ff17867e9e9be998582d421f580c0`. No restauraciones ni cambios de main/producción.

## Lo que puede usar el propietario

Studio → Editor → Crear candidata con medios existentes, o abrir una guardada. Importa fuentes privadas verificadas por SHA y streams medidos. Video continuo con ripple explícito; solo voces vinculadas siguen al reordenar. Voz independiente y recorte de fuente son operaciones distintas. Cursor, zoom/gesto, tiradores, orden numérico, división, quitar/undo, gain/mute/fades por elemento/pista, anotaciones y comparación de revisiones. Fuentes sin asociación narrativa se eligen explícitamente; una mezcla se identifica como mezcla. Ausencias quedan visibles, nunca se inventan clips.

El player usa WebAudio como reloj, buffer PCM estéreo derivado y proxy privado360x640. Derivados por SHA/receta, secuenciales, limitados; originales no se cargan todos al abrir. Un seek detiene y posiciona; cortes/seeks resincronizan video. Se pausa en buffering/ocultación. DOM de video preservado al guardar. Precisión de preview depende del navegador; no se promete frame-perfect ni audio inaudible durante un cambio de fuente. Solo corte limpio, sin efectos/fundidos visuales ofrecidos.

Guardar crea una revisión con command_id estable y base_revision CAS. ACK perdido se reconcilia; otra pestaña no se pisa. Conflicto conserva la edición como alternativa antes de abrir servidor. Copia local mínima segregada por propietario/proyecto, sin fuentes/URL/tokens; almacenamiento deshabilitado no impide guardado en servidor. Undo/redo existe en la apertura actual; reapertura recupera última revisión y borrador pendiente, no toda la pila undo.

Renderizar es otra acción: trabajo durable en la cola existente y misma revisión/SHA aunque luego se siga editando. Se conservan los resultados por versión. Se recupera un resultado subido antes del ACK sin otro encode. Fuentes originales → encoder FFmpeg existente → una codificación final1080×1920 H264High CRF17/slow yuv420p AAC48k192. Video a30fps, reloj entero48000ticks/s (1600ticks/frame). Ajuste de último frame menor a1/30s, sin inventar acciones. Timeout8min, una instancia de encode editorial; espera si existe producción activa. No cambia master/reviews/grants/publicaciones históricas. Un preview parcial no se declara terminado.

La voz que no cabe con pausa/cierre produce conflicto editorial visible. Se permite un recorte deliberado dentro de fuente con motivo; extremos de voz requieren escucha explícita. Ningún control regenera TTS, acelera, reserva o compra. El camino automático permanece intacto; este editor no es paso obligatorio.

## Resultados y continuidad

Studio → Resultados carga la última lectura guardada; Actualizar desde Metricool solicita una lectura deduplicada del MCP autorizado por el backend, con identidad de marca/dueño verificada y OAuth independiente. Allowlist cerrada: getBrandSettings, getAnalyticsAvailableMetrics, getAnalyticsDataByMetrics. Sin uploads, scheduler ni escrituras remotas. Schemas revalidados; IGRE13/15 no se usan. TikTok usa posts. Reintento de429 limitado, máximo3intentos y respeto del retry-after hasta300s, únicamente lecturas. Worker oportunista existente, sin keep-alive, Make o nueva automatización.

Tarjetas por publicación y filtros red/versión; enlace canónico, snapshot/consulta/proveedor cuando exista, unidades/null/cero y alcance separados de views. El rango filtra fecha de publicación, no vistas dentro del intervalo. Se conservan fechas fuera de rango, conteos decrecientes y cobertura parcial. No sumas de snapshots/reach entre redes ni engagement global. Historia solo de observaciones reales; comparaciones24h/72h/7d insuficientes sin observaciones equivalentes. Una miniatura remota no se descarga por una URL arbitraria: cuando no hay fuente segura vinculada, se muestra ausencia.

Importaciones quedan SIN_EPISODIO_ASOCIADO. Vínculo manual exige confirmar episodio/version/SHA exactos; no se atribuye por títulos/fecha. Editar candidata no hereda resultados. Reglas versionadas conservadoras: insuficiencia/señal inicial; ninguna promesa ni inferencia de aprendizaje o corte por una media. Parte2/3 crea una sola preparación por serie/master/parte, con objetivo progresivo, continuidad, referencias reutilizables por revisar, material nuevo, evidencia y feedback. Techo autorizado0/grants vacíos. Abrir en Preparar conserva otro borrador en curso; calcular/preparar un plan tampoco autoriza producción.

Metricool conectado sigue sin equivaler a publicador operativo: faltan contratos acreditados de ingestión, permisos por red, cuotas y reconciliación de entrega. Se conserva el escritor cerrado; no se publican pruebas ni se usan enlaces temporales Telegram para entrega.

## Evidencia y límites

Tests reales del modelo, handlers autenticados/CAS, FFmpeg y DOM; proveedores externos aislados, transporte generativo bloqueado. La identidad del browser es fixture aislada, nunca sesión Telegram fingida contra staging. Fuente5s no truncada a3; voz+0.600s/-3dB; ripple/vínculos/split/undo; pausa2.5s/cola conflictiva; guardado/reapertura/ACK perdido/conflicto entre pestañas/almacenamiento no disponible/sesión vencida; render repetido no duplica. Datos:0/null/string/deprecados/unidad desconocida/DST, ausencias,429/expired, vínculo exacto, continuación idempotente sin grants.

`visual-studio-local-evidence.json`: fragmento local con q31-PRO2, q32-V2-PRO1 y LUMI_TTS_SECTION_1_INTRO_V1 de Flores; se quitan0.200s de entrada de q31, conservando cierre; voz completa desplazada+0.600s y-3dB.7.933333s, encode24.833s local, correlación audio0.999993, offset medido0.600000s, gain-3.00398dB. SHA salida8cb5a0807928453bff0d2b9e03eb3eec84e6b5dbae4c8403cc05c6be24dd0c2b. No aprobación ni episodio completo. Originales intactos.

Signal fixture: offset export0.600021s, gain-3.00584dB, tolerancia audioAAC5ms y video1frame. Chromium153/Linux390×844 touch: feedback caliente máximo13.4ms/12cambios en la corrida final; onset de salida preview0.60726s para0.600s. Tolerancia de preview declarada130ms, no equivalencia con Safari/iPhone. Evidencia browser final en artefacto CI y JSON adjunto en `docs/lumi-improvement`. Prueba iPhone/Telegram real pendiente. Carga de render staging y analytics reales se registran después del despliegue en `visual-studio-deployment.json`, sin inferirlas de fixtures.

EP004 conserva q41–q46, image:q47, USD8, historial, grants, reservas y ledger. No se reinicia q47 ni operaciones ambiguas. Checksums y ventana segura antes/después quedan registrados. No se certifican ahora tres episodios reales completos.

Fuentes técnicas revalidadas: [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html), [ffprobe](https://ffmpeg.org/ffprobe.html), [Telegram WebApps](https://core.telegram.org/bots/webapps), [Instagram](https://help.metricool.com/instagram-metrics-ght51), [TikTok](https://help.metricool.com/tiktok-metrics-fe7io), [YouTube](https://help.metricool.com/youtube-metrics-k8haa), [guía Metricool](https://help.metricool.com/your-metrics-in-metricool-full-guide-pcwam).
