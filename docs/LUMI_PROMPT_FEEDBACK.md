# Lumi prompt feedback

Evidence cutoff: 2026-10-22T13:00:03.209238+00:00.

## Qué pidió el encargo

- Recuperar video:q43 sin repetir EP004 y preparar borrador automático con una sola decisión de política.

## Qué se completó realmente

- Misma operación PREPARED cercada por nonce y lease; final-price preflight después de materiales, URL temporal y precio renovados bajo semántica/hash y plan originales. Reserva conservada atómicamente por diferencia.
- q43 recibió un ACK real del proveedor mediante el trabajo ya iniciado; no fue una generación de prueba. Política automática versionada y autenticada atraviesa imagen, QA técnico, dirección, video, voz, montaje y master sin aprobaciones humanas ficticias.
- Dos episodios supervisados y dos borradores completos con servicios externos simulados; descarga privada SHA comprobada. Despliegue exacto y guardas anónimas verificados.

## Qué quedó pendiente

- Proveedor q43 queued al corte de evidencia; no hay clip final ni master real.
- Decisión opcional de modo automático y futura revisión final dentro de Studio.
- La continuidad durante suspensión de Render Free no existe; ningún cambio de hosting autorizado o efectuado.

## Qué trabajo se repitió innecesariamente

- Una combinación de archivos del segundo commit activó un ámbito CI más amplio; se corrigió el selector para conservar pruebas focalizadas. No se repitió migración Make ni recuperación q42 ni generación real de prueba.

## Qué instrucciones evitaron errores

- PREPARED se interpretó usando la invariante real anterior a fetch, no la mera ausencia de request ID. FENCED_PREPARED impide CAS del binario antiguo.
- No usar revisión técnica como aprobación artística; no ampliar el consentimiento ni presupuesto.

## Qué instrucciones generaron fricción

- No nuevas: la autorización de continuidad del trabajo existente fue suficiente; el agente no pidió otro permiso técnico.

## Qué evidencia faltó

- Tiempo real completo de proveedor/descarga/QA/master; cargos confirmados; capacidad de montaje bajo 512MB; aceptación visual iPhone.
- El primer phase_timings de la operación reanudada arrastra el intervalo histórico bloqueado: no usarlo como tiempo de preparación. Los tiempos válidos del preflight y transporte están separados en evidence.json.

## Qué decisión humana se necesita

- Elegir Borrador automático · revisión final en Studio si se desea omitir revisiones artísticas intermedias. Hasta entonces se conserva el modo supervisado.

## Qué riesgos permanecen

- Un defecto artístico puede pasar a la animación en modo borrador; se informa antes de aceptar. QA de bytes no evalúa anatomía ni continuidad artística.
- No garantía exactly-once extremo a extremo del proveedor. Una emisión realmente incierta no se reenvía.
- Expiración explícita del plan y suspensión del alojamiento siguen siendo límites reales.

## Reproduction

node scripts/lumi-improvement-loop.mjs

Input SHA-256: 0f3bc5849afc815e1d9e587a195b7d3e21bbef19ee896990c8246163a402b8fc. Outputs are inert drafts; generating them cannot expand authorization.
