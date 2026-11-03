# Protección neta temprana — experimental PAPER 2.0.0

## Alcance de la primera entrega

Política nueva `secondary-profit-policy-2.0.0`, revisión de entrada
`secondary-entry-useful-margin-2.0.0` y salida
`secondary-net-protection-2.0.0`. Se aplica exclusivamente a nuevos contratos de
`FREQUENT_PAPER`, `PF_XBTUSD`, dentro del broker existente. La primera entrega
activa protección y trazabilidad; no activa por sí misma nuevos plazos, otro
tamaño, apalancamiento ni ampliaciones. No entrena redes ni depende de ellas.

La admisión económica sigue en 0,002 del nominal efectivo, con revalidación
posterior a la latencia y en cada ejecución. Es una condición de entrada,
independiente de la activación de protección. No se exige +1 USD para proteger,
solicitar una salida o ejecutar un cierre. El objetivo estructural y el stop
original permanecen inmutables.

Los contratos anteriores conservan su versión, cantidades, apalancamiento,
objetivos, stop, plazos y política. En particular, `secondary-net-trailing-1.0.0`
continúa requiriendo objetivo alcanzado y neto de activación igual al mínimo
económico de entrada. Sus validadores e invariantes no se relajan. La migración
de admisión es aditiva y no reescribe órdenes ni posiciones existentes.

## Parámetros fijados antes de observar resultados

| Parámetro de protección nueva | Valor inicial |
| --- | --- |
| Retroceso proporcional desde el máximo neto | 25 % |
| Piso mínimo al activar sobre la cantidad inicial ejecutada | 0,05 USD |
| Incertidumbre adicional por BTC | Máximo de 0,0001 × precio de entrada y medio spread bid/ask observado |
| Objetivo estructural requerido para activar | No |
| Liquidez requerida para reconocer activación o nuevo máximo | Capacidad compartida suficiente para toda la cantidad pendiente |
| Financiación requerida para reconocer activación o nuevo máximo | Resuelta, neto final para el remanente |
| Plazo de entrada de la primera entrega | 5 minutos, con contexto de 15 minutos |
| Tiempo base / extensión máxima / estancamiento para 5m | 30 / 15 / 10 minutos |

Estos parámetros son hipótesis de ingeniería para simulación. El 25 % no se
presenta como óptimo ni como resultado de ajuste retrospectivo.

### Neto y costes

`secondaryEstimate` es la fuente de N(t): liquidación estimada de la cantidad
pendiente, LONG al bid y SHORT al ask, con deslizamiento adverso incorporado en
el precio, comisión de entrada atribuible al remanente, comisión de salida y
financiación acumulada. No se resta por segunda vez el spread o el deslizamiento
que ya está incorporado en los precios. Los componentes permanecen visibles en
la evidencia de liquidación y en los recibos de ejecución.

El colchón adicional de incertidumbre no es otra comisión. No se deduce de
cash, del resultado ni de N(t). Sólo determina cuánto retroceso admitir antes de
solicitar una salida. El spread observable puede ampliarlo; nunca hace bajar un
piso que ya se había establecido.

### Regla causal y piso ejecutable

Para una cantidad constante q, el estado conserva el máximo neto observado P y
sus cotizaciones verificables. Si b es el colchón por BTC, el retroceso candidato
es D = max(0,25 × P, q × b). El piso candidato es P − D.

La protección se activa cuando N permite un piso de al menos 0,05 USD sobre la
cantidad inicialmente ejecutada. El umbral efectivo antes de activación es:

`max(0,05 / (1 − 0,25), 0,05 + q × b)`.

Con 300 USD de exposición, un spread suficientemente estrecho y el colchón de
1 punto básico, ese umbral es 0,08 USD. Con 450 USD es 0,095 USD. No se impone
una condición adicional de alcanzar el objetivo estructural.

Después de activación, cada nuevo máximo válido actualiza:

`F_nuevo = max(F_anterior, P_nuevo − D_nuevo)`.

El ejemplo +0,40 USD con D = 0,10 USD produce F = +0,30 USD aunque el objetivo
sea +0,60 USD. Si N observado baja de F, el gestor solicita salida. Si N salta
desde +0,40 USD a negativo, la cotización posterior a la latencia determina la
ejecución real; no se acredita artificialmente +0,30 USD.

