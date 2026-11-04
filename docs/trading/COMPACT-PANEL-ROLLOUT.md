# Lumi Trading — Vista simple, SHADOW y despliegue seguro

## Alcance concreto

La vista compacta (`deploy/trading/compact-panel/`) es **un módulo real de interfaz de lectura**, no una imagen ni un boceto. Reutiliza el endpoint privado **same-origin** `GET /api/monitor/live` del panel actual, mantiene cookies de sesión solo para el mismo origen y nunca agrega endpoints de escritura. **Se debe publicar en el origen existente** `lumi-trading-monitor.aguzz-gettar.chatgpt.site` bajo `/simple/`, sin construir otra aplicación y sin modificar el panel completo.

El repositorio GitHub de Lumi Trading/AWS **no contiene el código fuente ni las credenciales de despliegue del sitio privado `chatgpt.site`**. Por ello los tres archivos listos para integración *todavía no están publicados en ese origen*. No se debe afirmar que la pantalla nueva ya es visible en Telegram ni reemplazar el panel de otra manera que rompa su autenticación.

- `index.html`: vista móvil y compacta, accesible.
- `model.js`: adapter PAPER de saldo/equity, resultado neto realizado y abierto, alertas de antigüedad, posiciones, niveles, protección, evaluaciones 5m/15m/1h/4h y actividad.
- `app.js`: consulta privada cada 2 s mientras la pestaña está visible, rechazo de respuestas antiguas, backoff, acceso vencido, detalles expandibles. Botón **Vista completa** preserva controles manuales, gráfico, filtros y evidencias.
- `test/trading-compact-panel.test.js`: prueba aislamiento de principal, clasificación de neto incompleto, seguridad básica de HTML y navegación a vista completa.

La vista simple nunca ofrece `POST`, `PUT`, `PATCH` o `DELETE`; no puede tomar ganancia ni cerrar una posición. **La vista completa existente sigue disponible** para esas operaciones.

## Despliegue del observador

Las mejoras de mercado/regímenes están en los PR #5 y #7. Esta rama agrega aislamiento ante excepción de clasificación y suprime eventos repetidos `WAIT` para reducir crecimiento de SQLite, sin saltarse evaluaciones ni modificar `broker.choose`, posiciones, salidas o red neuronal. No hay entrada de futuros 1m nueva.

El usuario autorizó una progresión de mejoras pero **el despliegue queda bloqueado por recuperación de datos**: en la lectura del 4/11/2026, SQLite ocupa aproximadamente 471 MB, disco 88% usado, `dashboard.backup_error=BACKUP_SIZE_LIMIT`, `backup_at=0`. El comprimido rápido de la DB fue ~95 MB, mucho mayor que el límite de copia cifrada de 16 MiB. No subir simplemente la constante: confirmar primero el límite de carga del sitio, cifrado, recepción, retención y recuperación de R2; proteger el historial y probar un backup consistente de SQLite incluyendo WAL.

Antes del primer restart del worker:
1. Tener una copia remota cifrada **completa, verificable y restaurable**, y una copia SQLite local con `PRAGMA integrity_check`.
2. Confirmar espacio libre para snapshot temporal, release y rollback, sin eliminar historiales antiguos por conveniencia.
3. Ejecutar toda la suite Node+Python; la suite de entrenamiento debe correr **fuera del worker protegido**. No desactivar `TRAINING_FORBIDDEN_ON_ACTIVE_WORKER` solo para aprobar pruebas.
4. Desplegar commit exacto en release aislado con pausa del writer; preservar env, SQLite, outbox, hashes, planos de riesgo y posibilidad de rollback, y hacer verificación posterior de evaluaciones, Telegram y monitor.

Hasta cumplir esos requisitos, solo se permiten auditorías y pruebas **sin reiniciar** el motor existente.
