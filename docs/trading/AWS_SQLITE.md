# Trading: persistencia local en AWS y gráfico de decisiones

El worker PAPER conserva su instancia EC2 y pasa a SQLite en
`/var/lib/lumi-trading/trading.sqlite`. No utiliza Supabase en modo SQLITE.
La Mini App audiovisual, su webhook, su menú, Render y main no cambian.

## Migración

El instalador recibe un paquete privado separado del repositorio, con una
exportación íntegra y configuración del canal privado del panel. Comprueba la
instancia y el Free Plan mediante el transporte CloudShell existente, verifica
la revisión fuente, detiene el writer anterior y conserva configuración de
recuperación. La importación de estado, eventos y outbox es atómica y no puede
sobrescribir una base existente. La revisión exportada y los estados de entrega
se conservan. La actualización de cartera ya autorizada se aplica al iniciar;
mantiene saldos y planes anteriores.

El apagado acepta tanto `inactive/dead` como `failed/failed`, siempre con
MainPID y ControlPID en cero y sin procesos en el cgroup del servicio ni sus
descendientes. Se comprueba otra vez el estado tras revisar el cgroup. Un fallo
recordado por systemd no equivale a un proceso activo; tampoco se omite la
barrera cuando todavía hay procesos o no se puede verificar su ausencia.
Un reintento conserva la exportación, reutiliza la misma instancia y no
sobrescribe una base importada.

SQLite usa WAL, synchronous FULL, CAS, fencing, lease y una cola transaccional.
Un envío interrumpido pasa a UNKNOWN; nunca se reenvía automáticamente como si
no se hubiera entregado. Los planes vencidos no se presentan como oportunidades
actuales. El motor conserva su recuperación conservadora de huecos de mercado.

## Panel y Mini App

AWS publica cada 15 segundos una proyección sin destinatarios ni secretos al
panel privado existente. La base de operaciones queda en AWS; R2 contiene la
última proyección y copias cifradas. El panel consulta cada 30 segundos y calcula
antigüedad desde la hora servida, sin rejuvenecer un checkpoint antiguo.

El transporte de Trading añade un botón `web_app` a sus mensajes. No modifica
`setChatMenuButton`, `setWebhook`, comandos, ni consume `getUpdates`. La Mini
App conserva el acceso privado del panel con ChatGPT; una sesión nueva puede
pedir iniciar sesión. No usa `initDataUnsafe` como prueba de identidad.

El gráfico conecta al WebSocket público v2 de Kraken (ticker BBO y OHLC), con
historial OHLC REST, plazos 1/15/60/240 min, desplazamiento, selección de operación
y niveles de entrada, límite, stop, objetivo y patrón. Solo el sobre del mensaje
OHLC da la hora de actualización; el `timestamp` obsoleto de la fila es el fin
del intervalo. Los heartbeats no actualizan precios. La última vela permanece
abierta. El ticker y la salud del motor son estados separados.

Los planes nuevos guardan evidencia causal: velas cerradas, medias utilizadas,
bandas/niveles, ATR, ADX, volumen relativo, reglas y momento de decisión.
Las series se calculan con el mismo historial y método de las reglas; la vista
no recalcula decisiones con barras futuras. Las operaciones anteriores muestran
solo evidencia ya guardada y reconocen explícitamente lo que falta.

## Copias y recuperación

Cada hora se crea una copia SQLite consistente con la API oficial de backup.
Se mantienen tres posiciones diarias locales y tres remotas; la copia del día
se renueva con la última copia de esa hora. La remota se comprime y cifra con
AES-256-GCM antes de salir de AWS. La clave se guarda en configuración privada,
también incluida en el paquete privado de recuperación, nunca en Git ni en el
panel del navegador. R2 guarda IV, tag, SHA256 y revisión como metadatos.

Para recuperar: detener el worker; descargar una copia remota con acceso privado;
verificar SHA256; descifrar con clave, IV, tag y AAD `lumi-trading-backup-v1`;
descomprimir gzip; ejecutar `PRAGMA integrity_check`; verificar saldos/revisión;
restaurar con permisos del usuario lumitrading antes de iniciar. Nunca copiar
solo el archivo SQLite abierto ignorando su WAL. La pérdida máxima de datos
remotos puede superar una hora si falla la subida; su estado se registra.

No se contratan planes ni se crea otra VM. La instancia y su disco siguen
consumiendo los créditos AWS existentes. SQLite no añade un servidor de base
de datos. El disco tiene capacidad finita; no se borra historial automáticamente.
La publicación web no certifica que se haya ejecutado la instalación en AWS.
