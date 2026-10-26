# Lumi: Editor y Resultados V1

Fecha de intervención: 26 octubre 2026. Rama autorizada `lumi-telegram-review-v1`. Base remota `88a4def272bc006b409533b10fc908f74bdd59ee`; live inicial `7467aac20b6ff17867e9e9be998582d421f580c0`. No restauraciones ni cambios de main/producción.

## Lo que puede usar el propietario

Studio → Editor → Crear candidata con medios existentes, o abrir una guardada. Importa fuentes privadas verificadas por SHA y streams medidos. Video continuo con ripple explícito; solo voces vinculadas siguen al reordenar. Voz independiente y recorte de fuente son operaciones distintas. Cursor, zoom/gesto, tiradores, orden numérico, división, quitar/undo, gain/mute/fades por elemento/pista, anotaciones y comparación de revisiones. Fuentes sin asociación narrativa se eligen explícitamente; una mezcla se identifica como mezcla. Ausencias quedan visibles, nunca se inventan clips. Un master mezclado se puede revisar y editar como referencia; exportar exige recuperar clips originales y no encadena recodificaciones de masters.

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

VFR/PTS: fuente local de5s con start_time3.000000 y avg_frame_rate450/19; manifiesto y export coinciden en240000ticks/5s.

Signal fixture: offset export0.600021s, gain-3.00584dB, tolerancia audioAAC5ms y video1frame. Chromium145.0.7632.6 en CI, Linux390×844 touch: feedback caliente del control de zoom máximo15ms, mediana14.8ms/12cambios en el CI final (44ms en el CI previo); onset de salida preview0.615964s para0.600s. Chromium153 local también pasó sin override de autoplay. Tolerancia de preview declarada130ms, no equivalencia con Safari/iPhone. Evidencia browser final en artefacto CI y JSON adjunto en `docs/lumi-improvement`. Prueba iPhone/Telegram real pendiente. Carga de render staging y analytics reales se registran después del despliegue en `visual-studio-deployment.json`, sin inferirlas de fixtures.

EP004 conserva q41–q46, image:q47, USD8, historial, grants, reservas y ledger. No se reinicia q47 ni operaciones ambiguas. Checksums y ventana segura antes/después quedan registrados. No se certifican ahora tres episodios reales completos.

