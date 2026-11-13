# Extensión local: identidad del próximo arranque

Rama actual `fix/lumi-monitor-notices-identity-2026-11-13`, derivada de `3ad11dd`. Código probado: `d2baf52fec259bd678e28205633b0c5a082f53ee`; las modificaciones posteriores son documentación y artefactos generados, sin cambiar las fuentes medidas. Conserva intacta la entrega anterior de tres archivos en su rama y agrega únicamente `worker-release-identity.js` y llamadas de identidad en `scripts/trading-worker.mjs`; el generador del manifiesto es una herramienta offline. El manifiesto actual enumera los cinco archivos runtime y distingue la herramienta y el manifiesto generado y contrastado con los 68 archivos de su alcance estático.

Reutilización de `c2442db`: se elimina el thread sombra de los roots/archivos obligatorios y se declara `TRADING_STATIC_IMPORTS_WITH_DECLARED_BOUNDARIES`. No se importan el observador, su gestión de recursos, hooks ni cambios de shutdown. Una prueba compara el worker completo contra `9f8648a` quitando solo estas adiciones: guardias, feeds, STOP, límites de recursos, flush y parada permanecen idénticos.

Prueba nueva de esta extensión: **33/33 aprobadas**, salida 0, sin omitidas (15 de identidad y 18 de monitor/avisos). Se repitieron los seis escenarios de equivalencia, 57 snapshots/180 decisiones y cuatro transiciones con igualdad exacta. Son fixtures sintéticas; el harness económico no inicia el entrypoint real. Los 81 casos descritos más abajo son la ejecución anterior sobre `0d163ccd`, no 81 casos nuevos. Evidencia: `evidence/identity-focused.tap`, `identity-run.json`, `identity-strategy-equivalence.json` y `identity-equivalence-run.json`.

La inspección estática real, sin ejecutar módulos, encuentra **68 archivos / 869.155 bytes** y un borde no inspeccionado hacia `lib/telegram-review-v1/runtime.js`. No incluye módulos sombra, modelos dinámicos o bytes instalados de paquetes. `identity-source-scope.json` es evidencia de inspección de fuentes sin commit, **no** un manifiesto de release. Tipos de archivo, rutas, symlinks, tamaño acumulado y modificaciones durante lectura se comprueban con límites explícitos.

En el próximo arranque autorizado, el mismo proceso mide las fuentes listadas en disco antes de adquirir el lease, registra PID, estimación UTC de arranque, digest del manifiesto y del árbol, y después de `engine.initialize()` vincula hash del propietario, fence y revisión adquiridos. El evento `WORKER_RELEASE_IDENTITY` entra en el checkpoint normal; el log `lumi_trading_started` no equivale a confirmación durable. El heartbeat identifica si propietario/fence coinciden con el arranque, pero no valida por sí solo la vigencia del lease. **`loaded_source_attested:false` permanece siempre**: los imports ESM ya se ejecutaron antes del hash; no hay attestation de memoria, del grafo completo ni del commit por parte del proceso. El commit es declaración del manifiesto cuyo contenido el empaquetador contrasta con Git offline.

Generación ejecutada sobre el commit exacto de fuentes; para reproducir, usar un destino nuevo:

```sh
node --experimental-vm-modules scripts/trading-worker-release-manifest.mjs d2baf52fec259bd678e28205633b0c5a082f53ee RUTA_NUEVA_MANIFIESTO.json /workspace/lumi-monitor-notices-identity
```

El generador rechaza fuentes distintas del commit y salidas ya existentes. Copiar ese resultado al path `deploy/trading/worker-release-manifest.json` únicamente dentro del paquete final, registrar su SHA-256 y probar `inspectWorkerRelease` sobre la copia empaquetada. El generador no necesita ejecutarse en EC2. Un manifiesto ausente/incorrecto deja estado explícito de identidad no verificada; no se falsea un commit ni se modifica el motor para iniciar.

**Manifiesto generado y verificado en una copia aislada; no desplegado.** `worker-release-manifest.json` SHA-256 `8bb405d4914ad42dfefe7c2a34009604edea13ed1af8e1f01946fd20c4448f8e`, árbol estático `f76b00359ac2bc7f831f9799b0ff5dbac9276d108a8f4fef28b04ce30acca00e`; `evidence/packaged-identity-verification.json` comprueba 68/68 archivos del commit. El overlay nuevo incluye cinco fuentes runtime y este manifiesto en `deploy/trading/worker-release-manifest.json`, además de documentación separada. Ningún secreto, base, modelo, fixture o herramienta de empaquetado se instala en AWS. El overlay anterior de tres archivos no contiene esta extensión y permanece recuperable. El `runtime-only.patch` actual comprende los cinco archivos y permite comprobar la reversión de fuentes en aislamiento. Al revertir esta extensión, restaurar el entrypoint anterior y retirar solo el módulo/manifiesto de identidad; conservar ledger, fills y eventos posteriores. No existe migración de estado.

La lectura operacional facilitada al integrador indica poco espacio y gate de respaldo pendiente. Esta reparación local no resuelve capacidad, copia consistente ni restaurabilidad: la activación continúa bloqueada. Antes de activarla deberán cerrarse esos gates y comprobarse en lectura el nuevo PID/start con el receipt, digest del paquete, hash del owner/fence SQL y recepción durable del evento, sin afirmar attestation de bytes cargados.

---

## Registro conservado del incremento monitor/avisos anterior

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
