# Lumi Trading — checkpoint público del plan V1.1

Fecha: 2026-11-13. Rama de conservación: `checkpoint/lumi-plan-v1.1-2026-11-13`.
Base Git preservada: `9f8648abe12cb3457814bae9074d8e666fd56cba`.
Origen de los 34 archivos recuperados: `cdfd04b8a2e9eea7e8d32df1d35c2ef217518595`.
Cada archivo recuperado coincide byte por byte con ese origen; el manifiesto adjunto contiene SHA-256 y tamaño.

Este checkpoint conserva código revisable sobre la base del repositorio. **No es un paquete autónomo de despliegue ni una instrucción para reemplazar el worker con toda esta rama.** No contiene las auditorías privadas, snapshots operativos, saldos, historial de posiciones, cookies, credenciales ni archivos de configuración de producción. Las referencias históricas del colector son identificadores de destino, no evidencia de versión activa.

## Estado separado por componente

| Componente | Estado conservado | Condición pendiente |
|---|---|---|
| Publicación del monitor | Reparación local para evitar enviar historia interna duplicada en el payload live; conserva campos económicos, frescura y detalle | Verificar versión y errores actuales del productor antes de desplegar; comprobar después avance de ambas vistas |
| Telegram secundario | Política optativa y versionada: apertura ejecutada y resultado final; conserva transporte y estados durables de entrega | Activar expresamente el selector únicamente tras verificación del entorno PAPER; no se enviaron mensajes reales |
| Objetivo L100 | Diagnóstico local de viabilidad y resultado del ciclo con contratos existentes, límites explícitos y desconocidos conservados | No dimensiona ni reserva órdenes operativas; falta presupuesto actual y evaluación pertinente para integrar una política de entrada |
| Sombra e integridad heredadas | Fuentes recuperadas: métricas, evidencia estable, almacenamiento separado, límites y procedencia de arranque | Recuperación y capacidad sostenida del candidato exacto, aislamiento de STOP, revisión del diff y activación controlada siguen siendo requisitos |
| Financiación | Validador offline separado | No forma parte del proceso de activación de la sombra ni autoriza recalcular balances |
| Site | Módulos de presentación e ingestión necesarios para pruebas locales de contratos | Este conjunto parcial no es la aplicación del Site ni un candidato de publicación |

**Runtime AWS: NO VERIFICADO en esta entrega.** Un hash de código en Git o en disco no demuestra qué bytes cargó el proceso. No se acredita despliegue, reinicio, activación de sombra, modificación del Site, cambio de riesgo ni operación de trading con este checkpoint.

El código optativo nuevo permanece sin activar. La cartera principal, sus contratos, la autenticación y el transporte existente no se cambian mediante este trabajo de conservación. No se actualizan dependencias ni lockfiles.

## Verificación nueva en esta copia aislada

Entorno: Node `v24.19.0`, Python `3.12.14`. Dependencias de desarrollo ya instaladas, compartidas mediante un enlace local ignorado por Git; no se hizo instalación limpia en esta copia.

```sh
node --import ./docs/trading/audit-stage1-2026-11-05/no-network.mjs --test --test-isolation=none --test-reporter=tap test/l100-feasibility.test.js test/secondary-notification-policy.test.js test/trading-live-payload-budget.test.js
python3 -B test/lumi-stage0-collector.test.py
```

- Tres suites Node: **40 aprobadas, 0 fallidas, 0 omitidas**, salida 0.
- Colector Python: **24 aprobadas, 0 fallidas, 0 omitidas**, salida 0.
- `git diff --check`: salida 0.

Los datos económicos son fixtures sintéticos; se usan SQLite temporal y transporte simulado. Las pruebas no contactan AWS, el Site publicado ni Telegram. La advertencia `DASHBOARD_LIVE_PAYLOAD_LIMIT` es el fallo esperado que comprueba el caso de crecimiento no compactable: no acredita un error observado en producción.

Cobertura: límites de viabilidad LONG/SHORT, coste y financiación conocidos/desconocidos, ciclo con parciales; avisos de apertura/cierre, deduplicación, recuperación y resultados de entrega ambiguos; presupuesto del payload live y conservación del detalle; lectura consistente, índices, límites, muestreo, duplicados y conflictos en cierres del colector.

No se volvió a ejecutar aquí toda la regresión histórica de sombra. Estos 64 casos no sustituyen capacidad sostenida, recuperación con copia operativa autorizada, pruebas de navegador ni evaluación económica de una política.

## Continuación y reversión

1. Recuperar el commit de este checkpoint y contrastar el manifiesto de archivos. Conservar cualquier cambio posterior del repositorio.
2. Obtener la lectura actual mediante la conexión autorizada o el colector `docs/trading/implementation/stage0/lumi_etapa0.py`. Revalidar cuenta, instancia y servicio; no intentar autenticar con claves pegadas en el chat. El colector solo lee y produce un resumen privado que **no debe añadirse a esta rama pública**.
3. Comparar el runtime verificado con los cambios concretos. Separar la reparación de publicación, los avisos, la integridad y la sombra; no activar automáticamente todos los archivos conservados.
4. Antes de un incremento operativo: copia consistente y recuperación aislada, único escritor con fence, contratos abiertos conservados, pruebas afectadas y rollback de código/configuración. No restaurar una base antigua sobre fills o actividad más recientes.
5. Activar únicamente el incremento validado y autorizado; acreditar PID, arranque, versión, propietario/fence y resultados. Persistir la evidencia operativa en un soporte privado, no en este repositorio público.

Para revertir este checkpoint de código, usar un commit inverso acotado que conserve cambios ajenos. No ejecutar comandos de despliegue, restauración de datos o actualización Quant desde esta rama como sustituto de los controles pendientes.

## Revisión de exposición

Se comprobaron los 34 archivos contra el commit de origen y se buscaron firmas de claves AWS, claves privadas, JWT y tokens Telegram: cero coincidencias. Esto es una comprobación limitada, no una certificación exhaustiva de secretos. Los identificadores históricos de infraestructura y la dirección del Site son visibles en fuentes heredadas/colector; no otorgan acceso. No se incluyen respuestas AWS, capturas con cifras reales ni logs privados. Los secretos de prueba declarados en fixtures son exclusivamente sintéticos y sin validez operativa.

## Incremento Site separado

La aplicación existente recibió v41 el 13/11/2026 a las 10:11 UTC, desde el commit interno de Sites `373fa56d0ae45dfab1c41f33de7dd6d1da7342d1`, basado en `41c1d2bef9e27d82e6cd4b8f652cfcecf7f320c3`. Cambian únicamente tres archivos del Site para presentar bid/ask de PF_XBTUSD y sus fechas; no forma parte del paquete de worker de este checkpoint. SHA-256 del artefacto: `bddd25a2149dcd6507e4457340b9ff85af900e2851c08bbbe4a3a4a2f8404226`. Validación local: 29 escenarios WebKit, 8 focales, lint completo, tipos y build. Comprobación publicada: ambas rutas, navegación, lectura de varios ciclos y denegación anónima de rutas/datos; acceso de servicio autorizado, no sesión interactiva en iPhone. El productor AWS puede publicar datos antiguos: mostrar su antigüedad no repara la ingesta. La fuente completa se conserva en el mismo repositorio privado de Sites; los módulos parciales presentes aquí son fixtures de contrato de la base y no sustituyen esa fuente. Reversión del Site: v40 en el mismo proyecto, sin restaurar datos ni alterar audiencia.
