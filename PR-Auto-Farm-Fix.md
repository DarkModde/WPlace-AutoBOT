# WPlace Auto-Farm — Refactor: UI-driven painting, API-aware charges, resilient CF handling, and UX/i18n upgrades

## TL;DR
Este PR reemplaza el flujo antiguo basado en llamadas directas al backend por un flujo de automatización a través de la UI del sitio, sincroniza las cargas mediante una estrategia consciente del endpoint /me (sin hacer polling continuo), mejora sustancialmente la detección y resolución del desafío de Cloudflare, añade soporte i18n amplio y herramientas de recuperación/diagnóstico. Resultado: flujo más humano, menos frágil, con mejor resiliencia operativa y feedback al usuario.

## Motivación (por qué)
El script previo (`ViejoAutoFarm.js`) pintaba con peticiones directas al backend y una lógica mínima de UI/estado. Esto lo hacía más propenso a bloqueos (CF), a desincronización de cargas y a roturas por cambios de DOM o límites de ritmo de la API. Se necesitaba un enfoque más humano —usando la propia UI del sitio— y una detección de Cloudflare mucho más robusta que evitara falsos positivos y reaccionara rápido.

## Comparativa: Viejo vs Nuevo
- Antes (ViejoAutoFarm.js)
  - Pintado vía POST directo a `https://backend.wplace.live/s0/pixel/...` con color aleatorio.
  - Cargas consultadas con `/me` de forma directa y con poca lógica de sincronización.
  - Selección de idioma basada en IP (ipapi), con alcance limitado (pt/en) y mayor fragilidad.
  - UI simple: panel básico con Start/Stop y contador; sin multi-selección ni cooldowns realistas.
  - Sin manejo explícito de Cloudflare; no prevenía intentos de pintado durante un desafío activo.

- Ahora (Auto-Farm.js)
  - Pintado 100% vía UI: abre paleta, elige color válido, marca posiciones y pulsa Paint; evita acciones que provocan zoom o paneo accidental.
  - Modelo de cargas consciente: se inicializa desde `/me` al iniciar y tras cada Paint exitoso (sin polling en background). Durante la espera usa el countdown del botón Paint.
  - Multi-selección: permite marcar N cuadrados en un mismo burst (Ctrl/Cmd) para consumir múltiples cargas en un click (configurable y persistido).
  - Detección Cloudflare avanzada: combinación de red (Performance API), DOM (visibilidad real), texto multiidioma, MutationObserver y clicks rápidos con varias estrategias.
  - i18n por idioma de navegador: `pt`, `en`, `es`, `fr`, `ru`, `nl`, `uk`; textos/labels estandarizados.
  - UX: panel con stats, ajustes persistidos (confirm wait, resume threshold, max fails, squares per action), gear con acciones útiles (calibrar zoom, reset, sync /me, check health).
  - Robustez: recarga segura con persistencia de estado y auto-resume; recuperación de zoom solo bajo error con cooldown; throttling de stats.

## Alcance (qué cambia)
- Pintado vía UI con control de paleta, áreas y confirmación Paint.
- Cargas: se consultan una vez al iniciar y tras cada Paint exitoso. En backoff (HTTP 400 de /me) se pausan las llamadas 10 pinturas y se pinta 1 pixel por acción.
- Enfriamientos/tiempos: confirmación tras Paint con countdown en vivo; espera en tiempo real con tick de 1s; mínimo recomendado de 10s para confirmación.
- Cloudflare: nueva detección/gestión (ver sección técnica). El bot evita pintar si el desafío está activo.
- i18n y UX: mejoras de textos, controles y acciones del gear; persistencia de ajustes.

Fuera de alcance:
- Cambios de backend o contratos de API. El PR sólo consume `/me` y opcionalmente `/health`.
- Heurísticas complejas de pathing para elegir áreas “inteligentes”. Se mantiene objetivo simple/no repetitivo.

## Detalles técnicos clave

### Pintado por UI y cadencia humana
- Encuentra el botón Paint y la paleta en el DOM; abre la paleta si está cerrada.
- Selecciona un color válido detectado desde la UI (excluye deshabilitados/baneados; fallback robusto a 1..31).
- Marca N posiciones (Ctrl/Cmd) con pequeñas pausas y jitter para cadencia humana.
- Confirma Paint una sola vez, consumiendo múltiples cargas si están disponibles.
- Evita doble click y pan/drag para prevenir zoom involuntario.

### Cargas y cooldown
- Semilla de cargas/cooldown desde `/me` al Start; tras cada Paint exitoso, vuelve a consultar `/me` para sincronizar recontado exacto.
- Durante la espera usa el countdown del botón Paint (mm:ss) y muestra el ETA en la UI con tick de 1s.
- Si `/me` devuelve 400 (ban temporal CF), entra en backoff: pausa `/me` por 10 pinturas, muestra estado “API pausada” y pinta sólo 1 pixel por acción.

### Detección y manejo de Cloudflare (mejorado)
- Detección combinada y sin falsos positivos por “logs”:
  - Red: Performance API detecta recursos de `challenges.cloudflare.com`/`cdn-cgi/challenge-platform`.
  - DOM visible real: selectores CF (p.ej., `.cb-lb input[type="checkbox"]`, `.cf-challenge`, `#challenge-overlay`, `div[id^="cf-chl-widget"]`) con verificación estricta de visibilidad (bounding rect, estilos, opacidad y on-screen).
  - Texto multiidioma: frases clave como “Verify you are human / Verifica que eres un ser humano / Vérifiez que vous êtes humain / …” en ES/EN/FR/RU/NL/UK.
  - MutationObserver: vigilancia de cambios DOM en tiempo real para reaccionar al aparecer el reto.
