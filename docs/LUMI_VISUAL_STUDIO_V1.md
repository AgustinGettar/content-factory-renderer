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


## Studio simple · 26 de octubre de 2026

Esta intervención modifica el Studio existente en `lumi-telegram-review-v1`, partiendo de `e48d4dd3d7377a68a297f0756a99c90b7dec9497`. El live observado antes de escribir seguía en `3b510a84797b4faeee6114f120db41d556059a04`. No es una nueva aplicación ni una certificación de exportación completa. El [recibo verificado de despliegue](lumi-improvement/simple-studio/deployment.json) identifica el código servido, CI y las protecciones comparadas.

### Cambios visibles

| Pantalla | Resultado | Funciones conservadas |
|---|---|---|
| Inicio | Resumen de hasta tres cifras, una tarea prioritaria, otros pendientes compactos y episodio actual. Ya no ejecuta `workflowPage()`. | Resultados detallados por «Ver resultados». Pausa por saldo, revisión pendiente y fallo de exportación son situaciones distintas. |
| Producción | Selector de episodio, «Editar» y recorrido Preparar → Producir → Revisar → Descargar. | Etapa, selección, revisiones, límites y controles operativos existentes. Entrar no inicia trabajos. |
| Biblioteca | Videos / Recursos sobre las colecciones existentes. Sin reproductores montados para toda la lista. | Descargas, procedencia, aprobaciones y contratos de reutilización. La ruta antigua `videos` abre esta colección. |
| Editor | Cabecera Volver, título y guardado; preview, tiempo, timeline con pistas presentes y controles según selección. Sin barra global. | Deshacer/rehacer, ajuste fino, recorte, offsets, ganancias, fades, notas, CAS, conflictos, versiones, importación y paquete; herramientas secundarias bajo «Más». |
| Resultados | Lista de publicaciones con vistas y likes; tocar abre detalle. Red visible, fechas bajo filtros. | Evidencia técnica cerrada inicialmente, vínculo exacto confirmado y una entrada de continuación con parte 2/3 y feedback dentro. |
| Cabecera | Ajustes discreto, con etiqueta accesible. | Rutas internas antiguas y lanzamiento validado de Telegram; la navegación no escribe sobre el hash de lanzamiento. |

La barra principal tiene tres entradas uniformes. El editor reabre un proyecto único del episodio; si hay alternativas exige elegir, sin importar una candidata al navegar. Salir pausa y libera lecturas y listeners pendientes, conserva selección, posición y borrador. «Guardado» requiere el recibo real. Recibo perdido mantiene el mismo comando; conflicto conserva una alternativa explícita.

Las vistas existentes de Biblioteca y Ajustes, junto al control de reintento nativo, se cargan como un módulo de presentación cuando se necesitan. El script inicial queda en 36.607 bytes gzip / 33.261 bytes Brotli, dentro de los límites previos de 36/33 KiB sin relajarlos. No hay un nuevo framework ni modelo de datos.

Inicio y Resultados leen snapshots guardados. El recorrido de aceptación hizo **una lectura de resultados y cero consultas a Metricool**. Otras lecturas del banco corresponden a recargar intencionalmente fixtures de ausencia y cobertura parcial. Null sigue siendo «—». Se deduplica publicación + red con una observación coherente; no se suman alcance, snapshots repetidos, unidades desconocidas ni coberturas incompatibles. Cuando Instagram orgánico y otra red no declaran la misma cobertura, el resumen permanece por red. Publicaciones cuenta posts. Fechas seleccionan publicaciones y los valores se rotulan acumulados.

### Comparativas y navegador real

[Comparador local](lumi-improvement/simple-studio/index.html). Capturas de módulos reales servidos en Chromium 145.0.7632.6, Linux, fixtures aislados: **no son capturas de iPhone ni de datos ficticios cargados en staging**. El antes sirve el frontend exacto `e48d4dd`; el después sirve el frontend modificado. Los handlers usan almacenes aislados. Colores de prueba de FFmpeg y tono local permiten comprobar reproducción sin generar contenido remoto. Las capturas publicadas no contienen fotogramas de originales privados.

