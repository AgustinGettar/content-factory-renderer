# Lumi · revisión de preparación y montaje natural

Corte de evidencia: 25-10-2026. Rama exclusiva `lumi-telegram-review-v1`; staging `mofjhwathxzfnjapvvst` / `content-factory-av2-staging`. Base remota observada `288128926bcabe53af2e1b92eb7249e0971a8f97`; live previo `4297ec0470a9d92eacf6cfa9b795a337a6948769`. La evidencia exacta de CI y despliegue del cambio se registra al cierre en [natural-editing-deployment.json](lumi-improvement/natural-editing-deployment.json). No se modifican originales, consentimientos ni operaciones reales.

## Qué cambió

- **Preparar → Próximo episodio** permite escribir una historia, objetivo, objetos, narración y 5–10 tomas. Es una guía editable determinista, no creación libre por IA. Se conserva la identidad canónica y Fernanda V3. La preparación se guarda con propietario, UUID estable y versión CAS; congelarla crea un checkpoint con techo autorizado **0**, sin job ni reserva. La aprobación autenticada del plan y modo es la que instala los límites aceptados. Se corrigió la falta de proyección de esa elección a la revisión final.
- Se estima la voz antes del gasto con un intervalo de palabras/segundo, declarado incierto, más los márgenes configurables y la pausa pedagógica. El formulario bloquea una narración que no cabe en el intervalo propuesto. La voz real se mide después; nunca se acelera para encajar.
- Política optativa `LUMI_NATURAL_TIMELINE_V2` para planes nuevos. Conserva por defecto la fuente útil completa a 1×; un objetivo antiguo de 3 s no recorta silenciosamente una fuente de 5 s. Recortar requiere motivo y resolución confirmada; una acción declarada inconclusa bloquea. No hay loops, interpolación, ralentización ni fundidos automáticos. Las tomas no finalizan por el fin de la voz.
- La línea de tiempo separa fuente, entrada/salida, duración editorial, voz, offset, pausa y margen. Conserva SHA de fuente/audio, decisión y SHA de manifiesto. Normaliza PTS/FPS sin deformar ni recortar bordes: **contain**, no crop. La adaptación al grid de 30 fps puede repetir como máximo un frame final para cuantización; no se usa para completar gestos.
- Master desde fuentes: 1080×1920, H.264 High, CRF17, slow, yuv420p, AAC 48 kHz/192 kbps, un encode final. Timescale 48000 conserva duraciones fraccionarias de audio a precisión de muestra. La recuperación del ejecutor consulta primero el objeto durable y evita otro encode después de perder el ACK.
- El presupuesto aceptado conserva los máximos por acción como máximos revisados, **no como nuevas cotizaciones**. Las asignaciones de alojamiento existentes se muestran como desconocidas; ese dato no puede ocultar un costo generativo faltante, un cambio de plan ni exceso del techo. Las cotizaciones finales y reservas siguen sus gates.
- Metricool distingue una conexión guardada de una lectura de acceso reciente. Una verificación de más de 24 h pide comprobar acceso, no reiniciar OAuth. No se modifica ningún token.
- La tarjeta de recuperación distingue un resultado terminal confirmado de una consulta pendiente. Failed, moderación y cancelación muestran atención, la última consulta verificada y solo actualización de estado; no vuelven a ofrecer recuperación como si el proveedor siguiera generando. Una recarga no autoriza repetir esa solicitud.

EP004 conserva el contrato editorial anterior: no se cambia su duración, fuente, aprobación ni presupuesto retroactivamente.

## Duraciones de Flores: medición de los archivos, no de etiquetas

Se recuperaron el master y los seis originales privados de la biblioteca. FFprobe/decodificación completa en FFmpeg **6.1.1**; cotejo de los 987 frames del master con los originales y revisión visual temporal por muestras de inicio, desarrollo y cierre. **No se afirma una reproducción audiovisual ininterrumpida ni aceptación artística.**