`required_activation_net` muestra el umbral efectivo. `activation_blocker`
distingue neto insuficiente, financiación no resuelta y capacidad insuficiente.
`PROFIT_PROTECTION_NOT_EXECUTABLE` conserva la primera incidencia positiva y el
estado actual permite observar recuperación sin duplicar eventos en cada tick.

### Evidencia y recuperación

La activación, el máximo y el piso conservan sus propias evidencias con hashes,
cotización, precio de liquidación, neto, cantidad y capacidad compartida. La
evidencia del piso es independiente de la última evidencia de máximo: si se
amplía el spread en un nuevo máximo, el piso previo puede seguir siendo mayor.
La validación de recuperación comprueba el importe del piso contra su recibo,
además de validar los contratos. No reconstruye un máximo perdido ni inventa
el recorrido de un intervalo sin datos.

Sólo observaciones frescas del contrato, con cronología causal y financiación
resuelta, pueden reconocer máximos. Sin liquidez suficiente no se atribuye un
máximo liquidable a toda la posición. Una vez cruzado el piso válido, la falta
de capacidad puede retrasar o fraccionar la ejecución, pero no cancela la
intención de salida.

La intención queda en la posición y se persiste por el escritor existente. No
se cancela por un rebote posterior, por volver a negativo ni por reiniciar. La
latencia es la del contrato. Un stop obligatorio puede ganar prioridad sin
reiniciar la latencia del intento ni alterar las otras posiciones.

### Cantidades parciales y plazos

El máximo, piso y retroceso se mantienen por BTC y se proyectan sobre el
remanente. Una reducción de cantidad no es una caída del mercado. El resultado
realizado se contabiliza por cada fragmento; el cierre final informa el total de
la operación, sin acreditarlo dos veces. La protección del remanente se concilia
con el resultado ya realizado y no sustituye ese resultado por el piso teórico.

Las ejecuciones adicionales de una misma orden antes de activar pueden ajustar
el coste medio y la base de cantidad, con el plazo original. Una orden parcialmente
pendiente se cancela al activar protección. Una ampliación posterior debe tener
un contrato separado; esta entrega no modifica la cantidad del contrato firmado.

El stop opera desde la entrada. Una activación permite como máximo una extensión
fija desde el vencimiento base, nunca desde cada nuevo máximo. Los nuevos máximos
sólo reinician el reloj de estancamiento, limitado por ese vencimiento definitivo.
Sin avance suficiente, la operación vence. Sin cotización ejecutable reciente,
la ejecución puede quedar pendiente; no se inventa un precio al vencimiento.

Los contratos nuevos admiten un mapa versionado de horizontes para entregas
posteriores: 15m: 90m base +45m extensión, estancamiento 30m; 1h: 6h +3h,
estancamiento 2h; 4h: 24h +12h, estancamiento 8h. Este soporte de contratos no
habilita automáticamente entradas en esos plazos. La financiación de admisión
se estima conservadoramente para el horizonte máximo firmado.

## Verificación funcional y límite de la evidencia

Las pruebas locales externas incluyen trayectorias LONG/SHORT negativa → +0,40
→ retroceso antes de objetivo; avance continuo; spread que aumenta; umbral visible;
financiación incompleta; cotización obsoleta; liquidez compartida; cierres parciales;
reinicio; convivencia con contratos v1; plazo máximo; salida latente que continúa
aunque el neto cambie; y conciliación de cash con el neto de las ejecuciones.

La prueba de gap ejecuta con el broker real del simulador sobre cotizaciones
sintéticas aisladas: después del piso +0,30, el cierre real de prueba es −0,20.
Esto verifica ausencia de ganancia inventada. No es una operación del worker ni
una medida de rentabilidad. Las pruebas funcionales habilitan un experimento
PAPER; el beneficio neto, drawdown y comparación con exposición equivalente
requieren observación prospectiva separada.

## Desactivación y reversión

`OFF` desactiva admisión bajo la política para señales futuras; los planes
firmados siguen gobernando sus salidas. La reversión de código exige conservar
lectores y gestores capaces de reconocer contratos v2 abiertos o pendientes.
Nunca restaurar una SQLite anterior sobre operaciones posteriores. Desplegar con
commit esperado y respaldo consistente; verificar por separado el commit activo,
política efectiva, escritor único, heartbeat, feed, evaluaciones y recepción del
panel/outbox. Un commit publicado no acredita por sí mismo un despliegue.