| Pantalla | Antes | Después |
|---|---|---|
| Inicio | [PNG](lumi-improvement/simple-studio/before/inicio.png) | [PNG](lumi-improvement/simple-studio/after/inicio.png) |
| Producción | [PNG](lumi-improvement/simple-studio/before/produccion.png) | [PNG](lumi-improvement/simple-studio/after/produccion.png) |
| Editor en reposo | [PNG](lumi-improvement/simple-studio/before/editor.png) | [PNG](lumi-improvement/simple-studio/after/editor.png) |
| Audio seleccionado | [PNG](lumi-improvement/simple-studio/before/editor-audio.png) | [PNG](lumi-improvement/simple-studio/after/editor-audio.png) |
| Biblioteca | [PNG](lumi-improvement/simple-studio/before/biblioteca.png) | [PNG](lumi-improvement/simple-studio/after/biblioteca.png) |
| Resultados | [PNG](lumi-improvement/simple-studio/before/resultados.png) | [PNG](lumi-improvement/simple-studio/after/resultados.png) |

Se inspeccionaron personalmente alineaciones, espaciado, tipografía, cantidad de acciones y capturas. Se corrigieron un desborde de Inicio y una barra del editor que se superponía al inspector. La inspección final detectó cifras partidas con texto al 125%: ahora se reordenan las estadísticas completas, sin partir números ni etiquetas, con comprobación en 360, 390 y 430 px. Se verificó ausencia de scroll horizontal de página en 360×780, 390×844, 430×932 y 844×390; el timeline conserva su scroll. También se probaron texto aumentado y viewport reducido para representar el espacio del teclado. El teclado nativo, safe-area física, gesto de audio y ciclo de suspensión de Telegram en iPhone siguen pendientes.

[Recorrido y métricas de navegador](lumi-improvement/simple-studio/browser.json), [sincronía, CAS, undo/redo y exportación sintética corta](lumi-improvement/simple-studio/editor-contract.json). Estados guardados en `simple-studio/states`: sin datos, métricas parciales, sin voz, buffering, guardado pendiente, recibo perdido, conflicto, sesión vencida y exportación fallida. El antes de Editor está en v1 y el después en un proyecto ya existente v2 con voz agregada explícitamente en el fixture; no son la misma revisión editorial.

Recorrido ejecutado: Inicio → métrica → volver → episodio → Editor → reproducir → mover voz +0,6 s → −3 dB → recibo de autosave → volver → reabrir y comprobar → publicación. El segundo banco comprueba dos pestañas, recibo perdido, recarga, localStorage indisponible y rechazo por sesión vencida. El sonido medido comenzó alrededor de 0,616 s para la posición pedida de 0,600 s; los parámetros del manifest y de exportación coinciden. Los 12 ajustes ya cargados tuvieron feedback de 14,7 ms de mediana y 15,4 ms máximo en ese banco. No se extrapola ese resultado a un servidor suspendido.

### Causas acreditadas y correcciones de media

1. El código anterior preparaba secuencialmente todos los bundles; `play()` esperaba también decodificar los audios futuros. Ahora se prepara el video actual y, durante reproducción, como máximo el siguiente. Audio actual/inminente se prepara en una ventana acotada; no se omite una voz que todavía no esté disponible. Las formas de onda se calculan después de decodificar, fuera del requisito de primer play.
2. Las rutas anteriores cargaban y verificaban el archivo completo antes de recortar la respuesta Range. Ahora los descriptores verificados en ingestión/derivación se sirven por streaming autenticado: Range se envía a Storage, se comprueba 206/Content-Range/Content-Length/MIME y se propaga cancelación. HEAD no lee el cuerpo. La variante sigue privada; la URL firmada de 60 s se renueva en el servidor después de validar propietario, sesión y ticket. No se entrega esa URL al navegador ni se hace público el bucket.
3. Promesas de preparación se deduplican por propietario/proyecto/SHA/variante; receta versionada en la ruta. Se reutilizan bundles completos existentes. Poster pequeño y proxy se separan de thumbnails/formas de onda. Hay una sola transformación concurrente, caché de hasta 48 manifiestos en servidor, 32 bundles en cliente y un límite explícito de 48 MB de PCM decodificado. La calidad del master no cambia.
4. Buffering detiene video y reloj de audio juntos. La transición conserva la intención de reproducir y continúa sin `stop → play` global. Las respuestas viejas se ignoran y las lecturas se abortan al cambiar de proyecto. Reintentar solo renueva lecturas/previews; no crea una toma ni exportación. La prueba detectó y corrigió además que el reproductor nativo podía perder su posición al renovar una fuente.

