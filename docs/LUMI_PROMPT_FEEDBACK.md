# Lumi prompt feedback

Evidence cutoff: 2026-10-22T00:08:40Z.

## Qué pidió el encargo

- Frontend fluido, imágenes progresivas y acciones que no se habiliten antes de conciliar el resultado.

## Qué se completó realmente

- Bloqueo por propietario, episodio y decisión exacta; revisiones incluidas; recibos durables y CAS conservados.
- Actualizaciones parciales conservan medios, formularios y foco. Cotizaciones manuales no se reintrodujeron.
- Miniaturas/previews JPEG deterministas desde originales verificados, privados, con hash y procedencia propios; no son recursos artísticos nuevos.
- CI de código39697483174 GREEN y despliegue staging a7cd305b verificados; autorización anónima rechazada.

## Qué quedó pendiente

- Aceptación visual en Telegram/iPhone y revisión editorial actual q43; master real EP004 no terminado.
- Latencia real autenticada de previews e INP de campo no medidos.

## Qué trabajo se repitió innecesariamente

- No se repitieron recuperación de q42, migración de Make ni suites completas. El selector del fixture de navegador se corrigió; se repitió una vez CI por fallo TLS de descarga del navegador.

## Qué instrucciones evitaron errores

- No usar el fin de HTTP como finalización de la operación.
- No probar con botones de producción; fixtures locales y transporte simulado.
- Comprobar ventana sin despachos/montajes/leases antes de desplegar; no congelar EP004.

## Qué instrucciones generaron fricción

- La máquina local no pudo descargar Chromium; la medición se realizó en CI. Git local no tenía credenciales: se publicó el mismo árbol por GitHub, con expected_sha y sin force push.

## Qué evidencia faltó

- Aceptación visual de esta versión en iPhone; INP real y latencia autenticada de medios. No hay evidencia de doble cobro en este incidente.

## Qué decisión humana se necesita

- Revisar el contenido actual dentro de Studio, sin otro prompt técnico.

## Qué riesgos permanecen

- La respuesta inmediata indica envío o conciliación, nunca éxito inventado. Un resultado incierto conserva el bloqueo.
- Render suspendido demora antes del HTML; no puede corregirse con JavaScript que todavía no llegó.
- La primera creación de preview puede tardar; está acotada a un codificador y muestra fallback/error de lectura. El original se conserva para ampliar.

## Reproduction

node scripts/lumi-improvement-loop.mjs

Input SHA-256: a4c2863f792cbf0634d3d797ba464f6c51b4092b2b8ec74eca7db3f69b8cecc6. Outputs are inert drafts; generating them cannot expand authorization.
