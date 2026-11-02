# Lumi Trading PAPER: margen útil y protección dinámica

Esta política amplía el motor secundario existente `secondary-futures-1.0.0`, instrumento `PF_XBTUSD`, dentro de `secondary-paper-exploration-1.0.0`. No crea otra cartera, otro proceso escritor ni un envío de órdenes al exchange. Los parámetros son un ensayo operativo explícito; no constituyen una validación estadística ni una promesa de rentabilidad.

## Versiones y alcance

| Contrato | Versión |
| --- | --- |
| Política persistida | `secondary-profit-policy-1.0.0` |
| Revisión de nuevas entradas | `secondary-entry-useful-margin-1.0.0` |
| Recibo económico | `secondary-entry-economics-1.0.0` |
| Política de salida | `secondary-net-trailing-1.0.0` |

La política se aplica a señales nuevas. Cada plan guarda sus contratos `economic_policy` y `exit_policy`, con el hash de la configuración que los originó. Una desactivación o un cambio posterior de parámetros no reinterpreta órdenes o posiciones anteriores. Los protocolos históricos, sus hashes y las operaciones cerradas permanecen intactos.

La principal no recibe este perfil. En la secundaria se mantienen desactivados los bloqueos financieros de la exploración: pérdidas, drawdown, rachas, cupos diarios, rechazo de ensayos anteriores, límites financieros de exposición y exigencias de promoción. Rechazar una entrada por recorrido económico insuficiente no detiene la evaluación del motor.

## Parámetros iniciales

| Parámetro | Valor inicial | Significado |
| --- | --- | --- |
| `min_expected_net_target_fraction` | `0.002` | Neto previsto al objetivo ≥ 0,20 % de exposición efectiva |
| `retracement_fraction` | `0.25` | Retroceso permitido del 25 % del máximo neto observado |
| `funding_estimation_ms` | `1800000` | Estimación inicial de financiación de 30 minutos |
| `base_holding_ms` | `1800000` | Plazo base de 30 minutos desde la entrada |
| `trailing_extension_ms` | `900000` | Extensión única de 15 minutos respecto del plazo base |
| `stagnation_ms` | `600000` | Salida tras 10 minutos sin un nuevo máximo válido |

Se conserva el nominal experimental configurado y el apalancamiento del perfil de exploración. Ni una recarga ficticia, ni una pérdida, ni el filtro económico aumentan el tamaño. Los cambios explícitos de parámetros quedan reflejados en la configuración persistida, su hash y su historial.

## Detección, admisión y ejecución

`secondary-entry-context.js` conserva las condiciones de BREAKOUT, PULLBACK y RANGE_REENTRY, las velas cerradas de entrada de 5 minutos y el contexto de 15 minutos. También conserva el cálculo estructural de stop y objetivo. El objetivo no se aleja para superar un filtro.

Una detección produce un candidato y su evidencia causal. El broker calcula su cantidad redondeada al lote del instrumento; entonces `evaluateEntryEconomics` decide la admisión. Una señal detectada cuyo neto no alcanza el mínimo permanece registrada con `EXPECTED_NET_TARGET_BELOW_MINIMUM` y el recibo completo. No se presenta como ausencia de patrón.

El recibo separa precio ejecutable estimado, cantidad, exposición, objetivo, stop, comisiones de entrada y salida, financiación estimada, neto al objetivo, pérdida neta al stop y RR neto. El RR continúa siendo descriptivo; esta política no restablece un veto universal de RR 1,5 ni una probabilidad inexistente.

### Cálculo económico

Sea `q` la cantidad efectiva en BTC, `e` el precio de entrada ejecutable estimado y `s` igual a +1 para LONG o −1 para SHORT:

```
exposición efectiva = q × e
mínimo neto = exposición efectiva × 0.002
precio de salida previsto = nivel estructural × (1 − s × slippage)
bruto previsto = q × s × (precio de salida previsto − e)
neto previsto = bruto previsto − comisión de entrada − comisión de salida − financiación estimada
```

