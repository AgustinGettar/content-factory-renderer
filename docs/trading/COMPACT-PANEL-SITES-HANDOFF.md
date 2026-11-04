# Publicación del panel compacto en el Site ORIGINAL

Esta rama incluye `deploy/trading/compact-panel/simple-onefile.html` como alternativa autocontenida a los cuatro archivos de la vista compacta v2. Se verificó su JavaScript, lectura exclusiva, contratos y formatos mediante 18 pruebas Node en instancia aislada. No es una nueva web ni otra cartera.

## Evidencia disponible
- El worker AWS quedó activo con el motor original de trading PAPER tras tests, sin reinicio por este cambio.
- Desde la instancia AWS se comprobó `GET /api/monitor/live` con la **identidad de servicio ya configurada**. Respuesta HTTP 200, `secondary_finances.mode=PAPER`, `ledger=FREQUENT_PAPER`, `secondary_activity.frames` y datos de posiciones disponibles. No se imprimieron tokens ni PnL.
- Los accesos anónimos a `/`, `/simple/` y `/api/monitor/live` respondieron HTTP 401; esto indica que el sitio está protegido, **no** que la nueva ruta esté publicada.
- El proyecto ChatGPT Sites `lumi-trading-monitor.aguzz-gettar.chatgpt.site` se administra desde **Sites > seleccionar el Site existente > Editar** en ChatGPT web o escritorio. Los conectores GitHub y AWS **no editan el código del Site**. No existe un endpoint de publicación de Sites que esté documentado y habilitado en esta conversación.

## Handoff mínimo en el Site existente (un solo sitio)
1. Abrir **ChatGPT Sites**, seleccionar **Lumi Trading Monitor** (no crear otro proyecto) y elegir **Editar**.
2. Solicitar: «Agregá una página autenticada `/simple/` al Site existente. Usá los archivos del repositorio `AgustinGettar/content-factory-renderer`, rama `lumi-trading-aws`, carpeta `deploy/trading/compact-panel/`. Si el editor admite archivo HTML autocontenido, usar `simple-onefile.html`, comprobando la política CSP: si no permite JavaScript inline, usar los cuatro recursos originales `index.html`, `style.css`, `model.js`, `app.js` como módulos propios. Mantené la ruta `/`, el acceso privado y todos los controles del monitor anterior. La nueva UI es solo lectura y consulta el MISMO ORIGEN `GET /api/monitor/live`». 
3. Guardar una **versión previa** del Site. Integrar la ruta bajo **los mismos controles de autenticación** de `/`; nunca poner `OAI-Sites-Authorization`, `X-Trading-Ingest-Key` ni credenciales de AWS en HTML o JavaScript.
4. Verificar como propietario desde Telegram: HTTP 200 del frontend bajo `/simple/`, pantalla «Motor y mercado actualizados» al recibir payload reciente, importes reales de PAPER sin duplicaciones, las tres pestañas, plazos, botón «Vista completa» y diseño iPhone. Verificar también que una sesión anónima reciba 401/403 en `/simple/` y `/api/monitor/live`.
5. Desplegar esta versión **en la misma URL de Site** solo si todas las comprobaciones anteriores son satisfactorias. Posteriormente, y únicamente si se verificó en Telegram, se puede cambiar el enlace que usa el bot para dirigir al usuario a `/simple/`. Antes del despliegue: mantener el enlace antiguo.

## Precauciones
- **No** activar órdenes reales o modificar cartera principal, Lumi audiovisual, worker AWS, SQLite, backup S3, Telegram webhook ni UI de cierre en la vista completa.
- Una página HTML estática fuera del mismo dominio no puede usar legítimamente cookies same-origin; no crear espejos públicos.
- Este commit de GitHub por sí solo **no equivale a Site publicado**. Una ruta protegida que responde 401 sin sesión no confirma si el archivo existe; la validación del propietario debe realizarse desde el editor o la sesión autorizada.