Esto acredita esperas y defectos concretos. **No acredita una causa única para cada video que falló en Telegram.** La entrega Supabase/Render autenticada no se midió desde una sesión real de Telegram en esta intervención. El contrato Range se verificó con HTTP y upstream instrumentado local; no se afirma una latencia real de Supabase. Biblioteca y Producción conservan la calidad del original; si el navegador pide el rango completo puede recibir el MP4 completo por streaming, sin buffer/hash íntegro previo en cada reproducción.

### Mediciones declaradas

[Preparación antes/después](lumi-improvement/simple-studio/media-preparation.json): Node 24.22.1, FFmpeg local, 3 muestras frías y 3 calientes por estrategia; dos clips existentes SHA verificados más voz existente, sin red. «Antes» ejecuta `EditorMedia` del commit base y la preparación secuencial histórica de las tres fuentes. «Después» mide la preparación necesaria del primer video, no el trabajo eventual de toda la película.

| Medida | Antes | Después |
|---|---:|---:|
| Preparación fría, muestras | 4469 / 4190 / 4024 ms | 1369 / 1382 / 1361 ms |
| Mediana | 4190 ms | 1369 ms |
| Lecturas de originales para esa preparación | 3 · 10.422.019 bytes | 1 · 5.009.453 bytes |
| Derivados producidos | 1.239.270 bytes | 102.650 bytes |
| Proxy del primer clip | 85.876 bytes | 85.876 bytes |
| Bundle caliente en memoria | 0,01 ms | 0,02–0,08 ms |

Ambos proxies tienen `moov` antes de `mdat` (faststart). La cifra caliente es la consulta local de caché, no tiempo de primer frame en Telegram. RSS del proceso Node del benchmark fue aproximadamente 61–63 MB; no incluye pico del hijo FFmpeg ni memoria de Render.

[Reproducción de fuentes existentes](lumi-improvement/simple-studio/playback-existing.json): una muestra completa en Chromium/loopback, sin montajes largos. Apertura fría hasta frame: 1875 ms; proyecto 6,2 ms, bundle inicial 1539,1 ms, metadata 8,4 ms y primer frame tras bundle 13,4 ms. Poster 15.775 bytes y proxy 85.876 bytes, una lectura de cada uno antes de reproducir; el segundo clip no se descarga al abrir. Audio actual: 1.013.838 bytes; decodificación medida en el JSON. Seeks a 0,1 / 1,5 / 2,9 s: 16 / 34 / 50 ms, más comprobación de final del segundo clip a 5,85 s. Durante 500 ms de retención del segundo stream el reloj de audio no avanzó; continuó desde 3 s sin pulsar Play otra vez. Red simulada de 200 ms y 128 KiB/s: reintento 779 ms manteniendo 1,633 s. Se comprobó desconexión/reconexión y pausa/retorno por `visibilitychange`, que no equivale al ciclo real de iOS. Reintento nativo en Biblioteca conservó 0,288 s. Heap JS observado al cierre: 3.437.404 bytes; es una observación, no un máximo certificado.

