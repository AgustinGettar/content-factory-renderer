# Lumi PAPER — reparación de ejecución y protección, 2026-11-05

## Problema y plan de reparación

En la operación 930bb12e… del 5/11, una pequeña variación del riesgo unitario
provocó cancelar 0,0023 BTC de remanente después de ejecutar sólo 0,0001 BTC.
Los objetivos monetarios y los parciales fijos dejaban de ser coherentes con
ese tamaño. Dos cierres anteriores pasaron de neto positivo al decidir a
negativo al ejecutarse varios segundos después. Son fenómenos distintos.

1. Revalidar el tamaño total todavía financiable dentro del presupuesto firmado,
   recortar únicamente los lotes excedentes y conservar un remanente ejecutable.
2. Ajustar el piso de protección al objetivo estimado por la cantidad ejecutada.
   Determinar si dos parciales 30/30 son realmente divisibles y económicos;
   cuando no lo sean, permitir salida completa al objetivo o por protección.
3. Introducir un margen causal y limitado para anticipar la salida ante retroceso
   durante latencia. Mantener precios, costes, liquidez y latencia reales del
   simulador. El disparador positivo no garantiza un resultado positivo.
4. Evitar que un timeout, 429 o 5xx durante verificación de Telegram detenga el
   seguimiento PAPER. Mantener fatales fallos de identidad, integridad y SQLite.
5. Separar las nuevas observaciones por versión; verificar regresión, recuperación,
   presupuesto, doble ejecución y despliegue con respaldo íntegro.

## Implementación

`secondary-execution-repair-1.0.0` se activa explícitamente mediante
`LUMI_TRADING_SECONDARY_EXECUTION_REPAIR`. Sólo admite PAPER/SQLite/staging y
el perfil activo existente. Se añade a planes nuevos, sellado dentro de su hash;
no reescribe contratos ya abiertos. No cambia saldo, apalancamiento, límites de
riesgo, patrones de entrada, comisiones ni participación supuesta.

Las órdenes nuevas conservan `cancelled_qty` y enmiendas con hash encadenado.
En cada reinicio se comprueba solicitado = ejecutado + pendiente + cancelado.
Las reservas pendientes usan el coste unitario revalidado; la cantidad se redondea
hacia abajo. Nunca se añade epsilon al presupuesto ni se atribuye liquidez futura.
Las cancelaciones y llenados exponen la cantidad reducida en la proyección privada.

El piso es min(0,05 USD, 10% del neto objetivo estimado ajustado a cantidad).
Conserva el ruido mínimo y demás comprobaciones originales de ejecución.
Los umbrales de parciales se limitan a 50% y 80% de ese objetivo, pero siguen
requiriendo 0,10 USD netos por fragmento, lotes válidos y remanente. Si no caben,
la posición usa salida completa al objetivo/protección. No inventa una salida
parcial de cero lotes ni mantiene un umbral imposible como única salida.

El margen de latencia usa movimientos adversos del bid para LONG y ask para
SHORT en ventanas de 3 s, sólo posteriores a la entrada. Requiere 8 muestras,
retiene como máximo 64 durante 60 s, usa p95 y se limita al 25% del máximo neto.
Un hueco superior a 5 s reinicia la muestra. Sólo adelanta una protección ya
activada cuando el último movimiento es adverso y la valoración neta es positiva.
No se resta otra vez como comisión ni se acredita una ganancia hipotética.
La política es experimental: `statistically_validated=false`.

Telegram verifica identidad antes de reclamar el aviso. Los errores transitorios
conocidos dejan el aviso en cola y vuelven a intentar en el siguiente drenado;
una identidad incorrecta o un fallo del ledger sigue siendo un error. Los envíos
con resultado ambiguo mantienen UNKNOWN y no se reenvían. El health log muestra
`telegram_identity_unavailable` sin credenciales ni respuestas externas.

Los contratos de reparación y del experimento activo forman parte del dominio
de las etiquetas QUANT. El dataset existente conserva features causales y cierres
finales. No se entrena ni activa la red antigua de 33 entradas con observaciones
QUANT de otro dominio. Falta muestra independiente para demostrar una mejora de
esperanza neta; eso no se resuelve afirmando que el modelo ya aprendió.

## Pruebas y criterios de salida

- Recorte por variación mínima de coste, reserva exacta y llenado posterior.
- Reinicio entre fills, detección de corrupción de cantidad/enmienda y cancelación.
- Un lote real del simulador: protección proporcional y cierre completo posterior
  a latencia; dos parciales de mayor tamaño sin duplicar PnL ni cantidades.
- Buffer LONG/SHORT, ausencia de datos futuros, funding incompleto, huecos y límite.
- 100 fallos de identidad de transporte: aviso sin reclamar, recuperación y un envío.
- Suite completa de trading, Telegram/Mini App y despliegues AWS antes de publicar.
- CI sobre el commit exacto; backup verificado; un cambio del servicio; cotización
  fresca, revisión creciente, todos los plazos, cero errores QUANT y flag activo.

## Reversión y evaluación

OFF impide añadir esta política a entradas nuevas y mantiene el lector compatible
para gestionar posiciones ya firmadas. Nunca restaurar un ledger antiguo sobre
operaciones posteriores ni arrancar el binario previo con contratos nuevos.
El script conserva la reversión compatible QUANT OFF ante fallo de verificación.

La fase siguiente es medir resultados prospectivos por versión, patrón y plazo:
neto final, costes, cantidad ejecutada/solicitada, cancelaciones por motivo,
MFE capturado y diferencia entre neto al decidir y neto al cerrar. No reducir
filtros ni aumentar capital por una muestra pequeña o para fabricar operaciones.
La concurrencia masiva, nuevas estrategias y promoción de un modelo requieren
ensayos propios; no se mezclan con esta reparación del motor existente.
