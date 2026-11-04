# Lumi Trading · Panel compacto v2 (solo lectura)

## Estado

Versión corregida y probada localmente contra el **contrato de proyección** del motor PAPER existente, a partir de la rama `lumi-trading-aws`, cuyo SHA de referencia es `96c90b3d0b2fd1341ad844afdcb81c43ca9e00c7` (2026-11-04). Este paquete **NO fue publicado en el sitio privado**, no incluye credenciales y no altera el motor. En esta sesión no fue posible escribir en GitHub ni inspeccionar el estado en vivo de AWS.

## Objetivo

Vista rápida con solo tres secciones: **Resumen · Operaciones · Actividad**. Primer bloque: patrimonio PAPER, resultado neto realizado, valoración neta abierta, y posiciones/órdenes pendientes. Tarjetas de cada operación con entrada/SL/TP y protección expandibles. Cuatro evaluaciones independientes (5m, 15m, 1h, 4h) que muestran última evaluación y clasificación de mercado; la lectura experimental de scalping 5m está claramente rotulada como **sin autoridad para operar**.

## Integración sin crear otro panel

1. **Usar el proyecto privado ya existente** `lumi-trading-monitor.aguzz-gettar.chatgpt.site`. No cambiar dominio, público, cookies, autenticación de Telegram ni permisos existentes. Mantener la vista completa actual.
2. Copiar `index.html`, `style.css`, `app.js` y `model.js` **en una ruta bajo el MISMO ORIGEN**, como `/simple/index.html` (si el framework tiene enrutador, agregar la ruta correspondiente y preservar la protección de sesión). No alojar la interfaz en otro dominio: la lectura privada usa cookies same-origin.
3. Confirmar que la ruta ya existente `GET /api/monitor/live` devuelve la proyección con `secondary_finances` (`ledger: "FREQUENT_PAPER"`, `mode: "PAPER"`) y `secondary_activity.frames`. Si su ruta real fuera distinta, ajustar **solo** la constante `API` al comienzo de `app.js`, sin inventar datos ni modificar el backend de trading.
4. Asegurar en el hosting actual que los controles de autorización aplican a la ruta nueva **y** al endpoint de datos. Nunca insertar credenciales de publicación en JavaScript. Dejar el vínculo `Vista completa` visible y operativo.
5. Verificar en móvil real (con sesión válida): saldo y resultados con aperturas y cierres, reloj de cada plazo, lectura `WAIT` de scalping, desactualización/fallo de red, control `Tomar ganancia` solo en la vista completa y enlace de regreso.
6. Una vez comprobado el entorno autenticado, cambiar opcionalmente el enlace principal del monitor a la vista simple. No hacerlo sin comprobar permisos, historial y controles. No modificar la Mini App audiovisual.

## Exactitud y privacidad

- **No se mezclan** datos de cartera principal (`ENGINE`) ni spot; solo se muestra secundaria `FREQUENT_PAPER`.
- Una posición `OPEN` **no produce una ganancia realizada** en el historial, aunque haya valoración neta.
- Si funding, precio o cierre aún no son verificables, la interfaz muestra `—` y una explicación, sin inventar valores.
- Solo `GET` con `credentials: same-origin`; ningún `POST`, botón para comprar/vender, ni órdenes reales o PAPER.
- El estado verde requiere snapshot reciente, latido+lease verificados y mercado usable. Ante falta de información, se advierte en la primera pantalla.
- Los detalles expandidos mantienen su estado entre actualizaciones de 2 segundos; las pestañas usan tres botones accesibles.

## Pruebas

Ejecutar `npm test` o `node --test test/model.test.js` en Node.js 24+ desde este directorio. La suite incluida cubre exclusión de principal, contabilidad de cierres vs posiciones abiertas, 5m/15m, financiación no final, reloj, seguridad de texto y lectura sin escritura. Resultado al empaquetar: **8/8 PASS**. **No equivale** a prueba autenticada de navegador ni despliegue.

## Archivos

- `index.html`: entrada HTML.
- `style.css`: diseño responsive y accesible.
- `app.js`: presentación, navegación, consulta privada, manejo de errores y refresco.
- `model.js`: traducción estricta del payload del motor existente a información breve.
- `test/model.test.js`: pruebas sin operaciones de trading.
- `package.json`: módulo ES y comando de test.
- `MANIFEST-SHA256.txt`: integridad de los archivos del paquete.

No borrar antiguas copias SQLite ni desactivar S3. La integración del panel no necesita reiniciar el worker de AWS.

## Estado de publicación (2026-11-04)
Código integrado en rama de revisión; el monitor propietario original `chatgpt.site` sigue requiriendo acceso al proyecto del sitio. La fusión a AWS/GitHub no publica por sí sola `/simple` en el origen privado. No cambiar DNS, enlaces de Telegram ni controles.
