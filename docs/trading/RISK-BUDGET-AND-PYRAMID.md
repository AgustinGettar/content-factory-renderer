# Presupuestos finitos, tamaño, margen y pirámides PAPER

## Alcance y versión experimental

`secondary-risk-budget-1.0.0` amplía sólo los contratos NUEVOS de la secundaria
`FREQUENT_PAPER`, instrumento `PF_XBTUSD`. No añade dinero, otra cuenta, otro
broker, otra conexión de trading ni otro escritor SQLite. La principal y el
contenido audiovisual no forman parte de esta política.

El contrato nuevo se llama `secondary-risk-execution-1.0.0` y contiene un recibo
inmutable `execution_contract.risk_budget`. Conserva íntegro el contrato base de
exploración, su hash, los parámetros y los presupuestos de la decisión. La cantidad,
stop, objetivo, horizonte y políticas de un contrato ya seleccionado nunca se
reescriben al activar o desactivar la política. El motor reconoce independientemente
los contratos históricos de exploración/asignación con ×2 y los nuevos hasta ×10.

## Parámetros fijados antes de evaluar resultados

| Límite | Valor inicial |
| --- | --- |
| Riesgo por tramo | Menor entre 0,5 % del patrimonio de presupuesto y 10 USD |
| Riesgo por movimiento completo | Menor entre 1 % y 20 USD |
| Riesgo abierto/reservado de cartera | Menor entre 3 % y 50 USD |
| Margen inicial conjunto | Hasta 50 % del patrimonio de presupuesto |
| Exposición bruta conjunta | Hasta 3 veces el patrimonio de presupuesto |
| Estrés adicional de ejecución | 0,05 % del nominal; separado de los costes contabilizados |
| Apalancamientos elegibles | 2, 5 y 10; se elige el menor que financia la cantidad permitida |
| Nominal de referencia | 300 USD, sujeto a todos los límites |
| Objetivo monetario aspirado | 1 USD neto al objetivo estructural disponible |
| Posiciones/órdenes pendientes | Hasta 10 IDs únicos en conjunto |
| Tramos por movimiento | Inicial y hasta dos ampliaciones; tres durante toda su vida |
| Recargas automáticas | Ninguna |
| Cambio de tamaño para recuperar pérdidas | Ninguno |

Estos límites son hipótesis de ingeniería para una simulación experimental. No
proceden de una optimización retrospectiva ni demuestran rentabilidad. Una
configuración diferente requiere una versión nueva de la política, no un barrido
de variables de entorno hasta encontrar ganancias.

El patrimonio de presupuesto es el menor entre el patrimonio marcado y
`efectivo + margen inicial ya bloqueado`. Así una pérdida reduce capacidad y la
ganancia flotante no se convierte en crédito garantizado para otra apuesta.
El margen de posiciones abiertas ya fue debitado del efectivo: no se vuelve a
restar al calcular caja disponible. Se reservan aparte los remanentes pendientes
y la financiación aún necesaria.

## Cantidad, exposición y margen

Se calcula la pérdida al stop por unidad de BTC usando entrada ejecutable,
stop contractual, dirección LONG/SHORT, comisiones de entrada y salida,
deslizamiento incorporado al precio y financiación para el horizonte máximo
firmado. A ese riesgo se suma el estrés de ejecución de 5 puntos básicos. El
estrés es una reserva hipotética; no es una comisión ni una resta adicional del
P&L realizado.

La cantidad máxima por riesgo es el presupuesto disponible dividido por esa
pérdida por unidad con estrés. La cantidad deseada intenta cubrir el nominal de
referencia y, cuando exige más exposición, el importe necesario para obtener
aproximadamente 1 USD al objetivo existente. Luego se aplican margen, exposición
bruta, liquidez observada y caja compartida. Se redondea hacia abajo al incremento
real del instrumento.

El recibo registra exposición necesaria para la aspiración, exposición solicitada
y asignada, riesgo, margen, reserva, límite efectivo y si la aspiración cabe. Si
no cabe, puede seleccionar una cantidad menor con objetivo inferior a 1 USD.
Nunca aleja el objetivo, suprime el stop ni convierte ese dólar en condición de
salida. La política económica independiente sigue comprobando la calidad neta
prevista de la entrada.

El leverage determina `margen = exposición / leverage`. El P&L sigue siendo la
cantidad ejecutada multiplicada por el movimiento favorable, menos los costes.
No se multiplica otra vez por leverage. Subir ×2 a ×10 con la misma cantidad no
aumenta el P&L.

La ejecución después de la latencia vuelve a comprobar costes, financiación,
riesgo firmado, presupuestos de tramo/movimiento/cartera, margen, exposición y
caja. Si la cotización empeora puede ejecutar menos cantidad y cancelar el
remanente; el contrato no se redimensiona retrospectivamente. El recibo de fill
registra la cantidad realmente ejecutada. Nunca consume reservas de otras
órdenes ni reutiliza volumen ya consumido de la misma cotización.

## Movimiento y ampliaciones

Se aplica una agrupación conservadora: exposición BTC solapada en la misma
dirección se considera el mismo movimiento, aunque cambien patrón o plazo.
La primera versión no presupone que dos señales del mismo BTC sean diversificación
independiente. Esto puede limitar oportunidades simultáneas; diez es un techo,
no una cuota de operaciones.

Cada tramo lleva `movement_id`, `parent_id`, `leg_index` e identidad idempotente de
confirmación/version/plazo. El registro de movimientos conserva los tramos ya
seleccionados y su riesgo comprometido: cerrar uno no devuelve un cupo para un
cuarto tramo del mismo movimiento. Los contratos de cada tramo son independientes.