| Toma | Plan inicial / shot-pack-director | Original: stream y contenedor | Primer tramo retenido en master | Diagnóstico |
|---|---:|---:|---:|---|
| q31 | 4 / 4 s | 4.041667 s; 97 frames | 4.041667 s | Fuente completa en la introducción. |
| q32, roja | 5 / 4 s | 4.041667 s; 97 frames | 2.833333 s, 05.291667–08.125000 | A: se pierde retirada de mano/pose estable visible cerca de 3–4 s del original. |
| q33, amarilla | 5 / 4 s | 4.041667 s; 97 frames | 3.166667 s, 08.125000–11.291667 | A: corte cercano a la retirada; el asentamiento posterior existe en la fuente. |
| q34, azul | 5 / 4 s | 4.041667 s; 97 frames | 2.875000 s, 11.291667–14.166667 | Corte durante el segundo gesto hacia la flor; se pierde el final disponible. La pose resuelta requiere juicio humano. |
| q35, interacción | Alias históricos q37/s35: 5 / 5 s | 5.041667 s; 121 frames | Primera inserción 1.250000 s; después varias reutilizaciones | Ritmo/orden D: el master intercala recortes; incluye también una aparición completa de 5.041667 s. |
| q36, cierre | Alias históricos q39/s36: 6 / 5 s | 5.041667 s; 121 frames | 4.291667 s, 36.833333–41.125000 | Se omite parte del asentamiento final, visible en el original. |

El shot-pack histórico llama q37 y q39 a las dos últimas tomas, mientras los originales finales se llaman q35 y q36; esa correspondencia funcional no prueba por sí sola el payload final. Los valores de plan se distinguen de un recibo del payload realmente enviado. Para Flores **no se recuperó el payload original completo**: el expediente q31 ya registra `submitted_value: null`; no se infiere a partir del código actual. Ninguno de los seis archivos medidos dura 3 s.

El master mide **41.125000 s**, 987 frames, 24 fps, audio AAC 48 kHz de igual duración, SHA `b6f9fe837d000a924608ed4bda13034ff30560ac48b5a085f7cb0a90f35a2624`. Contiene 16 tramos, incluidos cortes de 0.916667, 0.958333 y 1.25 s. El inventario completo de cortes, fuentes y hashes está en [natural-editing-flores-evidence.json](lumi-improvement/natural-editing-flores-evidence.json).

No se localizó un manifiesto final ni el commit/comando exacto que produjo ese master. Su cadencia de **24 fps** y sus 16 reutilizaciones no corresponden directamente al montador actual de segmentos a 30 fps sin otra transformación. Por eso se confirma el recorte **en los bytes**, sin atribuirlo falsamente al `buildAssemblyCommand` actual. Esa función sí tenía un riesgo reutilizable comprobado: trim/atrim a `segment.duration`; la nueva política lo corrige sin alterar su rama legacy.

Audios originales: contenedores MP3 de 5.328980, 20.271020 y 13.008980 s. No equivalen exactamente a duración audible por padding del codec. En el master se midió silencio por debajo de −35 dB entre **28.2631 y 30.7730 s: 2.50992 s**; durante él sigue q35. Esto acredita silencio físico, no comprensión semántica ni evaluación pedagógica. No se creó voz ni música.

## Comparación editorial separada