Fuentes técnicas revalidadas: [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html), [ffprobe](https://ffmpeg.org/ffprobe.html), [Telegram WebApps](https://core.telegram.org/bots/webapps), [Instagram](https://help.metricool.com/instagram-metrics-ght51), [TikTok](https://help.metricool.com/tiktok-metrics-fe7io), [YouTube](https://help.metricool.com/youtube-metrics-k8haa), [guía Metricool](https://help.metricool.com/your-metrics-in-metricool-full-guide-pcwam).


## Lectura real del backend y fuentes de staging

El despliegue inicial4b19d905 ejecutó el MCP oficial con las credenciales independientes ya autorizadas en Render. Observación26Oct2026 00:23:17.210Z /01:23:17 Europe/Rome; marca7627207, dueño5949429 y las tres cuentas verificadas. Schema SHAe7e768f450441168737fab3845ac41adb3ecbdd710ea4cae3d2519ac00f5eef9. Evidencia detallada entregada al propietario como archivo privado `Lumi-metricool-lectura-backend.json`; no se incluyen valores privados en este repositorio público. No son fixtures ni resultados del conector ChatGPT.

| Red | Publicaciones devueltas | Rendimiento observado | Ausencias y límites |
| --- | ---: | --- | --- |
| Instagram/reels | 2 | Vistas, likes, alcance, guardados y compartidos disponibles | Retención null; tiempo medio disponible con unidad no acreditada por schema, visible como pendiente |
| TikTok/posts | 2 | Vistas, likes, comentarios y compartidos disponibles | Alcance, vistas completas y tiempo total null; schema acredita segundos para tiempo total |
| YouTube/videos published in range | 3 | IDs y enlaces reales | Todos los valores de rendimiento pedidos null; una fecha diaria20260930 fuera del rango, conservada sin atribuir causa |

Periodo de publicaciones1–26octubre con cambios DST Rome y límites UTC persistidos. Valores acumulados, no actividad limitada a ese periodo. `provider_as_of` no devuelto; no se afirma actualización en tiempo real ni se inventa fecha de corte. No se usaron IGRE13/15. Ningún post se asoció a EP004 o Flores por parecido; los7 siguen sin episodio asociado. Preparar parte2/3 requiere esa comprobación del propietario. La prueba aislada sí cubrió vínculo exacto, borrador editable, reapertura en Preparar e idempotencia sin grants ni proveedores.

Importaciones reales en namespaces candidatos mediante CAS del operador, por autorización de este encargo; no representan un login Telegram ni aprobación humana. `edit_ep004_visual_20261026` recuperó6 originales SHA verificados, q41–q44 de4.041667s y q45–q46 de5.041667s. q47 y voz faltan. `edit_flores_visual_20261026` abrió el master mezclado; los6 clips y3 referencias de audio no están disponibles en el staging autorizado. El bucket de audio histórico tampoco existe allí. Los originales locales de la demostración no se copiaron ni vincularon falsamente al catálogo. El bloqueo de exportar una mezcla como original permanece.

La actualización final de unidades conserva también `null` y ausencia de minutos con unidad normalizada segundos, manteniendo la unidad original del proveedor. No altera los snapshots históricos: una nueva lectura conserva su propia procedencia.


## Carga real de Render Free

Una sola candidata parcial de26.4s,6 originales/40,795,165bytes, revisión1 y SHA de manifiesto21de5b8cdb85cca39fab3a917d45010cdb855fa5805d777ecd1bc0711c28f35d. Job964f017bcac361c29a2bacad19997cf7fa7076a11fae31f8171d66d90c6e2850 reclamado00:24:44.109Z. A00:33:52Z se observó `NEEDS_ATTENTION / EDITOR_JOB_FAILED`, sin resultado persistido. Timeout del encoder480s; el recibo actual no expone la causa del proceso, por lo que no se declara OOM, problema de internet ni un instante exacto de timeout confirmado. No se relanzó ni duplicó el encode.

Muestreo de Render cada30s: memoria máxima observada464,457,730bytes (442.94MiB), límite536,870,900bytes; CPU máxima observada0.15 unidades del proveedor. No equivalen a picos instantáneos. Dos peticiones desde Work durante el encode devolvieron200: health4.429s y HTML5.504s, incluyendo red/servidor. Son distintas de la latencia local del control de zoom. Datos en `visual-studio-render-free-metrics.json`.

El proyecto sigue READY/revisión1 y los originales se conservan. Esta carga no acredita exportación completa en staging: la correspondencia audiovisual está demostrada con archivos existentes en ejecución local, y con señales/handlers reales en CI aislado. No se declara aceptado el recorrido completo en iPhone ni tres episodios reales. No hubo contratación, ampliación de plan, generación o cambio de calidad para disimular el resultado.


## Código, CI y despliegue comprobados

Código final `3b510a84797b4faeee6114f120db41d556059a04`, [CI40249253646 GREEN](https://github.com/AgustinGettar/content-factory-renderer/actions/runs/40249253646), artefacto de navegador12619587953. Deploy final `dep-dbfa047avr4c73dbtm50` LIVE26Oct00:35:01.225512Z, `/lumi/studio/api/readiness` devuelve exactamente ese SHA y `TELEGRAM_ED25519`. Primer deploy4b19d905 y su CI40248260310 también quedaron comprobados; las tres piezas JS nuevas servidas coinciden por SHA. Rutas privadas editor/results401 anónimas. Ningún despliegue ocurrió durante un transporte/encode activo. Documentación posterior no provoca redeploy.

El CI usa handlers, CAS, DOM y FFmpeg reales con identidad y proveedores aislados; no es una sesión Telegram real. Prueba de audio conocido: offset0.600021s y-3.00584dB; demo con fuentes existentes:0.600000s y-3.00398dB. Las fuentes5s no se limitan a3s. La pila undo no sobrevive a reapertura completa; sí la última revisión y el borrador local pendiente.

Siguiente acción del propietario: Studio → Resultados → comprobar una publicación real y guardar su vínculo con el episodio/version exactos. Esa confirmación habilita preparar la continuación sin generar ni gastar.

Relectura final del código live:26Oct00:36:25.937Z /01:36:25 Europe/Rome, nuevamente2IG/2TikTok/3YouTube. Dos snapshots reales separados por minutos; no acreditan tendencia ni comparación24h/72h/7d. TKPO14 conserva null con unidad segundos; YTVP07 conserva null con unidad normalizada segundos y provider_unit minutos. IGRE24 sigue con unidad pendiente. Hashes finales de episodios, grants, acciones, reservas, ledger y14filas del journal iguales a la base; q47 pendiente y techo8 sin cambios.