Para la previsión, el objetivo se interpreta como nivel del bid de cierre LONG o del ask de cierre SHORT. Sigue siendo una hipótesis futura, no liquidez observada ni un precio garantizado. En la entrada taker se usa el ask para comprar o el bid para vender, con deslizamiento adverso y redondeo del precio conforme al modelo existente.

El spread y el deslizamiento ya incorporados en los precios no se vuelven a descontar del neto. Se muestran por separado como costes embebidos y métricas de ejecución. La comisión de entrada depende de maker/taker; la de salida es taker. La financiación prevista usa el valor absoluto de la tasa horaria disponible durante el horizonte inicial de 30 minutos. La contabilidad de la posición conserva la financiación efectiva con su signo, y continúa acumulándola durante una eventual extensión.

El denominador es exposición, no margen: una cantidad `0.0012` con entrada `78246` representa `93.8952` USD, aunque su margen sea la mitad. Su mínimo neto inicial es `0.1877904` USD. No se vuelve a multiplicar por el apalancamiento.

Antes de cada ejecución, también una parcial, se recalcula la economía con la cotización posterior a la latencia, el precio de ejecución modelado, la cantidad que puede llenarse y la financiación vigente. El recibo `PRE_EXECUTION` requiere financiación disponible; no reutiliza silenciosamente una estimación antigua. Un movimiento adverso puede cancelar una orden previamente admitida. Un llenado rechazado no crea una posición ni costes de ejecución.

La vía inicial sigue siendo taker IOC simulada con latencia, bid/ask, participación limitada en liquidez compartida y cancelación del remanente. Maker conserva su contrato específico cuando la hipótesis requiere un retroceso. Una orden previa no cambia retrospectivamente de modalidad.

### Regresión de los tres PULLBACK históricos

Las pruebas aisladas conservan identificadores y valores reducidos de los tres cierres observados el 2 de noviembre de 2026 a las 06:19:10 UTC, todos SHORT con objetivo `78138` y cantidad `0.0012`:

| ID de operación, prefijo | Entrada prevista | Exposición efectiva | Neto previsto al objetivo | Mínimo nuevo |
| --- | ---: | ---: | ---: | ---: |
| `8a746e37232b` | 78246 | 93.8952 | 0.01676957495160471 | 0.1877904 |
| `95ec2504d968` | 78207 | 93.8484 | −0.0300543823709625 | 0.1876968 |
| `fc2c1bf06e36` | 78184 | 93.8208 | −0.057712698132015 | 0.1876416 |

Las tres previsiones quedarían rechazadas por esta política nueva. Esto es una prueba de regresión, no una modificación de su historia. Las pruebas también recalculan con los precios de llenado realmente registrados, distintos de los previstos. El beneficio previsto, el no realizado y el realizado se mantienen separados.

## Contexto de otras posiciones

`entry_context` identifica el evento de mercado que originó la confirmación:

- BREAKOUT: episodio continuo de cierres que rompen el canal previo de ocho velas. Otra vela de la misma ruptura conserva la confirmación.
- PULLBACK: episodio continuo de retesteo de EMA9; además registra el pivote estructural previo de veinte velas. Un retesteo separado puede constituir una confirmación nueva.
- RANGE_REENTRY: episodio continuo de excursión fuera de la banda de veinte velas. Una recuperación seguida de una nueva excursión puede generar otra confirmación.

La clave idempotente usa el episodio causal y la revisión nueva, no solo la hora de evaluación. El recibo `context_admission` relaciona posiciones abiertas y órdenes pendientes del mismo patrón y dirección, por estructura, confirmación o un objetivo compartido dentro de un tick.