[Ver comparación antes/después](https://chatgpt.com/library?file_id=libfile_c735e72f087c819180b24d71c34649bf&account_id=personal).

Archivo `Flores_comparacion_editorial_NO_APROBADA.mp4`, SHA `8b60a685630778bab2d665dedc3db61d50f5eb16f51f49378ee217f5f7376edf`, 14,249,022 bytes, **20.666667 s**. Primero se reproduce el tramo original **05.625–14.166667** (8.541667 s); después q32–q34 completos (12.125 s), dos uniones limpias y velocidad 1×. Se conservan los grupos de audio del master asociados a cada toma, se desplaza cada grupo con su imagen y se deja el silencio restante; las separaciones elegidas caen en intervalos de baja amplitud. No se añade habla ni se adelanta la voz de la toma siguiente. Se mantiene 24 fps en esta comparación para cotejar directamente los originales; es una excepción documentada del derivado, no el perfil futuro.

No reemplaza el master, no registra un episodio ni crea una aprobación. No demuestra que una fuente con gesto inconcluso se pueda arreglar por edición. El caso B se bloquea en pruebas, no se inventan sus frames. La comparación requiere escucha y revisión humana de ritmo y sincronía; las muestras visuales y la medición de silencio no las sustituyen.

## EP004 actual

| Tomas | Plan/director | Recibido: QA durable de stream | Montaje |
|---|---:|---:|---|
| q41–q44 | 4 s cada una | 4.041667 s; 97 frames, 24 fps | Todavía no existe master. |
| q45–q46 | 5 s cada una | 5.041667 s; 121 frames, 24 fps | Todavía no existe master. |
| q47 | 3 s previstos | No hay clip; imagen fallida | Sin voz ni montaje final. |

Aquí se leyó el FFprobe durable ligado al SHA, no se descargaron de nuevo los seis originales. El artefacto muestra 4.042/5.042 por redondeo; el stream conserva los valores exactos. No hay un proxy de 3 s acreditado. [Detalle por toma y procedencia](lumi-improvement/natural-editing-ep004-evidence.json).

38/50 etapas completas, seis clips disponibles, próximo `image:q47`. Job `NEEDS_ATTENTION / PROVIDER_RESULT_FAILED`, sin lease activo; `RUNNING` en el checkpoint no acredita avance. Request fallido conservado `574ed43e-129d-4e56-ba14-0d031f1670c2`. Aviso de saldo vacío informado por el propietario, sin consulta nueva al proveedor durante esta revisión.

Techo USD8; reservas internas **USD6.37875** (USD6.04 locales + USD0.33875 del origen q41), incluida q42 ambigua. Diferencia contra techo USD1.62125; no es saldo del proveedor ni cotización del trabajo restante. Gasto confirmado: desconocido. Ninguna reserva se libera. Las decisiones de plan/borrador registradas se conservan, sin extender vigencia.

## Matriz del recorrido real

| Etapa: entrada → salida | Propietario / identidad | Dependencia y bloqueo real | Prueba y recuperación |
|---|---|---|---|
| Telegram → Studio/sesión | Usuario Telegram; sesión firmada/CSRF | Render Free puede despertar; sesión vencida exige reabrir desde Telegram | HTTP local y Chromium; anónimo rechazado; no se modifica DIRECT/Make. |
| Idea → preparación editable | Propietario + draft UUID + versión CAS | Historia/narración humanas; sin IA paga | Dos preparaciones nuevas por UI; autosave, reload, ACK perdido y doble freeze. |
| Preparación → plan | Episode ID derivado + binding SHA | Validación AV2, objetos, roles, duración de voz estimada | 5 y 6 tomas, duraciones distintas; freeze sin autoridad ni reservas. |
| Plan → estimado/consentimiento | Grant sellado; modo y máximos por acción | Historial de precios es estimación; cuota/validez real se verifica antes del envío | Dos elecciones explícitas simuladas; grant vencido o costo faltante bloquea; no renovación de consentimiento automática. |
| Biblioteca → referencias | Asset SHA + aprobación humana + selección | Compatibilidad semántica y de fuente; no ahorro supuesto | Regresión de catálogo/aislamiento; no se seleccionó ni mutó un recurso real. |
| Imagen/director/video → solicitud | Episodio+toma+attempt+payload SHA; journal | Saldo, cotización vigente, fuente aprobada o política de borrador | Proveedores simulados; doble toque y reinicio conservan identidad. |
| Solicitud → original/QA | Request ID original + objeto privado + SHA | Fallo/NSFW/cancelado son terminales; ambigüedad conserva reserva | Recuperación durable y ACK perdido; no recotizar una solicitud ya enviada. |
| Narración → voz | Unidad de toma + Fernanda V3 + claim | TTS/quota real pendiente; voz larga genera conflicto temporal | Audio sintético local y audio Flores existente; ninguna llamada TTS real. |
| Fuentes+voz → montaje | SHA de entradas + manifiesto editorial | Acción incompleta, voz/pausa que no caben: revisión necesaria | CFR/VFR, PTS no cero, fracciones, colas, pausa 2.5 s, transición bloqueada. |
| Montaje → master/revisión | Attempt local + objeto durable + master SHA | Render real completo en Free no se probó; revisión artística humana | Dos encodes Full HD aislados; replay del ejecutor tras borrar temporales sin otro encode. |
| Master → descarga | Cookie/ticket privado + SHA | Safari/Telegram/iPhone pendiente de aceptación real | Descarga backend exacta; Chromium de escritorio con viewport móvil no equivale a iPhone. |
| Master → Metricool | Marca7627207, dueño5949429, paquete/master SHA | Conexión guardada; permisos/cuota/ingestión y escritor/reconciliación no acreditados | Paquetes editables CAS y SHA invalidado si cambia master; envíos rechazados, cero efectos remotos. |

## Metricool: conexión real conservada, publicación todavía cerrada

Lectura de estado durable posterior al consentimiento: `BACKEND_VERIFIED`, **2026-10-25T19:47:59.672Z**, marca `lumilaluciernaga`, 7627207, dueño5949429, Europe/Rome; Instagram/TikTok `lumilaluciernaga` y YouTube `UC1ib2gAOQRCd45F5Ky1r-0Q`. Es el recibo de la lectura oficial efectuada por el backend, no una nueva prueba autenticada hecha en esta sesión. El navegador de auditoría no tiene la sesión privada de Telegram; no se extrajeron secretos para imitarla.

MCP OAuth descubrió `createScheduledPost` y `getScheduledPosts`, entre otras herramientas. El esquema admite URLs públicas de video; el campo de archivos del selector de ChatGPT no sirve a Render. No hay entre las herramientas descubiertas una lectura de cuota ni de opciones privadas del creador TikTok. La existencia del escritor no demuestra que la cuenta pueda publicar ni que un video haya sido ingerido. No se prueba enviando un post. La lista de programados tampoco acredita ausencia de un envío que ya se publicó.

El transporte social sigue **sin habilitar/validar**, y falta su implementación completa de ingestión/recibos con capacidades acreditadas. No se construye un adaptador de uploads sobre un endpoint supuesto ni se declara `READY_FOR_HUMAN_PUBLICATION`. Studio mantiene texto editable por red, versiones, marca fija, bloqueo de master/aprobación, rechazo sin archivo y ninguna autorización social heredada. Un master reeditado invalida el SHA del paquete previo.

La cuenta/plan y cuota restante concretos siguen desconocidos. La documentación oficial permite MCP en Free; el Free documentado limita a 20 publicaciones mensuales y no habilita producción diaria multired ilimitada. No se contrató REST Advanced ni otro servicio.

## Pruebas y límites

- Integración nueva: dos episodios aislados creados por los métodos reales usados por Studio, 5/6 tomas, 24/29 s; 22 emisiones visuales y 11 de audio **simuladas**. Claims, journal, CAS, validadores, políticas, reinicios entre etapas, revisión y montaje reales. Dos masters Full HD y descarga SHA exacta; ninguna mutación del EP004 fixture original.
- Navegador: DOM real de Studio, handlers HTTP autenticados y store CAS local; dos preparaciones distintas, autosave/reload, ACK perdido, doble freeze, sesión vencida. Toda salida al exterior interceptada/prohibida. **No es prueba iPhone.**
- Recuperación: 22 casos focalizados incluyendo cotización expirada, consentimiento expirado, q43 con preparación pesada, terminales de proveedor, progreso solo lectura, aprobación guardada sin ACK, controles de modo y recarga sin reenvío.
- El fixture de ruteo antiguo carecía de un plan completo de costos y giraba en un bucle al alcanzar el gate vigente. Se le agregaron tarifas explícitas exclusivamente sintéticas; no se desactivó el gate real.
- FFmpeg técnico: fuente5/objetivo3, fuente realmente corta/inconclusa, voz mayor/menor, pausa2.5, solapamiento rechazado, 24fps/PTS distinto, VFR, audio con cola y grid de muestras. La forma visual de una acción sigue requiriendo revisión humana.
- Render Free conserva suspensión/reanudación durable, sin keepalive ni ejecución continua prometida. No se hizo un master real en Render durante la pausa. El encode local no mide capacidad/RAM/tiempo real del servicio.

Siguiente uso seguro: **Studio → Preparar → Próximo episodio**. Se puede dejar el contenido preparado sin iniciar producción. Al informar una recarga, el aviso cambia a «recarga informada»; eso **no verifica por sí solo el saldo, no renueva consentimiento y no reenvía q47**. Una operación fallida o ambigua conserva su decisión pendiente. Para aceptar reproducción real: abrir Flores desde Telegram en iPhone, reproducir con sonido hasta el final y descargar; comparar el archivo descargado con el SHA ofrecido por backend cuando sea posible.

Fuentes oficiales revalidadas: [Kling 3 Pro, duración3–15s/default5](https://docs.higgsfield.ai/docs/models/kling-3/pro-image-to-video), [ffprobe](https://ffmpeg.org/ffprobe.html), [filtros/PTS](https://ffmpeg.org/ffmpeg-filters.html), [FFmpeg](https://ffmpeg.org/ffmpeg.html), [límites MCP Metricool](https://help.metricool.com/mcp-limits-and-plan-requirements-h72jg), [guía API](https://help.metricool.com/basic-guide-for-api-integration-r97af).
