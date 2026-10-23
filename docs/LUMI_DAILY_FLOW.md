# Lumi: recorrido diario y estado comprobado

Observación: 23 de octubre de 2026, 16:33 UTC. EP004 quedó en 26/50 acciones y 4/7 tomas. No existe todavía su master.

## Uso en Studio

1. **Preparar:** revisar historia, narración, estimación y límites. En un trabajo nuevo, elegir revisión por toma o borrador automático en la misma confirmación. La decisión se guarda antes del inicio. Una renovación económica conserva el modo vigente y su vencimiento.
2. **Producir:** consultar avance real, resultados privados y presupuesto separado. Actualizar progreso es una lectura. Las solicitudes enviadas conservan su identidad al cerrar la app, perder conexión o reiniciar el servicio. Modo y pausa son accesibles durante una solicitud pendiente.
3. **Revisar:** revisar el borrador completo. Las comprobaciones técnicas y el modo automático no se registran como aprobación humana de imágenes o clips.
4. **Descargar:** el master final aparece tras su aprobación. Reproducción privada con Range y enlace renovado para descargar los mismos bytes. No depende de que el catálogo de Biblioteca ya haya incorporado el master.

## Fallos y pruebas

| Etapa | Síntoma y causa comprobada | Corrección | Resultado |
|---|---|---|---|
| Entrada | DIRECT activo; Make 6224860 inactivo. El antiguo generador de ideas no tiene reemplazo en DIRECT. | Se conservó el único transporte activo. | Identidad del bot y Ed25519 verificados por readiness. Crear libremente una idea nueva sigue sin ruta hacia el planificador; no se activó otra IA paga ni otro episodio. |
| Recuperar q43 | El recuperador quedó en atención por falta de ACK a las 10:48; el ACK llegó después, 12:56. El error heredado Q41_ACCEPTED_JOB_REQUIRED no exigía generar q41. | Reabrir únicamente ese bloqueo obsoleto cuando journal y recibo confirman el mismo ID. | MP4 q43 recuperado una sola vez, SHA/readback/decodificación verificados. Cero reemisiones. |
| Continuar | El trabajo apuntaba al plan vencido pese a renovación durante WAITING_PROVIDER. | Reconciliar el plan vigente en límites futuros; conservar consentimiento de solicitudes emitidas. | Mismo trabajo avanzó a q44 y completó imagen y video dentro del permiso existente. |
| Inicio | Modo automático se elegía después de iniciar. | Elección explícita dentro de la aceptación inicial; persistencia atómica antes del inicio. | Doble toque, reapertura, decisión inmutable y cero emisión al aceptar probados con fixtures. No se aceptó ningún modo en nombre del usuario real. |
| Presupuesto | q45 necesita reserva 0.3475; consentimiento específico 0.345. Las reservas visuales omitían 0.33875 de la fuente importada. | Bloqueo antes de emitir. Propuesta de límites con 10% de margen y redondeo de 0.05, sujeta a aceptación; incluir reservas importadas. | Techo 8 intacto, reservas 3.94125, gasto real desconocido, q45 sin journal ni reserva nueva. |
| Interfaz | Controles dispersos, identificadores visibles y descarga dependiente del catálogo. | Cuatro etapas, historia visible, tomas/miniaturas, una decisión contextual, detalles técnicos plegados. | Chromium 390×844: controles, bloqueos, estado tras reapertura, sesión vencida, reproducción y descarga exacta mediante HTTP local. |
| Reinicio | Nuevo proceso observado 16:08:32–48 mientras quedaba temporal_qa:q44. | Cola y checkpoints existentes reanudados; sin activar runners globales. | Mismo trabajo completó shot_review:q44 a 16:10:49. Los eventos no prueban el motivo del reinicio. |
| Voz/master | Etapas todavía no alcanzadas en EP004. | Voz Fernanda V3, calidad y revisión final preservadas. | Integración sintética y video H264 1080×1920/AAC pasan. No se afirma master real ni aceptación iPhone. |

## Única decisión actual

En EP004 → Producir → **Revisar plan y continuar**. La cotización observada de q45 fue 0.278 USD; reserva 1.25× = 0.3475 USD, por encima de 0.345 USD. No se envió esa generación. El precio observado venció y se comprobará de nuevo antes de emitir.

La propuesta incluye margen para pequeñas variaciones de las etapas restantes y conserva el techo total de 8 USD. No está aceptada. El modo automático ya tiene aceptación humana del 23 Oct, 15:16:45 UTC y vencimiento 24 Oct, 14:12:19 UTC. No hace falta volver a elegirlo mientras siga vigente.

La operación ambigua original de q42 y su reserva 0.3275 USD se conservan. q41 y las aprobaciones anteriores permanecen intactos. Solo hubo dos solicitudes generativas nuevas del trabajo autorizado: imagen y video q44. Las pruebas hicieron cero llamadas a proveedores reales.

## Límites comprobados

- Render sigue en Free. Los checkpoints sobreviven al reinicio; la ejecución no puede continuar mientras el servicio está suspendido. No hay garantía de ejecución continua ni de tiempo de finalización.
- La producción diaria completa todavía no está certificada: faltan el resto de EP004, voz, montaje, revisión humana, prueba real del dispositivo y la ruta de una nueva idea al planificador.
- Prueba manual futura, cuando aparezca el master: abrir desde el bot en iPhone, reproducir hasta el final con sonido, cerrar/reabrir y descargar; comprobar duración y audio del archivo descargado. No aprobar si hay defectos visuales o narrativos.

## Evidencia

- Código desplegado: `1b02c51429fd863d6216511ee0b8b0b460f46f0b`.
- CI GREEN: [39986155840](https://github.com/AgustinGettar/content-factory-renderer/actions/runs/39986155840).
- Render LIVE: `dep-dbdok1vf3r2c73bh6vi0`, terminado 2026-10-23T16:24:13.450064Z. Readiness y bytes de app coinciden; estado/sesión anónimos devuelven 401.
- Identificadores completos, hashes, decisiones y límites: [daily-flow-evidence.json](lumi-improvement/daily-flow-evidence.json).
- Estado de continuación: [LUMI_RESUME_STATE.md](LUMI_RESUME_STATE.md). No se genera otro prompt técnico.