- Resolución rápida del checkbox: scroll al centro, 3 estrategias de click (nativa + MouseEvent + click por coordenadas en centro), verificación inmediata (`checked`/`aria-checked`).
- Verificación tras click: espera breve (5s). Si el desafío persiste, detiene el bot, informa en UI y pide intervención manual (evita loops).
- Nota: Se evita “detectar sólo por log” (p. ej., mensajes como “resource preloaded but not used”) para no contar falsos positivos si el widget no está visible en pantalla.

### UX, i18n y herramientas
- Ajustes persistidos: confirm wait, resume threshold, max consecutive fails, squares per action, auto-calibrate on fail.
- Gear: Calibrate zoom (rutina de recuperación), Reset counter, Refresh /me now (manejo explícito de 400), Check health (`/health`) con resumen compacto.
- Detalles i18n: idioma por navegador (pt, en, es, fr, ru, nl, uk); labels estandarizados.

### Estabilidad y recarga segura
- Guardas para evitar prompts de beforeunload; recarga segura con persistencia de estado y auto-resume (espera hasta 15s por UI).
- Zoom recovery: sólo al fallar pintado, con cooldown; dos pasos de zoom-in tras detectar hint post-zoom-out.
- Throttling de actualizaciones de stats para evitar reflows excesivos.

## Pruebas y validación (cómo probar)
1. Abrir wplace.live, asegurarse de ver el botón Paint y la paleta cuando se abre.
2. Inyectar/ejecutar Auto-Farm y pulsar Start.
3. Verificar: abre paleta si es necesario, elige color válido, marca una zona aleatoria sin repetir y pulsa Paint.
4. Configurar “Squares per action” > 1 (ej. 3) y, con suficientes cargas, comprobar consumo múltiple en un único Paint. Si hay menos cargas que las solicitadas, debe consumir las disponibles.
5. Con cargas, el bot pinta en bursts hasta agotarlas; luego espera en tiempo real con tick 1s hasta que reaparezcan.
6. Si aparece Cloudflare (pantalla/overlay/checkbox): debe detectar rápidamente, hacer un click y esperar 5s. Si sigue, parar y mostrar mensaje de intervención manual.
7. Bajar “Confirm wait” por debajo de 10s: el campo debe mostrar advertencia localizada y resaltado (no cambia el valor automáticamente). A 10s o más, desaparece la advertencia.
8. Forzar fallos de pintado: observar la rutina de recuperación de zoom (cuando esté habilitada) y que no se repita en bucle.
9. Abrir el gear y probar: Reset counter, Refresh /me now (manejo de 400 con backoff visible), Check health (resumen JSON). 
10. Validar auto-resume tras recarga segura cuando se supere el umbral de errores consecutivos.

## Impacto en compatibilidad
- Mantiene fallback legacy para `START_X/START_Y` cuando la región aún no está disponible.
- No introduce dependencias externas nuevas.
- Interacción de UI en lugar de llamadas directas al pixel endpoint; el backend se usa sólo para `/me` y `/health` (opcional).

## Riesgos y mitigaciones
- Cambios de DOM en la paleta o el botón Paint podrían romper selectores.
  - Mitigación: selectores genéricos + fallback de color; endurecer selectores en follow-ups si aparecen regresiones.
- El desafío de CF puede variar su estructura.
  - Mitigación: detección combinada (red + DOM visible + texto + MutationObserver) y estrategia de click múltiple; fácil extensión de frases/idiomas y selectores.
- Desajustes entre UI y valores de `/me` por latencia.
  - Mitigación: sincronización tras cada Paint exitoso; no hay polling de fondo.

## Plan de reversión
- Revertir a `ViejoAutoFarm.js` o volver a la versión anterior de `Auto-Farm.js` en caso de incidentes críticos. No hay migraciones persistentes.

## Checklist del Pull Request
- [x] Pintado a través de la UI con selección de color válida y confirmación Paint.
- [x] Multi-selección de N cuadros con Ctrl/Cmd (persistido y configurable).
- [x] Modelo de cargas consciente de `/me` (inicio y post-Paint, sin polling). Backoff en HTTP 400.
- [x] Detección CF mejorada: red + DOM visible + texto + MutationObserver + click rápido; evita falsos positivos por logs.
- [x] UX/i18n: textos normalizados (pt, en, es, fr, ru, nl, uk), advertencias y ajustes persistidos.
- [x] Seguridad operacional: recarga segura sin prompts y auto-resume.
- [x] Zoom recovery con cooldown; sin panning/drag ni doble click accidental.
- [x] Throttling de stats; sin dependencias nuevas.

## Notas adicionales
- El mensaje de consola “The resource ... challenge-platform ... was preloaded but not used...” ya no dispara detección por sí mismo: se usa sólo como señal de red junto con DOM visible/texto para evitar falsos positivos si el widget no aparece en pantalla.
- El sistema de monitorización puede extenderse (más idiomas, nuevos selectores de CF) sin cambiar el flujo principal.