El test HTTP de rangos usa un archivo de 4 MiB y tres rangos (inicio, medio, sufijo): 3072 bytes de upstream para 3072 bytes entregados; cero lecturas upstream en HEAD; 401 antes de acceder al objeto, 416 para multirango. Verifica que no se llama a `download()` en el camino streaming. El banco de aceptación con fuente sintética tuvo 625 / 56 / 89 ms de clic a video en marcha (primer audio frío, luego caché), shell visible a 117 ms mientras la lectura de resultados se demoraba 700 ms artificialmente. Son bancos distintos: no deben sumarse ni presentarse como promesa de arranque remoto.

### Exportación y protecciones

Se conserva `edit_ep004_visual_20261026`, revisión 1 y recibo `964f017b…e2850` en NEEDS_ATTENTION / EDITOR_JOB_FAILED, sin artefacto. Se muestra «No se pudo exportar; tu edición sigue guardada». El límite registrado de ocho minutos y ~443 MiB observados no permiten decidir entre OOM, timeout u otra causa. La consulta acotada de logs del intervalo 00:24:40–00:34:00 UTC no devolvió detalle adicional. Se agregó diagnóstico saneado a la ruta común: fase, exit code, señal, killed, límite aplicado, duración y últimas líneas útiles; no argumentos, URLs privadas ni secretos. No se reintentó el render real ni se modificaron CRF/preset/resolución del master.

Pruebas focalizadas: 191 tests de módulos afectados (un assert antiguo de reproductor siempre montado actualizado a carga explícita; el caso pasó después), 33 gates afectados más un caso HTTP saltado por guard offline, 40 UI/auth/Metricool, 4 reinicios, 9 Range/resultados/diagnóstico, bancos reales de navegador y exportación local sintética de 4,5 s. La regresión histórica de dos capítulos sintéticos también terminó una vez; no forma parte del circuito focalizado nuevo ni se usó para certificar el fallo de EP004. CI ejecuta además preparación y regresión editorial existente. El recibo final identifica el commit exacto y la conclusión de CI, sin confundir estas pruebas con producción completa.

La consulta de solo lectura mantiene episodios y acciones EP004 con los mismos hashes del inicio, `autorun=false`, `runner_enabled=false`, techo USD 8, pendiente `image:q47`, job NEEDS_ATTENTION y cero transporte activo. El estado histórico RUNNING de una operación no tiene lease; no se reenvía ni se interpreta como generación nueva. Se vuelven a comparar ledger, reservas, consentimientos y journal justo antes/después del deploy. Las revisiones de sesión que avanzaron por actividad legítima no se restauran. Render continúa Free, autoDeploy desactivado, Telegram DIRECT y publicador cerrado.

Cero generaciones remotas nuevas, TTS, reservas, recargas, compras, servicios, publicaciones, programaciones o cargas de media de prueba en staging. Sin cambios de Make, webhook, OAuth, secretos, main ni producción.