Una confirmación ya utilizada se rechaza como `REPEATED_CONFIRMATION`. Un cambio de clave que siga refiriéndose a un evento anterior a la confirmación de las posiciones relacionadas se rechaza como `LATE_REPETITION_NO_NEW_CONFIRMATION`. Una confirmación realmente posterior puede ser `ADDITION_NEW_CONFIRMATION`, siempre que su economía propia ya haya superado el filtro. No hay una prohibición general de múltiples posiciones ni de direcciones opuestas.

## Objetivo y protección de ganancias por posición

La gestión nueva distingue `OPEN_BEFORE_TARGET`, `TRAILING_ACTIVE`, `EXIT_PENDING`, `PARTIALLY_CLOSED` y `CLOSED`.

Antes del objetivo rigen el stop, las invalidaciones y el plazo base. Un pequeño neto positivo no cierra la posición. Cuando una cotización nueva y válida alcanza el objetivo, la activación exige financiación reconciliada, neto suficiente para la exposición efectiva de la cantidad restante y liquidez compatible con liquidar esa cantidad según la participación del modelo.

Si se cumple, se registra `TARGET_REACHED`, se notifica una vez y se activa el trailing completo sin liquidación estratégica parcial. Se guardan la hora, el neto de activación, el máximo neto, la protección, la tolerancia de retroceso, la última cotización válida y los plazos efectivos. Si el precio llega pero esas condiciones no se cumplen, se registra `TARGET_REACHED_NET_INSUFFICIENT` con su causa; siguen vigentes stop y plazo base. Una observación posterior válida puede activar dentro de ese plazo.

La protección usa el neto estimado de liquidación de la cantidad restante: bid para cerrar LONG, ask para cerrar SHORT, deslizamiento, comisiones pendientes, coste de entrada asignado a esa cantidad y financiación. No usa LAST, bruto ni una cifra redondeada del panel.

```
tolerancia = máximo neto × 0.25
protección nueva = max(protección anterior, máximo neto − tolerancia)
```

Solo cotizaciones nuevas, válidas, con financiación completa y capacidad suficiente actualizan el máximo. La protección no baja tras un retroceso. Los cálculos se conservan por unidad de cantidad: una salida parcial reescala los totales del remanente de forma auditable y excluye beneficios ya realizados.

Cuando el neto de liquidación llega o cae por debajo de la protección, el broker conserva una intención `TRAILING_RETRACEMENT`. La intención no se borra por pequeños rebotes. La ejecución espera su latencia y una cotización posterior; puede cerrar parcialmente o esperar capacidad. El disparador no garantiza el precio ni el neto final: una salida ya disparada continúa aunque después resulte menor o negativa. Stop e invalidaciones no quedan subordinados a un objetivo de beneficio.

Cada posición conserva cantidad, máximo, protección, plazo e intención propios. Un objetivo compartido puede activar varios trailings, y una cotización puede disparar varios cierres legítimos. Ninguna de esas condiciones equivale a una orden global sobre la cartera. Los controles manuales se dirigen a un identificador; cambiar el objetivo neto es incompatible con el contrato nuevo inmutable.

### Plazo y estancamiento

Al activar se fija una sola extensión: vencimiento base más 15 minutos, es decir, como máximo 45 minutos desde la entrada con los parámetros iniciales. Nuevos ticks y reinicios no prolongan ese límite. Un máximo nuevo y válido mueve el plazo de estancamiento a diez minutos después de ese máximo; el vencimiento duro sigue limitándolo. Los motivos de salida incluyen `TIMEOUT`, `TIMEOUT_EXTENDED` y `TRAILING_STAGNATION`.

### Sensibilidad inicial al spread

La prueba sintética aislada del módulo de protección conserva nominal 100 y activa con neto `0.21`, cuyo umbral protegido es `0.1575`. A mid constante, ensanchar el spread de `0.01` a `0.03` reduce el neto en `0.009993001` y no dispara el cierre. Ensancharlo de `0.01` a `0.13` reduce el neto en `0.059958006` y sí lo dispara.

Esto comprueba una propiedad del modelo: el spread puede producir un retroceso económico real de la liquidación estimada. No mide la frecuencia de ese ruido en mercado ni valida el 25 % estadísticamente. El parámetro inicial se conserva, sin una optimización oculta sobre estos ejemplos.

