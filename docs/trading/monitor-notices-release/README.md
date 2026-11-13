# Candidato mínimo de monitor y avisos — revisión local

Rama `fix/lumi-monitor-notices-release-2026-11-13`. Base y HEAD inicial: `9f8648abe12cb3457814bae9074d8e666fd56cba`. Código probado registrado en `0d163ccd85d9528251e894caf968b0284dc0d709`; documentación posterior no modifica las tres fuentes runtime. No se ejecutaron acciones remotas, despliegues, reinicios, envíos Telegram ni escrituras operativas.

La evidencia de AWS facilitada al integrador acredita esa revisión y las huellas de los archivos **en disco**, no el código cargado por el PID. Este candidato no incorpora instrumentación nueva de arranque ni convierte esa evidencia en una identificación del proceso.

## Inventario estricto

| Archivo runtime | Cambio |
| --- | --- |
| `lib/trading/dashboard-publisher.js` | Extraído únicamente de `cdfd04b`: compacta aliases idénticos y el historial interno Quant del payload live, preserva los resúmenes públicos completos y el detalle; registra exceso del límite existente de 1 MiB. |
| `lib/trading/secondary-futures-runtime.js` | Extraído únicamente de `4fe2a8e`: un import y la clase `SecondaryNotifier`. El resto del archivo es byte por byte igual a la base. |
| `lib/trading/secondary-notification-policy.js` | Política optativa de avisos de apertura ejecutada y cierre final de la secundaria PAPER. |

El manifiesto enumera las huellas previas y nuevas de los tres archivos. No se trasladaron reparaciones anteriores de contadores, evidencia de parciales, sombra, financiación, L100, estrategia, riesgo, transporte, autenticación, configuración ni Site. No hay migraciones o dependencias nuevas. El paquete es un conjunto de **reemplazos sobre la base indicada**, no una aplicación autónoma.

`test/fixtures/published-site-contract/` conserva siete módulos reales de presentación/ingesta y sus huellas, provenientes de la entrega local del Site. Se usan exclusivamente como dependencias de prueba aisladas; no forman parte del paquete AWS. No certifican autorización desplegada. El guard de red impide conexiones externas y Telegram usa un doble en memoria.

## Pruebas sobre este candidato

Node `v24.19.0`, dependencias locales existentes compartidas mediante symlink; `package.json` y lockfile son los de la base. No se efectuó una instalación nueva ni se afirma equivalencia de versión Node con AWS.

```sh
node --import ./docs/trading/audit-stage1-2026-11-05/no-network.mjs --test --test-isolation=none --test-reporter=tap test/secondary-notification-policy.test.js test/trading-notifier.test.js test/secondary-exploration-monitor.test.js test/secondary-profit-monitor.test.js test/secondary-futures.test.js test/trading-live-payload-budget.test.js test/trading-live-dashboard.test.js test/trading-runtime-performance.test.js test/trading-dashboard-backup.test.js
LUMI_EQ_BASE_COMMIT=9f8648abe12cb3457814bae9074d8e666fd56cba node test/stage2-strategy-equivalence.mjs docs/trading/monitor-notices-release/evidence/strategy-equivalence.json
```

- **81/81 casos aprobados, 0 fallidos u omitidos**, salida 0. Comando, UTC, versiones y hashes en `evidence/focused-run.json`; salida íntegra en `evidence/focused.tap`.
- **Seis escenarios equivalentes**, con 57 snapshots económicos y 180 decisiones; cuatro transiciones de versión/reversión equivalentes. Mismas entradas sintéticas y comparación exacta de cantidades, contratos, stops, objetivos, componentes monetarios y decisiones. El harness previo solo cambia su lista de archivos de huellas: no necesita el módulo de métricas excluido de este candidato.
- Recuperación SQLite tras parcial, neto acumulado del ciclo, cierre medio ponderado, duplicados, claim incierto y fallo de persistencia cubiertos. La política no reenvía un resultado ambiguo y no modifica la cartera principal.
- Publisher normal → handler real de Site aislado: con 2.000 outcomes y 135 dominios de comparación sintéticos, live **119.506 bytes**, detalle **1.243.057 bytes**; dos revisiones sucesivas aceptadas. Ambos modelos de presentación reciben cifras y frescura equivalentes. Todos los outcomes permanecen en detalle.
- La prueba de 2.000 outcomes está sin posiciones abiertas. Los escenarios de diez posiciones, 30 cierres y pendientes son casos independientes. Las estimaciones de margen de los tests antiguos usan su baseline histórico; no son mediciones del payload actual de AWS.
- Resúmenes incompletos o incompatibles no se compactan como si fueran válidos. Crecimiento no compactable informa `DASHBOARD_LIVE_PAYLOAD_LIMIT`; no se elevó el límite del Site.
- `node --check` de los tres módulos y `git diff --check`: salida 0.

Estas pruebas son sintéticas y locales. No demuestran rentabilidad, recuperación del host, disponibilidad de un respaldo, causalidad definitiva del estancamiento observado ni envío real de Telegram.

## Activación optativa y reversión

El selector exacto es `LUMI_TRADING_SECONDARY_NOTICES=secondary-position-lifecycle-1.0.0`. Requiere que ya estén verificados `LUMI_RUNTIME_ENV=staging`, `LUMI_TRADING_MODE=PAPER` y `LUMI_TRADING_STORAGE=SQLITE`. No cambiar esos valores para forzar la activación. Sin selector, la entrega de avisos permanece con el comportamiento anterior. La política usa los contratos y transporte existentes.

La compactación del publisher se aplica al cargar sus nuevas fuentes; no tiene flag. La activación/reversión del proceso requiere el procedimiento controlado de escritor único que defina el integrador, fuera de esta preparación local. No se ejecuta ningún reinicio aquí.

Reversión de código exacta: restaurar los dos archivos reemplazados con las huellas `base_sha256` del manifiesto y retirar el nuevo módulo una vez retirado su import; eliminar exclusivamente el selector de avisos añadido por este incremento. En una copia de trabajo sin cambios posteriores, la reversión puede comprobarse y prepararse con:

```sh
git apply --check --reverse docs/trading/monitor-notices-release/runtime-only.patch
git apply --reverse docs/trading/monitor-notices-release/runtime-only.patch
```

Estos comandos son para una **copia aislada** y no detienen ni actualizan un servicio. Nunca restaurar una base antigua, saldo ni outbox. Los avisos ya entregados o suprimidos conservan su recibo; no se vuelven a encolar al revertir. Los estados `REJECTED` usados para supresión son diagnósticos de entrega, no decisiones de trading.

## Artefacto y siguiente paso

Overlay privado recuperable: `/workspace/lumi-monitor-notices-artifacts/lumi-monitor-notices-0d163cc.tar.gz`, con los tres módulos, manifiesto y checksums. `runtime-only.patch` permite revisar/reproducir exclusivamente el cambio runtime. El manifiesto identifica el commit de código probado; el checksum final del overlay se conserva en `overlay-receipt.json`. No se certifica activación.

Pendiente: cierre de las lecturas de configuración/ledger/journal, confirmación de entorno y procedimiento de recuperación/escritor único, comprobación de deriva en disco antes de cualquier actualización. No usar el actualizador Quant. El Site, sus conexiones, la financiación offline y los cambios de riesgo están fuera de este paquete.