Fuentes contrastadas con Express 5.1.0, Supabase JS 2.57.4 y el JavaScript/HTML nativo instalado: [lazy loading de video](https://web.dev/articles/lazy-loading-video), [HTTP Range y HEAD](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests), [tab bars de Apple](https://developer.apple.com/design/human-interface-guidelines/tab-bars), [despliegues Render](https://render.com/docs/deploys), [health checks](https://render.com/docs/health-checks). Son criterios de implementación; no una certificación de accesibilidad ni de iPhone.

### Cierre de staging verificado

Código y SHA live: **`49c57d4e208397a16d998ceada6126d516b5cc62`**, sobre la implementación `6aeb6f2479cb225a6dfe39a6f655d3356f401340`. [CI GREEN del commit exacto](https://github.com/AgustinGettar/content-factory-renderer/actions/runs/40313332771), intento 2; artefacto `lumi-visual-editor-evidence` 12645873706. El primer intento se canceló al límite de 15 minutos: la instalación de FFmpeg tomó 14 min 48 s y el log registra 94,1 MB descargados en 14 min 35 s a 108 kB/s. No se redujeron pruebas ni se cambió código para el reintento. Este incidente de CI es independiente del fallo real de exportación EP004.

Render `content-factory-av2-staging`, Free, autoDeploy desactivado: deploy `dep-dbfjl32jnfac73cklgag` live a las **11:34:06 UTC del 26/10/2026**. Readiness devuelve el SHA esperado; los ocho archivos del frontend coinciden por SHA-256. `/lumi/studio` y `/lumi/studio/` responden 200. Sin sesión, state, lista/proyecto de Editor, Resultados y Biblioteca responden **401**. Health confirma servicio sano, cola vacía y ningún video activo. Estas comprobaciones no miden reproducción autenticada dentro de Telegram.

La ventana anterior y posterior tiene cero transporte, operaciones con lease, jobs de Editor y leases de episodios activos. Coinciden los hashes de episodios, proyectos, asociaciones, acciones, ledger, reservas, funding, autorizaciones, grants y journal EP004 (13 entradas). La revisión de sesión avanzó 4419 → 4425; ese avance se conserva. EP004 sigue con techo USD 8, autorun/runner desactivados, q47 pendiente, publicador cerrado y el job original en NEEDS_ATTENTION. El recibo conserva también las comprobaciones del primer deploy de la implementación.

Este informe y el recibo se guardan en un commit posterior de documentación; **no se redespliega por documentación**. La exportación completa de EP004 y las comprobaciones físicas de iPhone siguen pendientes. No se anuncia validación completa de Studio V1.

Comprobación humana final única: dentro de Studio en tu iPhone, recorré Inicio → episodio → Editar, reproducí un clip existente y volvé a Inicio; confirmá que la reproducción, el regreso y los controles se sienten claros, sin activar producción ni exportación.

## Pulido táctil del Editor · 26/10/2026

El usuario confirmó que pudo abrir el Editor del episodio y pidió mejorar la barra para mover la línea de tiempo y otros detalles. Esta revisión continúa sobre HEAD `e0499441604aacb9b7eede061fcb6e6698df86e6`, cuyo código live era `49c57d4e208397a16d998ceada6126d516b5cc62`. Cambia sólo la interacción y presentación del Editor, con sus pruebas y evidencia. No cambia modelos, permisos, CAS, proveedor, calidad del master ni almacenamiento.

### Cambios visibles

- Barra «Posición» con tirador mayor y tiempo al lado; Reproducir y Ampliar tienen el mismo ancho y altura, también con texto aumentado. Los sliders comparten el estilo de Lumi y actualizan su valor durante el movimiento.
- Cursor con agarre de **44 × 44 CSS px** sobre una regla de 44 px. Toda la regla acompaña el arrastre; agarrar el cursor fuera del centro no provoca un salto. Al llegar al borde, la vista se desplaza sólo mientras continúa el gesto. El cursor también admite ajuste por fotograma con teclado.
- El zoom mantiene el punto visible, incluido el gesto con dos dedos. Al alejarlo, la regla usa marcas menos juntas. Volver conserva posición, selección, zoom y desplazamiento horizontal.
- Deslizar un clip sin seleccionar recorre la vista; tocarlo lo selecciona para editar. Los clips cortos dejan libre su área de selección/movimiento: los tiradores se muestran sólo en clips seleccionados con espacio suficiente; el recorte sigue disponible en el panel. Cancelar un gesto o iniciar un pinch revierte el cambio transitorio, sin crear una versión accidental.
- Ir al extremo final muestra el último fotograma, en lugar de conservar una imagen anterior. «Añadir» queda como una acción secundaria discreta cuando no hay selección.

[Comparador visual](lumi-improvement/editor-touch-polish/index.html): [Editor antes](lumi-improvement/editor-touch-polish/before/editor.png) / [después](lumi-improvement/editor-touch-polish/after/editor.png), [audio antes](lumi-improvement/editor-touch-polish/before/audio.png) / [después](lumi-improvement/editor-touch-polish/after/audio.png), [texto al 125%](lumi-improvement/editor-touch-polish/after/texto-ampliado.png). Capturas inspeccionadas personalmente; se corrigió también el margen heredado que desalineaba los botones adyacentes.

### Evidencia de interacción

[Antes](lumi-improvement/editor-touch-polish/before.json) y [después](lumi-improvement/editor-touch-polish/after.json): Chromium 145.0.7632.6, Linux, touch real mediante CDP, módulos y handlers reales, identidad y almacén aislados. Timeline de 20 s compuesto con una fuente sintética local de 5 s repetida; no se renderizó un montaje largo ni se cargó media de prueba en staging. El modo baseline sirve `editor-ui.js` y `style.css` exactamente desde `e049944`; no altera el checkout. Cada medida de gesto corresponde a una muestra del recorrido; no es un estudio estadístico de precisión humana.

| Comprobación | Antes | Después |
|---|---:|---:|
| Ancho de agarre del cursor | 9 px | 44 px |
| Altura de la regla | 28 px | 44 px |
| Arrastre de regla hacia 4 s | terminaba en 3,03 s | termina en 4,00 s |
| Desplazamiento visual del cursor al duplicar zoom | 550 px | 0 px |
| Valor visible mientras el slider pasa a 1,25 s | seguía en 0,60 s | muestra 1,25 s |
| Seek al final de 20 s: tiempo en la última fuente de 5 s | conservaba 2,00 s | 4,966666 s, último frame de 30 fps |

Se reprodujo además una carrera con autosave: un volumen previo pendiente podía guardar una voz en 0,900 s durante un arrastre que luego se cancelaba, aunque su posición confirmada era 0,600 s. El arrastre ahora dibuja una vista provisional en memoria; sólo al soltar se aplica al edit existente. Autosave conserva el ajuste anterior confirmado, y exportar/deshacer quedan deshabilitados durante el gesto. La prueba sostiene el arrastre 1,2 s, confirma el recibo del volumen anterior, cancela y comprueba que la posición sigue en 0,600 s; no se crea ni modifica un modelo de almacenamiento.

El gesto nativo sobre la barra llegó a 10 s en su punto medio. Se verificaron agarre descentrado, desplazamiento de la vista sin editar, avance en el borde y cese al soltar, voz +0,600 s con recibo de autosave, deshacer, `pointercancel`, pinch durante una edición transitoria, teclado y regreso. Ni recorrer ni cancelar ni hacer zoom creó una revisión. Sin scroll horizontal de página en 360, 390, 430 px y 844×390; botones alineados también al 125% de texto. Son pruebas Chromium, no una validación física de Telegram/iPhone.

[Regresión de Editor](lumi-improvement/editor-touch-polish/editor-contract.json): sincronía de voz, ganancia −3 dB, undo/redo, dos pestañas, CAS, recibo perdido, recuperación local y sesión vencida. El fragmento sintético local de exportación fue de 4,5 s; no es el render real fallido. Doce ajustes cargados tuvieron feedback de 13,9 ms de mediana y 16 ms máximo en ese banco. [Reproducción](lumi-improvement/editor-touch-polish/playback.json) conservó transición con 500 ms de buffering coordinado, reconexión y posición bajo red simulada; sólo poster y primer proxy al abrir. Además pasaron 41 tests focalizados de Editor, Resultados, UI y autenticación. CI y el recibo de staging se registran al cerrar el despliegue.

La apertura física reportada por el usuario corresponde a la versión anterior; los nuevos gestos aún requieren su comprobación en iPhone. EP004 conserva su exportación fallida, sin nueva causa acreditada ni reintento. Cero nuevas generaciones, TTS, reservas, publicaciones, programaciones, contrataciones o cargas de media de prueba remotas. Siguen vigentes la pausa, los consentimientos y el techo de USD 8.

Implementación contrastada con [Pointer Capture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture) y [touch-action](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/touch-action); los gestos cancelados se revierten y los listeners/capturas se liberan al salir. La comprobación humana final de esta revisión consiste en mover la barra «Posición» y el cursor naranja, hacer zoom y volver dentro del mismo proyecto.