Una ampliación exige:

- Confirmación causal nueva del contexto de entrada. Otra vela o lectura de la
  misma confirmación se rechaza.
- Primera posición aún abierta, favorable, con financiación resuelta y protección
  activa. Su neto debe seguir estrictamente por encima del piso vigente.
- No haber cruzado el stop ni alcanzado el plazo efectivo o estancamiento.
- Liquidez restante para la posición inicial y capacidad para el nuevo tramo,
  considerando el consumo compartido de la cotización.
- Recorrido neto restante, margen y presupuestos de movimiento/cartera suficientes.

Se comprueba tanto al seleccionar como antes de ejecutar. Esto evita abrir un
hijo en la misma cotización que ya requiere cerrar al padre, aunque el ciclo del
broker procese entradas antes de supervisar salidas.

La ganancia protegida no reduce el riesgo calculado de las demás posiciones ni
financia otra apuesta. Añadir un tramo no toca el piso del padre. Cerrar un tramo
no cierra los demás ni otro movimiento; no existe cierre de grupo implícito.

## Modelo de margen: aproximación explícita

`secondary-isolated-bbo-margin-1.0.0` es un **modelo de estrés de margen aislado por
tramo**, no una réplica del motor de liquidación de Kraken. Usa el bid/ask adverso
observado y costes del simulador. No dispone del mark price, haircuts de colateral,
escalones de mantenimiento, cartera real, ADL ni ejecución de liquidaciones del
exchange.

El patrimonio del tramo para este modelo es margen inicial más P&L bruto marcado
menos financiación conocida. La comisión de entrada ya fue pagada al entrar.
El mantenimiento experimental es 1 % de la exposición marcada; se reserva además
la comisión de cierre. Cuando el patrimonio llega a ese límite, solicita una salida
`ISOLATED_MARGIN_STRESS`, durable e idempotente, ejecutada con la latencia y liquidez
observadas. No aplica una comisión de liquidación inventada; el campo contractual
adicional vale cero y el modelo declara esta limitación.

Antes de aceptar la entrada se comprueba que la pérdida al stop más costes,
financiación y estrés deje margen por encima del mantenimiento del modelo. Esto
no garantiza un fill al stop. Un salto puede cerrar peor que el piso, superar el
margen aportado o dejar saldo ficticio negativo. El simulador registra esa pérdida;
no la limita artificialmente ni recarga la cuenta. Una financiación no resuelta
se señala en el recibo; el modelo utiliza sólo los importes conocidos y no afirma
que la liquidación real pueda reconstruirse exactamente.

Las diferencias con Kraken pueden consultarse en su documentación primaria:

- https://support.kraken.com/gb/articles/4844463246100-margining-liquidations-multi-collateral-derivatives
- https://support.kraken.com/articles/4402283092244-liquidation-faq-derivatives

## Persistencia, aprendizaje y reversión

La política y el registro de movimientos se guardan dentro del estado existente.
La recuperación valida el contrato completo, el tamaño firmado y la asociación
al movimiento. La unión de IDs evita contar dos veces una posición con remanente
pendiente; riesgo, exposición y reservas sí suman sus cantidades distintas.

Los nuevos snapshots neuronales usan `plan.movement_id` cuando existe. Los
históricos mantienen su identidad previa. Tres tramos del mismo movimiento no
se presentan como tres observaciones independientes. Los dominios conservan
versión de ejecución, entrada, salida y hashes. El modelo de entrada de 5m no
adquiere autoridad para otros plazos ni para salidas por esta política.

Activación: `LUMI_TRADING_SECONDARY_RISK_BUDGET=secondary-risk-budget-1.0.0`, mediante
el helper de despliegue autorizado y junto con la política de protección compatible.
`OFF` detiene la selección de contratos nuevos de este perfil; conserva toda la
gestión de los ya pendientes/abiertos. No restaura una base vieja ni un binario que
ignore estos contratos. La política histórica de asignación permanece guardada
para compatibilidad; su recibo de aporte previo no se toca.

El helper exige protección v2 y un marcador de capital finito ya existente antes
de activar riesgo o plazos; preserva nominal, perfil, parámetros económicos,
modo neuronal y recibo de capital. Esta entrega no mezcla esos cambios con una
solicitud de financiación o un cambio de autoridad neuronal. Su comando heredado
para cambiar explícitamente el modo neuronal a un valor distinto de `OFF` todavía
exige protección v1; también conserva esa restricción para reactivar asignación
de capital. Esto no impide conservar el modo neuronal ya instalado con v2.
Una futura modificación de esos comandos requiere mantenimiento y validación
específicos; no debe degradar la política de protección para superar el guarda.

## Evidencia de pruebas

`test/secondary-risk-budget.test.js` contiene escenarios sintéticos externos al
worker: presupuesto por stop, aspiración inferior a 1 USD, ×10/margen/P&L y reinicio,
coexistencia ×2, diez IDs, parciales, pirámides de tres tramos, rechazo de
confirmaciones repetidas y padres con salida debida, liquidez compartida,
recuperación idempotente, estrés postlatencia, saldo insuficiente, desfase de datos,
financiación e intención de salida de margen a precio real posterior.

Estas pruebas verifican comportamiento funcional y contabilidad. No son entradas
naturales, backtest de rendimiento ni evidencia de ventaja estadística. Los
resultados prospectivos deben comparar exposición/riesgo semejantes y agrupar
por movimiento.