## Datos, persistencia y presentación

Una interrupción no fabrica un máximo ni un stop. Se conserva el máximo observado y se declara la incertidumbre del recorrido que falta. Financiación no resuelta impide atribuir un máximo neto inequívoco; la reconciliación y la recuperación técnica permiten reanudar. No se inventan cotizaciones obsoletas para ejecutar una intención.

Los planes, recibos, estado del trailing, intenciones, ejecuciones parciales y consumo compartido de liquidez pertenecen a la misma persistencia del motor. El arranque valida contratos y estado; no reconstruye un máximo ausente a partir de información futura. Notificaciones de activación y cierre usan el transporte y outbox existentes, sin mensajes por tick.

El monitor separa objetivo previsto, neto no realizado, máximo, protección como umbral de cierre, retroceso y resultado realizado. Cuenta posiciones a partir de los identificadores persistidos. El embudo usa contadores reales por patrón y versión, incluidos rechazos económicos y de contexto; la última decisión no se convierte artificialmente en un total. Aportes, recargas ficticias, saldo, patrimonio y P&L continúan separados.

## Despliegue y reversión compatibles

El script existente mantiene el lease de release/configuración, el HEAD remoto exacto de `lumi-trading-aws`, la lista explícita de archivos permitidos, el respaldo consistente de SQLite y un solo servicio. Reutiliza dependencias y no ejecuta suites, instalaciones ni backtests sobre el worker.

Antes de la sustitución prueba la migración pura sobre un clon en memoria, y vuelve a hacerlo con el servicio detenido y el estado final. Aplica ambas migraciones dos veces, comprueba idempotencia de estado y eventos, preserva cuenta, principal, posiciones, pendientes y protocolos anteriores. Después exige una revisión nueva persistida y coincidencia exacta de versión, estado, hash y parámetros de la política.

Activación inicial, reemplazando los dos SHA por commits exactos ya verificados:

```sh
python3 scripts/trading-aws-exploration-update.py COMMIT_PROBADO \
  --expected-current COMMIT_ACTIVO \
  --profile secondary-paper-exploration-1.0.0 --nominal 100 \
  --profit-policy secondary-profit-policy-1.0.0 \
  --min-expected-net-target-fraction 0.002 \
  --trailing-retracement-fraction 0.25 \
  --trailing-extension-ms 900000 \
  --trailing-stagnation-ms 600000
```

Si se omiten los flags de política y parámetros, el script preserva la configuración existente. Proporcionar parámetros sin `--profit-policy` es un error visible. La reversión admitida conserva el mismo binario compatible y utiliza `--profit-policy OFF`, con el perfil de exploración y nominal efectivos preservados. Las posiciones ya abiertas conservan su salida contratada; OFF cambia solamente la política de señales futuras.

Ante un fallo posterior al cambio de release, la recuperación automática mantiene el binario compatible y desactiva esta política conservando la exploración. No restaura un binario anterior incapaz de leer los contratos nuevos ni reemplaza el ledger con un backup antiguo. El backup es evidencia y recurso de recuperación controlada, no un mecanismo para borrar operaciones posteriores.

## Verificación

Las pruebas aisladas cubren los tres casos históricos, detección de los tres patrones en ambas direcciones, economía posterior a latencia, cantidades parciales, contexto causal, conservación de contratos anteriores, protección y cierre independientes, objetivos compartidos, falta de liquidez, reinicios, financiación incierta, controles por identificador, presentación y despliegue reversible. Los ejemplos sintéticos no se insertan en la cartera operativa.

Una prueba aislada aprobada no acredita una ejecución natural. La entrega operativa debe informar por separado commit/release/configuración efectivos, evaluaciones naturales, rechazos, órdenes y ejecuciones realmente observados, sus identificadores y cualquier tramo todavía pendiente de observación.
