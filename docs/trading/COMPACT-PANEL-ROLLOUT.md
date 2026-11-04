# Lumi Trading — Panel compacto v2: integración controlada

## Alcance
Se conserva el worker AWS y el único monitor del propietario: `https://lumi-trading-monitor.aguzz-gettar.chatgpt.site`. No hay un segundo monitor ni se cambia la Mini App audiovisual.

El código listo para el sitio vive en `deploy/trading/compact-panel/`:
- `index.html`, `style.css`, `app.js`, `model.js`.
- `test/trading-compact-panel.test.js` (regresión histórica) y `test/trading-compact-panel-v2.test.js`.
- `docs/trading/COMPACT-PANEL-V2-DEPLOY.md` (instrucciones detalladas).

Presentación: Resumen · Operaciones · Actividad; saldo PAPER y resultados realizados/abiertos; posiciones con SL/TP y protección; estado por 5m/15m/1h/4h; hipótesis de scalping observadas **sin ejecución**. Las métricas nulas o no finalizadas no se convierten en cero y el historial excluye operaciones de la cartera principal.

## Dependencia de origen y privacidad

**La publicación de GitHub o AWS NO despliega una interfaz en `chatgpt.site`.** La ruta deberá ser `/simple/` **bajo el origen privado existente**, con exactamente la misma sesión/autorización del monitor original. No exponer el endpoint públicamente ni inyectar claves en JavaScript. El botón «Vista completa» conserva las acciones originales. Antes de cambiar el enlace de Telegram, probar autenticación, 401/403, expiración de sesión, navegación, actualización cada 2 segundos y uso desde iPhone. No aplicar migraciones ni alteraciones de la base de datos del sitio.

Al integrar mediante la herramienta de edición del Site, importar estos cuatro recursos y comprobar que su `GET /api/monitor/live` devuelve `secondary_finances.mode='PAPER'`, `secondary_finances.ledger='FREQUENT_PAPER'` y `secondary_activity.frames`. Si el sitio usa un enrutador, montar un route `/simple/` autenticado con archivos internos, manteniendo la ruta `/` completa. Si la ruta no es accesible con la sesión del propietario o el esquema no coincide, **no publicar ni cambiar el enlace de Telegram**.

## Estado operativo separado (2026-11-04)

El respaldo cifrado independiente S3 `lumi-trading-s3-recovery.timer` se instaló y la recuperación de una copia remota fue comprobada; el viejo publicador de copia del Site/R2 puede seguir notificando `BACKUP_SIZE_LIMIT` sin contradecir esa copia S3. El worker PAPER fue actualizado al observer `1fd16d2` con reinicio controlado y revocación si fallaba. Los cambios de v2 aquí son **solo frontend y pruebas**; no reinician el worker ni alteran posiciones, capital, leverage, órdenes, notificaciones Telegram o la cartera principal.

El código fuente completo del sitio `chatgpt.site`, su herramienta de edición y su autenticación de propietario no forman parte del repositorio AWS ni de los conectores de GitHub/AWS disponibles en esta conversación. Por tanto **no afirmar que la UI v2 está en producción** hasta que su despliegue se efectúe desde la instancia del proyecto Site y se verifique `/simple/` como usuario autenticado. No usar un sitio alternativo público como sustitución.
