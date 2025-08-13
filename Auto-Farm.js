(async () => {
  const CONFIG = {
    // Valores por defecto de respaldo (se usarán solo si no se captura región automáticamente)
    START_X: 742, // Fallback región/área de referencia (legacy)
    START_Y: 1148,
    PIXELS_PER_LINE: 100,
  DELAY: 7000,
  UI_MODE: true, // Fallback a interacción de UI para que el sitio maneje tokens/reto
    // Ajustes por defecto
    CONFIRM_WAIT_SECONDS: 10, // segundos de espera tras pulsar Paint
    RESUME_CHARGES_MIN: 15,   // umbral mínimo por defecto para reanudar tras llegar a 0
    RESUME_CHARGES_MAX: 50,   // umbral máximo por defecto para reanudar tras llegar a 0
  MAX_CONSEC_FAILS: 5,      // errores consecutivos antes de recargar
    THEME: {
      primary: '#000000',
      secondary: '#111111',
      accent: '#222222',
      text: '#ffffff',
      highlight: '#775ce3',
      success: '#00ff00',
      error: '#ff0000'
    }
  };

  // Pequeño helper para esperar tiempos con await
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // Servicio para consultar el estado de cargas/cooldown desde la API del sitio
  const WPlaceService = {
    getCharges: async () => {
      try {
        const res = await fetch('https://backend.wplace.live/me', { credentials: 'include' });
        const data = await res.json();
        return {
          charges: data?.charges?.count ?? 0,
          cooldownMs: data?.charges?.cooldownMs ?? 30000
        };
      } catch {
        return { charges: 0, cooldownMs: 30000 };
      }
    },
    getMe: async () => {
      try {
        const res = await fetch('https://backend.wplace.live/me', { credentials: 'include' });
        if (res.status === 400) {
          return { __errorStatus: 400 };
        }
        if (!res.ok) {
          return { __errorStatus: res.status };
        }
        return await res.json();
      } catch {
        return { __errorStatus: -1 };
      }
    }
  };

  const state = {
    running: false,
    paintedCount: 0,
    charges: { count: 0, max: 80, cooldownMs: 30000 },
    userInfo: null,
    lastPixel: null,
    minimized: false,
    menuOpen: false,
    language: 'en',
    // Nuevos estados
    region: null, // { x: number, y: number } de la URL (capturado del propio sitio)
    regionTopLeft: null, // { x: number, y: number } top-left absoluto de la región (calculado)
    capturingRegion: false,
    availableColors: [], // ids de colores disponibles
    lastStatsUpdate: 0,
  consecutiveFails: 0,
  // Preferencias del usuario (opcional)
  userConfirmWaitSec: null,   // si null, usar CONFIG.CONFIRM_WAIT_SECONDS
  userResumeThreshold: null,  // si null, usar random [RESUME_CHARGES_MIN, RESUME_CHARGES_MAX]
  currentResumeTarget: null,   // se fija cuando llegamos a 0, hasta alcanzar el objetivo
  userMaxConsecFails: null,     // si null, usar CONFIG.MAX_CONSEC_FAILS
  userSquaresPerAction: null,    // si null, por defecto 1
  lastZoomRecoveryAt: 0,         // timestamp para no repetir la recuperación de zoom muy seguido
  // Cache de /me para no bloquear el flujo si el backend va lento
  chargesCache: { charges: 0, cooldownMs: 30000, ts: 0 },
  chargesInFlight: false,
  // Modelo local para evitar usar /me durante la ejecución
  chargesLocal: { count: 0, max: 80, regenIntervalMs: 30000, nextAt: null },
  meQueriedAt: 0
  };

  // Persistencia y recarga segura
  const STORAGE = {
    SETTINGS_KEY: 'wplace.af.settings',
    RELOAD_KEY: 'wplace.af.reload',
    LAST_RELOAD_AT: 'wplace.af.lastReloadAt'
  };
  const SAFE_RELOAD_COOLDOWN = 120000; // 2 min

  // Evita prompts de "cambios no guardados" de scripts de la página al recargar
  const installNoPromptReloadGuard = () => {
    try {
      // Anula handlers clásicos
      try { window.onbeforeunload = null; } catch {}
      try { document.onbeforeunload = null; } catch {}
      // Captura y bloquea otros listeners registrados por la página
      const stopper = (e) => {
        try {
          e.stopImmediatePropagation();
          // Asegura que ningún handler establezca un mensaje
          Object.defineProperty(e, 'returnValue', { configurable: true, writable: true, value: undefined });
        } catch {}
      };
      window.addEventListener('beforeunload', stopper, { capture: true, once: true });
      document.addEventListener('beforeunload', stopper, { capture: true, once: true });
    } catch {}
  };

  const saveSettings = () => {
    try {
      const payload = {
        confirmWait: state.userConfirmWaitSec,
        resumeThreshold: state.userResumeThreshold,
        maxFails: state.userMaxConsecFails,
        squaresPerAction: state.userSquaresPerAction,
        autoZoomOnFail: !!state.autoZoomOnFail
      };
      localStorage.setItem(STORAGE.SETTINGS_KEY, JSON.stringify(payload));
    } catch {}
  };
  const loadSettings = () => {
    try {
      const raw = localStorage.getItem(STORAGE.SETTINGS_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Number.isFinite(data?.confirmWait)) state.userConfirmWaitSec = data.confirmWait;
      if (Number.isFinite(data?.resumeThreshold)) state.userResumeThreshold = data.resumeThreshold;
      if (Number.isFinite(data?.maxFails)) state.userMaxConsecFails = data.maxFails;
      if (Number.isFinite(data?.squaresPerAction)) state.userSquaresPerAction = data.squaresPerAction;
      if (typeof data?.autoZoomOnFail === 'boolean') state.autoZoomOnFail = data.autoZoomOnFail;
    } catch {}
  };
  const readReloadIntent = () => {
    try {
      const raw = localStorage.getItem(STORAGE.RELOAD_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data || null;
    } catch { return null; }
  };
  const clearReloadIntent = () => {
    try { localStorage.removeItem(STORAGE.RELOAD_KEY); } catch {}
  };
  const triggerSafeReload = (reason = '') => {
    try {
      const last = parseInt(localStorage.getItem(STORAGE.LAST_RELOAD_AT) || '0', 10);
      if (Date.now() - last < SAFE_RELOAD_COOLDOWN) {
        const t = getTranslations();
        updateUI(t.msgPaused, 'default');
        return; // evitar bucles de recarga
      }
      saveSettings();
      localStorage.setItem(STORAGE.RELOAD_KEY, JSON.stringify({ autoStart: true, savedAt: Date.now(), reason }));
      localStorage.setItem(STORAGE.LAST_RELOAD_AT, String(Date.now()));
      const t = getTranslations();
      updateUI(t.msgReloading, 'warning');
      // Instalar guard para evitar prompt de "cambios no guardados" y recargar
      installNoPromptReloadGuard();
      setTimeout(() => {
        try { installNoPromptReloadGuard(); } catch {}
        try { location.reload(); } catch {}
      }, 600);
    } catch {}
  };

  // Detección de idioma basada en el navegador
  const detectLanguage = () => {
    try {
      const lang = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
      const map = {
        'pt': 'pt', 'pt-br': 'pt',
        'en': 'en', 'en-us': 'en', 'en-gb': 'en',
        'es': 'es', 'es-es': 'es', 'es-mx': 'es', 'es-ar': 'es',
        'fr': 'fr',
        'ru': 'ru',
        'nl': 'nl',
        'uk': 'uk', 'uk-ua': 'uk', 'ua': 'uk'
      };
      state.language = map[lang] || map[lang.split('-')[0]] || 'en';
    } catch {
      state.language = 'en';
    }
  };

  // Formateo simple de tiempo para mensajes de backoff
  const formatTimeShort = (ms) => {
    const total = Math.ceil(ms / 1000);
    if (total < 60) return `${total}s`;
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}m ${s}s`;
  };

  // Pequeño jitter aleatorio para humanizar la cadencia
  const nextDelay = () => CONFIG.DELAY + Math.floor(Math.random() * CONFIG.DELAY);

  // Extrae colores disponibles desde la UI del sitio (evita colores bloqueados)
  const extractAvailableColors = () => {
    try {
      const colorElements = document.querySelectorAll('[id^="color-"]');
      const ids = Array.from(colorElements)
        .filter(el => !el.querySelector('svg'))
        .map(el => parseInt(el.id.replace('color-', ''), 10))
        .filter(id => Number.isFinite(id) && id !== 0 && id !== 5);
      return ids;
    } catch {
      return [];
    }
  };

  const chooseColor = () => {
    if (!state.availableColors || state.availableColors.length === 0) {
      // Fallback a 1..31 si no se detectaron colores disponibles
      return Math.floor(Math.random() * 31) + 1;
    }
    const idx = Math.floor(Math.random() * state.availableColors.length);
    return state.availableColors[idx];
  };

  // Selecciona una entrada de la paleta por id si existe
  const selectColorInUI = (id) => {
    const btn = document.getElementById(`color-${id}`);
    if (btn) btn.click();
  };

  // Encuentra el canvas más grande (probable lienzo del tablero)
  const getMainCanvas = () => {
    const canvases = Array.from(document.querySelectorAll('canvas'));
    if (canvases.length === 0) return null;
    return canvases.reduce((a, b) => (a.width * a.height > b.width * b.height ? a : b));
  };

  // Helpers de zoom: simular rueda del mouse sobre el canvas
  const wheelCanvas = (deltaY) => {
    const canvas = getMainCanvas();
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const cx = Math.floor(rect.left + rect.width / 2);
    const cy = Math.floor(rect.top + rect.height / 2);
    try {
      const evt = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: Math.sign(deltaY) * Math.min(100, Math.abs(deltaY) || 100),
        deltaX: 0,
        deltaMode: 0,
        clientX: cx,
        clientY: cy
      });
      canvas.dispatchEvent(evt);
      return true;
    } catch {
      return false;
    }
  };

  // --- Gestión de /me (solo al inicio) y modelo local ---
  const withTimeout = (promise, ms = 1200) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);
  };
  const initChargesFromServerOnce = async () => {
    if (state.meQueriedAt) return;
    state.meQueriedAt = Date.now();
    let count = 0, max = 80, cooldownMs = 30000;
    try {
      const me = await withTimeout(WPlaceService.getMe(), 1500);
      if (me && !Number.isFinite(me.__errorStatus)) {
        // Cargar datos de usuario
        try {
          state.userInfo = {
            name: me.name || state.userInfo?.name,
            allianceId: me.allianceId,
            allianceRole: me.allianceRole,
            droplets: me.droplets,
            level: me.level,
            pixelsPainted: me.pixelsPainted
          };
        } catch {}
        // Cargar cargas
        if (Number.isFinite(me?.charges?.count)) count = Math.floor(me.charges.count);
        if (Number.isFinite(me?.charges?.max)) max = Math.max(1, Math.floor(me.charges.max));
        if (Number.isFinite(me?.charges?.cooldownMs) && me.charges.cooldownMs >= 0) cooldownMs = me.charges.cooldownMs;
      } else if (me && me.__errorStatus === 400) {
        // Ban temporal: pausar /me por 10 pintadas
        state.meBackoffPaintsLeft = 10;
        try { const t = getTranslations(); updateUI(t.msgMeBackoffStart(10), 'warning'); } catch {}
      }
    } catch {}
    // Fallback: deducir desde UI
    try {
      const pb = readPaintButtonState();
      if (Number.isFinite(pb?.available)) count = Math.floor(pb.available);
      if (Number.isFinite(pb?.max)) max = Math.max(1, Math.floor(pb.max));
      if (Number.isFinite(pb?.cooldownMs) && pb.cooldownMs > 0) cooldownMs = pb.cooldownMs;
    } catch {}
    state.chargesLocal.count = Math.max(0, count);
    state.chargesLocal.max = Math.max(1, max);
    state.chargesLocal.regenIntervalMs = Math.max(1000, cooldownMs || 30000);
    state.chargesLocal.nextAt = (state.chargesLocal.count < state.chargesLocal.max)
      ? Date.now() + state.chargesLocal.regenIntervalMs
      : null;
  };

  const tickLocalCharges = () => {
    try {
      const m = state.chargesLocal;
      if (!m) return;
      const step = Math.max(1000, m.regenIntervalMs || 0);
      while (m.nextAt != null && Date.now() >= m.nextAt && m.count < m.max) {
        m.count++;
        m.nextAt = (m.count < m.max) ? m.nextAt + step : null;
      }
    } catch {}
  };

  const getLocalCharges = () => {
    // Priorizar lectura directa desde el botón Paint si muestra x/y o countdown
    try {
      const pb = readPaintButtonState();
      if (Number.isFinite(pb?.available)) {
        const eta = Math.max(0, pb.cooldownMs || 0);
        return { charges: Math.floor(pb.available), cooldownMs: eta };
      }
      // Si el botón no muestra x/y, usar el último valor conocido del servidor
      const eta = state.chargesLocal.nextAt != null ? Math.max(0, state.chargesLocal.nextAt - Date.now()) : 0;
      return { charges: Math.floor(state.chargesLocal.count || 0), cooldownMs: eta };
    } catch {
      const eta = state.chargesLocal.nextAt != null ? Math.max(0, state.chargesLocal.nextAt - Date.now()) : 0;
      return { charges: Math.floor(state.chargesLocal.count || 0), cooldownMs: eta };
    }
  };

  const findZoomHintButton = () => {
    try {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.find(b => /zoom\s*in\s*to\s*see\s*the\s*pixels/i.test((b.textContent || '').trim()));
    } catch { return null; }
  };

  const isElementVisible = (el) => {
    try {
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    } catch { return false; }
  };

  // Zoom out hasta ver el mensaje de pistas y luego 2 zoom in para poder dibujar
  const ensureDispersionZoom = async () => {
  const t = getTranslations();
  try { updateUI(t.msgZoomAdjust || 'Adjusting zoom…', 'default'); } catch {}
    // Hacer zoom out progresivo hasta que aparezca el hint o se alcance un límite
    for (let i = 0; i < 40; i++) {
      const hint = findZoomHintButton();
      if (hint && isElementVisible(hint)) break;
      wheelCanvas(+100);
      await sleep(160);
      const hint2 = findZoomHintButton();
      if (hint2 && isElementVisible(hint2)) break;
    }
    // Pequeña pausa para estabilizar animaciones
    await sleep(400);
  // Dos pasos exactos de zoom in (rueda) con 1s de pausa entre cada paso
  wheelCanvas(-100);
  await sleep(1000);
  wheelCanvas(-100);
  await sleep(1000);
  };

  // Hace clic exacto en el canvas en coordenadas de cliente
  const clickCanvasAt = (clientX, clientY, opts = {}) => {
    const canvas = getMainCanvas();
    if (!canvas) return false;
    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const type of events) {
      const evt = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: Math.floor(clientX),
        clientY: Math.floor(clientY),
        view: window,
        ctrlKey: !!opts.ctrlKey,
        metaKey: !!opts.metaKey,
        shiftKey: !!opts.shiftKey,
        altKey: !!opts.altKey
      });
      canvas.dispatchEvent(evt);
    }
    return true;
  };

  // Simula un click en el canvas (centro con pequeño jitter para parecer humano)
  const clickCanvasAtCenter = () => {
    const canvas = getMainCanvas();
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const jitter = () => (Math.random() - 0.5) * Math.min(20, Math.max(6, Math.min(rect.width, rect.height) * 0.02));
    const cx = Math.floor(rect.left + rect.width / 2 + jitter());
    const cy = Math.floor(rect.top + rect.height / 2 + jitter());
  const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const type of events) {
      const evt = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: cx,
        clientY: cy,
        view: window
      });
      canvas.dispatchEvent(evt);
    }
    return true;
  };

  // Clic aleatorio cerca del centro del canvas (dentro del 30% central)
  const clickCanvasRandom = (opts = {}) => {
    const canvas = getMainCanvas();
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const rangeX = rect.width * 0.3;
    const rangeY = rect.height * 0.3;
    const cx = rect.left + rect.width / 2 + (Math.random() - 0.5) * rangeX;
    const cy = rect.top + rect.height / 2 + (Math.random() - 0.5) * rangeY;
    return clickCanvasAt(cx, cy, opts);
  };

  // Registro de celdas visitadas (normalizadas a una cuadrícula)
  const visited = new Set();
  const GRID_Q = 80; // resolución de cuadrícula para no repetir zonas
  const pickUnvisitedPoint = () => {
    const canvas = getMainCanvas();
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    // margen 5% para evitar bordes/overlays
    const marginX = rect.width * 0.05;
    const marginY = rect.height * 0.05;
    for (let i = 0; i < 200; i++) {
      const x = rect.left + marginX + Math.random() * (rect.width - 2 * marginX);
      const y = rect.top + marginY + Math.random() * (rect.height - 2 * marginY);
      const nx = Math.floor(((x - rect.left) / rect.width) * GRID_Q);
      const ny = Math.floor(((y - rect.top) / rect.height) * GRID_Q);
      const key = `${nx},${ny}`;
      if (!visited.has(key)) {
        visited.add(key);
        return { x, y };
      }
    }
    // si está saturado, purga una parte para seguir moviéndose
    if (visited.size > GRID_Q * GRID_Q * 0.8) visited.clear();
    return null;
  };

  // Pan aleatorio eliminado para evitar cambios de posición/zoom

  // Encuentra el botón de Paint y devuelve el elemento (robusto, sin selectores con '/')
  const findPaintButton = () => {
    // Preferir botones primarios grandes cerca de la parte inferior
    const all = Array.from(document.querySelectorAll('button.btn-primary'));
    const painted = all
      .filter(b => /paint/i.test(b.textContent || ''))
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    if (painted.length) return painted[0];
    // Fallback genérico por texto
    const textButtons = Array.from(document.querySelectorAll('button')).filter(b => /paint/i.test(b.textContent || ''));
    // Ordenar por estar visible y más abajo en la pantalla
    const visible = textButtons
      .filter(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return visible[0] || textButtons[0] || null;
  };

  const clickElement = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const type of events) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }
    return true;
  };

  // Parse de countdown mm:ss y posibles cargas x/y del botón Paint
  const readPaintButtonState = () => {
    const btn = findPaintButton();
    const text = (btn?.textContent || '').trim();
    let cooldownMs = 0;
    const m = text.match(/\((\d{1,2}):(\d{2})\)/);
    if (m) {
      const mm = parseInt(m[1], 10) || 0;
      const ss = parseInt(m[2], 10) || 0;
      cooldownMs = (mm * 60 + ss) * 1000;
    }
    let available = null, max = null;
    const cm = text.match(/(\d+)\s*\/\s*(\d+)/);
    if (cm) {
      available = parseInt(cm[1], 10);
      max = parseInt(cm[2], 10);
    }
    // Heurística de disabled: confiar en atributo/clase visual. NO bloquear por countdown, ya que puede mostrar tiempo de recarga sin impedir usar cargas.
    const disabled = btn ? (btn.disabled || /disabled|btn-disabled|opacity-50/i.test(btn.className)) : true;
    return { btn, text, cooldownMs, available, max, disabled };
  };

  // ¿La paleta de colores está visible?
  const isPaletteOpen = () => {
    try {
      const paletteBtns = Array.from(document.querySelectorAll('[id^="color-"]'));
      if (paletteBtns.length === 0) return false;
      return paletteBtns.some(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    } catch {
      return false;
    }
  };

  // Asegura abrir la paleta: intenta pulsar el botón Paint si no está abierta
  const ensurePaletteOpen = async () => {
    if (isPaletteOpen()) return true;
    const pb = findPaintButton();
    if (pb) {
      clickElement(pb);
      await sleep(200 + Math.floor(Math.random() * 200));
      if (isPaletteOpen()) return true;
    }
    return isPaletteOpen();
  };

  const uiPaintFallback = (opts = {}) => {
    if (!CONFIG.UI_MODE) return false;
    // Clic en punto no visitado
    let p = pickUnvisitedPoint();
    if (!p) p = (() => { const c = getMainCanvas(); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })();
    const ok = p ? clickCanvasAt(p.x, p.y, opts) : clickCanvasRandom(opts);
  // Importante: no enviar un segundo clic para evitar zoom por doble clic
    return ok;
  };

  const isMacOS = () => {
    try { return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || ''); } catch { return false; }
  };

  // Una acción de pintura completa: abrir paleta -> elegir área -> color -> confirmar
  const doOneUIPaint = async (squaresToMark = 1) => {
    // Abrir paleta si está cerrada
    const opened = await ensurePaletteOpen();
    // Aunque no se abra, intentamos continuar: el flujo puede permitir pintar con color previo
    // Elegir color primero, luego marcar N cuadros (usando Ctrl/Cmd para multiselección)
    const id = chooseColor();
    selectColorInUI(id);
    await sleep(80 + Math.floor(Math.random() * 140));
    const mod = isMacOS() ? { metaKey: true } : { ctrlKey: true };
    const count = Math.max(1, Math.floor(squaresToMark));
    for (let i = 0; i < count; i++) {
      uiPaintFallback(mod);
      await sleep(90 + Math.floor(Math.random() * 140));
    }
    // Confirmar Paint (pinta todos los cuadros seleccionados, consumiendo múltiples cargas)
    const pb = readPaintButtonState();
    if (pb.btn) {
      clickElement(pb.btn);
      return true;
    }
    return false;
  };

  // Sistema de detección avanzado de Cloudflare
  let cloudflareDetected = false;
  let cfMutationObserver = null;
  let cfCheckInterval = null;
  
  // Detectar carga de recursos de Cloudflare desde network/performance
  const detectCloudflareFromNetwork = () => {
    try {
      // Buscar en recursos cargados
      const entries = performance.getEntriesByType('resource');
      const cfResources = entries.filter(entry => 
        entry.name.includes('challenges.cloudflare.com') ||
        entry.name.includes('cdn-cgi/challenge-platform') ||
        entry.name.includes('cf-challenge')
      );
      
      if (cfResources.length > 0) {
        console.log('🔍 Cloudflare detectado desde recursos de red:', cfResources.length);
        return true;
      }
      
      // Buscar scripts CF cargados
      const cfScripts = Array.from(document.scripts).filter(script => 
        script.src && (
          script.src.includes('challenges.cloudflare.com') ||
          script.src.includes('cdn-cgi/challenge-platform')
        )
      );
      
      return cfScripts.length > 0;
    } catch {
      return false;
    }
  };
  
  // Detección ultra-rápida de elementos CF visibles
  const findVisibleChallengeElements = () => {
    const isReallyVisible = (el) => {
      if (!el) return false;
      try {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && 
               rect.height > 0 && 
               style.display !== 'none' && 
               style.visibility !== 'hidden' &&
               style.opacity !== '0' &&
               rect.top >= 0 && 
               rect.left >= 0;
      } catch {
        return false;
      }
    };
    
    // Búsqueda prioritaria de elementos CF
    const selectors = [
      // Checkbox específico del desafío actual
      '.cb-lb input[type="checkbox"]',
      'input[type="checkbox"][data-cf]',
      'input[type="checkbox"][aria-label*="human"]',
      
      // Labels clickeables
      '.cb-lb',
      'label[for*="challenge"]',
      
      // Contenedores CF
      '.cf-challenge',
      '.cf-turnstile',
      '#challenge-overlay',
      '[data-sitekey]',
      '.main-wrapper.theme-auto',
      
      // Fallbacks
      'div[id^="cf-chl-widget"]',
      '[data-cf-challenge]'
    ];
    
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (isReallyVisible(el)) {
          console.log(`✅ Elemento CF visible encontrado: ${selector}`);
          return el;
        }
      }
    }
    
    return null;
  };
  
  // Detección por contenido de texto multiidioma mejorada
  const detectChallengeByText = () => {
    const texts = [
      // Español
      'verifica que eres un ser humano', 'verificar que', 'soy humano', 'cloudflare',
      // Inglés  
      'verify you are human', 'i am human', 'checking your browser', 'just a moment',
      // Francés
      'vérifiez que vous êtes humain', 'je suis humain', 'vérification',
      // Ruso
      'подтвердите что вы человек', 'я человек', 'проверка',
      // Holandés
      'controleer dat je een mens bent', 'ik ben een mens',
      // Ucraniano
      'підтвердіть що ви людина', 'я людина'
    ];
    
    const bodyText = (document.body?.textContent || '').toLowerCase();
    const titleText = (document.title || '').toLowerCase();
    
    return texts.some(text => bodyText.includes(text) || titleText.includes(text));
  };

  // Detección robusta combinando network + DOM + texto
  const isCloudflareChallenge = () => {
    // 1. Detectar desde recursos de red
    const networkDetection = detectCloudflareFromNetwork();
    
    // 2. Buscar elementos visibles
    const visibleElement = findVisibleChallengeElements();
    
    // 3. Detectar por texto
    const textDetection = detectChallengeByText();
    
    // Cloudflare está presente si:
    // - Se detectó desde network Y (hay elementos visibles O texto coincidente)
    // - O si hay elementos claramente visibles con texto coincidente
    const detected = (networkDetection && (visibleElement || textDetection)) || 
                     (visibleElement && textDetection);
    
    if (detected && !cloudflareDetected) {
      cloudflareDetected = true;
      console.log('🚨 CLOUDFLARE DETECTADO:', {
        network: networkDetection,
        visible: !!visibleElement,
        text: textDetection
      });
    }
    
    return detected;
  };

  const isChallengePresent = () => {
    return isCloudflareChallenge();
  };

  // Click ultra-rápido y eficiente en el checkbox
  const clickChallengeElement = async (element) => {
    if (!element) return false;
    
    try {
      // Scroll al elemento para asegurar visibilidad
      element.scrollIntoView({ behavior: 'instant', block: 'center' });
      
      // Esperar un frame para que el scroll complete
      await new Promise(resolve => requestAnimationFrame(resolve));
      
      // Multiple estrategias de click para máxima compatibilidad
      const clickMethods = [
        () => element.click(),
        () => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
        () => {
          const rect = element.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          element.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y
          }));
        }
      ];
      
      // Intentar cada método hasta que uno funcione
      for (const method of clickMethods) {
        try {
          method();
          await new Promise(resolve => setTimeout(resolve, 100)); // Breve pausa
          
          // Verificar si el click tuvo efecto
          if (element.checked || element.getAttribute('aria-checked') === 'true') {
            console.log('✅ Click exitoso en checkbox CF');
            return true;
          }
        } catch (err) {
          console.log('⚠️ Método de click falló:', err.message);
        }
      }
      
      return false;
    } catch (err) {
      console.error('❌ Error en clickChallengeElement:', err);
      return false;
    }
  };

  const clickElementCenter = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const type of events) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }
    return true;
  };

  // Sistema de monitoreo activo de Cloudflare
  const startCloudflareMonitoring = () => {
    // Detener monitoreo anterior si existe
    if (cfMutationObserver) {
      cfMutationObserver.disconnect();
    }
    if (cfCheckInterval) {
      clearInterval(cfCheckInterval);
    }
    
    // MutationObserver para detectar cambios DOM de CF
    cfMutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        // Detectar nuevos nodos que podrían ser CF
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node;
            if (el.className && (
                el.className.includes('cf-') ||
                el.className.includes('cb-') ||
                el.className.includes('challenge') ||
                el.className.includes('main-wrapper')
              )) {
              console.log('🔍 Posible elemento CF detectado via MutationObserver:', el.className);
              // Trigger immediate check
              setTimeout(() => isCloudflareChallenge(), 100);
            }
          }
        }
      }
    });
    
    // Observar cambios en todo el documento
    cfMutationObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'id', 'data-cf', 'data-sitekey']
    });
    
    // Verificación periódica cada 2 segundos
    cfCheckInterval = setInterval(() => {
      if (state.running) {
        isCloudflareChallenge();
      }
    }, 2000);
    
    console.log('🔍 Monitoreo activo de Cloudflare iniciado');
  };
  
  // Detener monitoreo cuando sea necesario
  const stopCloudflareMonitoring = () => {
    if (cfMutationObserver) {
      cfMutationObserver.disconnect();
      cfMutationObserver = null;
    }
    if (cfCheckInterval) {
      clearInterval(cfCheckInterval);
      cfCheckInterval = null;
    }
    cloudflareDetected = false;
    console.log('🔍 Monitoreo de Cloudflare detenido');
  };

  const handleChallengeIfNeeded = async () => {
    if (!isChallengePresent()) return 'none';
    
    const t = getTranslations();
    updateUI(`🔍 ${t.msgCFChallenge}`, 'warning');
    
    // Detección ultra-rápida de elemento visible
    const element = findVisibleChallengeElements();
    
    if (element) {
      updateUI('🎯 Elemento CF encontrado, resolviendo...', 'info');
      
      // Intentar click rápido
      const success = await clickChallengeElement(element);
      
      if (success) {
        updateUI('🔘 Checkbox marcado, verificando...', 'success');
        
        // Verificación rápida (solo 5 segundos)
        for (let i = 5; i > 0; i--) {
          if (!isChallengePresent()) {
            updateUI(t.msgCFValidated, 'success');
            cloudflareDetected = false; // Reset para futuras detecciones
            return 'solved';
          }
          updateUI(`⏳ Verificando... ${i}s`, 'default');
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    
    // Si llegamos aquí, no se pudo resolver automáticamente
    // Detener bot y solicitar intervención manual
    try {
      const tr = getTranslations();
      const toggleBtn = document.querySelector('#toggleBtn');
      state.running = false;
      if (toggleBtn) {
        toggleBtn.innerHTML = `<i class="fas fa-play"></i> <span>${tr.start}</span>`;
        toggleBtn.classList.add('wplace-btn-primary');
        toggleBtn.classList.remove('wplace-btn-stop');
      }
      updateUI('🚨 Cloudflare requiere intervención manual', 'warning');
    } catch {}
    
    return 'manual';
  };

  // Eliminado: lógica de servidor inaccesible (ahora solo validación de confirmación mínima en UI)

  // Espera en tiempo real hasta que haya cargas disponibles, actualizando el ETA
  const waitForChargesRealtime = async () => {
    const t = getTranslations();
    while (state.running) {
      const { charges, cooldownMs } = getLocalCharges();
      // Si hay objetivo de reanudación, esperar hasta alcanzarlo; si no, esperar a que haya al menos 1
      const target = Math.max(1, state.currentResumeTarget || 1);
      if (Math.floor(charges || 0) >= target) return;
  const pb = readPaintButtonState();
  const eta = Math.max(0, Math.min((cooldownMs || 0) || (pb.cooldownMs || 0) || 0, 5 * 60 * 1000));
      // Mostrar tanto el tiempo estimado como el progreso hacia el objetivo
      const cur = Math.floor(charges || 0);
      if (target > 1) {
        updateUI(t.msgWaitTarget(`${cur}/${target}`, formatTimeShort(eta || 1000)), 'default');
      } else {
        updateUI(t.msgCFBackoff(formatTimeShort(eta || 1000)), 'default');
      }
  await sleep(1000);
    }
  };

  // Pinta solo mediante la UI en este modo

  const paintLoop = async () => {
  let lastChargesCheck = 0;
    while (state.running) {
  // Chequeo temprano de reto Cloudflare
  const preStatus = await handleChallengeIfNeeded();
  if (preStatus === 'manual') break; // ya se detuvo y avisó
  // Eliminado: no forzar confirmación/cooldown por banner de servidor inaccesible
      // Asegurar colores de la UI antes de intentar pintar
      if (!state.availableColors || state.availableColors.length === 0) {
        state.availableColors = extractAvailableColors();
      }

      const now = Date.now();
      if (now - lastChargesCheck > 900) {
        tickLocalCharges();
        lastChargesCheck = now;
      }

      const t = getTranslations();
  let available = Math.floor(state.chargesLocal?.count || 0);

      if (available <= 0) {
        // Al llegar a 0, fijar objetivo de reanudación
        if (!state.currentResumeTarget) {
          const userT = parseInt(state.userResumeThreshold, 10);
          if (Number.isFinite(userT) && userT > 0) {
            state.currentResumeTarget = userT;
          } else {
            const minT = CONFIG.RESUME_CHARGES_MIN;
            const maxT = Math.max(minT, CONFIG.RESUME_CHARGES_MAX);
            state.currentResumeTarget = Math.floor(minT + Math.random() * (maxT - minT + 1));
          }
        }
        // Aplicar un cooldown mínimo de 30s por cada carga objetivo
        try {
          const resumeTarget = Math.max(1, state.currentResumeTarget || 1);
          const minWaitMs = resumeTarget * 30000; // 30s por carga objetivo
          const tr = getTranslations();
          const startAt = Date.now();
          const endAt = startAt + minWaitMs;
          while (state.running) {
            // Si hay reto CF, intentar resolver o detener
            const s = await handleChallengeIfNeeded();
            if (s === 'manual') break;
            // Si ya alcanzamos el objetivo de reanudación, salimos antes
            const { charges } = getLocalCharges();
            if (Math.floor(charges || 0) >= resumeTarget) break;
            const left = Math.max(0, endAt - Date.now());
            // Si terminó el tiempo mínimo, salir
            if (left <= 0) break;
            // Mostrar progreso y tiempo restante mínimo
            try {
              const cur = Math.floor(charges || 0);
              updateUI(tr.msgWaitTarget(`${cur}/${resumeTarget}`, formatTimeShort(left)), 'default');
            } catch {}
            await sleep(1000);
          }
        } catch {}
        // Mientras esperamos cargas, seguir vigilando reto CF
  const waitLoop = async () => {
          while (state.running) {
            const s = await handleChallengeIfNeeded();
            if (s === 'manual') return 'manual';
      const { charges } = getLocalCharges();
            if (Math.floor(charges || 0) >= (state.currentResumeTarget || 1)) return 'ready';
            await sleep(1000);
          }
          return 'stopped';
        };
        const w = await waitLoop();
        if (w === 'manual' || w === 'stopped') { updateStats(); break; }
        
        // Redundante, pero deja claro el estado
        await waitForChargesRealtime();
        updateStats();
        lastChargesCheck = 0; // forzar refresh
        continue;
      }

      // Consumir todas las cargas disponibles en ráfaga, verificando por API cada intento
  let paintedThisBurst = 0;
  // Hemos empezado una ráfaga: limpiar el objetivo de reanudación ya alcanzado
  state.currentResumeTarget = null;
      while (state.running && available > 0) {
        // Si aparece un reto de Cloudflare, intentar resolver antes de continuar
        const challengePre = await handleChallengeIfNeeded();
        if (challengePre === 'failed' || challengePre === 'manual') {
          if (challengePre === 'failed') {
            const t = getTranslations();
            updateUI(t.msgCFChallenge, 'warning');
            await sleep(3000);
          }
          updateStats();
          break;
        }
        // No pan para evitar cambios de posición/zoom
        const beforeSnapshot = Math.floor(available);
        // Tomar una referencia UI previa (si muestra x/y) para usar como señal secundaria
        const pbBeforeCheck = readPaintButtonState();
        const uiAvailBefore = Number.isFinite(pbBeforeCheck?.available) ? pbBeforeCheck.available : null;
        // Determinar cuántos cuadros marcar en esta acción (no exceder cargas disponibles)
        const userSPA = (Number.isFinite(state.userSquaresPerAction) && state.userSquaresPerAction >= 1) ? Math.floor(state.userSquaresPerAction) : 1;
  // Si /me está en pausa, ser conservadores: pintar solo 1
  const effectiveSPA = (state.meBackoffPaintsLeft > 0) ? 1 : userSPA;
  const selectionCount = Math.max(1, Math.min(effectiveSPA, beforeSnapshot));
        const committed = await doOneUIPaint(selectionCount);
        await sleep(120 + Math.floor(Math.random() * 220));
        const t = getTranslations();
        // Iniciar confirmación: durante este periodo no declarar éxito hasta terminar
        const confirmWaitSec = Number.isFinite(state.userConfirmWaitSec) && state.userConfirmWaitSec >= 0
          ? state.userConfirmWaitSec
          : CONFIG.CONFIRM_WAIT_SECONDS;
        const confirmWaitMs = confirmWaitSec * 1000;
        const startConfirm = Date.now();
        let observedAfter = beforeSnapshot;
        let seenDecrement = false;
        while (state.running && Date.now() - startConfirm < confirmWaitMs) {
          const left = Math.max(0, confirmWaitMs - (Date.now() - startConfirm));
          const secs = Math.ceil(left / 1000);
          updateUI(t.msgConfirmWait(`${secs}s`), 'default');
          // Actualizar según reloj local y UI
          try {
            const lc = getLocalCharges();
            const floorNow = Math.floor(lc.charges || 0);
            observedAfter = floorNow;
            available = floorNow;
            updateStats();
            if (uiAvailBefore != null) {
              const pbNow = readPaintButtonState();
              const uiAvailNow = Number.isFinite(pbNow?.available) ? pbNow.available : null;
              if (uiAvailNow != null && uiAvailBefore != null && uiAvailNow < uiAvailBefore) seenDecrement = true;
            }
          } catch {}
          await sleep(1000);
        }
  // Nota: si se ha pausado durante la confirmación, no mostramos mensajes,
  // pero seguimos evaluando el resultado para poder sincronizar /me si procede.
        // Resultado final observado en el sondeo
        const afterFloor = observedAfter;
        let didSucceed = committed || seenDecrement;
        // Señal secundaria: si el botón muestra x/y y bajó, aceptar como éxito
        const pbAfterCheck = readPaintButtonState();
        const uiAvailAfter = Number.isFinite(pbAfterCheck?.available) ? pbAfterCheck.available : null;
        if (!didSucceed && committed) {
          if (uiAvailBefore != null && uiAvailAfter != null && uiAvailAfter < uiAvailBefore) didSucceed = true;
        }

        // Calcular cuántas cargas se consumieron realmente (para estadísticas precisas)
        const finalAvail = Number.isFinite(available) ? Math.floor(available) : afterFloor;
        const uiConsumed = (uiAvailBefore != null && uiAvailAfter != null && uiAvailAfter < uiAvailBefore)
          ? Math.max(0, uiAvailBefore - uiAvailAfter)
          : 0;
        const desiredConsumed = selectionCount;
        let consumed = Number.isFinite(uiConsumed) && uiConsumed > 0 ? uiConsumed : desiredConsumed;
        consumed = Math.max(1, Math.min(consumed, beforeSnapshot));

        if (didSucceed) {
          state.consecutiveFails = 0;
          state.paintedCount += Math.max(1, consumed || 0);
          paintedThisBurst++;
          // Contabilizar backoff de /me: si está activo, no consultar /me y disminuir el contador
          if (state.meBackoffPaintsLeft > 0) {
            state.meBackoffPaintsLeft = Math.max(0, state.meBackoffPaintsLeft - 1);
            try { await updateStats(); } catch {}
            if (state.meBackoffPaintsLeft === 0) {
              const tr = getTranslations();
              updateUI(tr.msgMeBackoffEnd || 'Reanudando /me', 'success');
            }
          } else if (state.running) {
            try {
              const me = await WPlaceService.getMe();
              if (me && me.__errorStatus === 400) {
                // Ban temporal: pausar /me por 10 pintadas
                state.meBackoffPaintsLeft = 10;
                const tr = getTranslations();
                updateUI(tr.msgMeBackoffStart(10), 'warning');
              } else if (me && !Number.isFinite(me.__errorStatus)) {
                const c = Math.max(0, Math.floor(me?.charges?.count ?? 0));
                const cd = Math.max(0, Math.floor(me?.charges?.cooldownMs ?? 0));
                const mx = Number.isFinite(me?.charges?.max) ? Math.max(1, Math.floor(me.charges.max)) : (state.chargesLocal.max || 80);
                state.chargesLocal.max = mx;
                state.chargesLocal.count = c;
                state.chargesLocal.regenIntervalMs = Math.max(1000, cd || state.chargesLocal.regenIntervalMs || 30000);
                state.chargesLocal.nextAt = (c < mx)
                  ? Date.now() + state.chargesLocal.regenIntervalMs
                  : null;
                // Actualizar datos de usuario
                try {
                  state.userInfo = {
                    name: me.name || state.userInfo?.name,
                    allianceId: me.allianceId,
                    allianceRole: me.allianceRole,
                    droplets: me.droplets,
                    level: me.level,
                    pixelsPainted: me.pixelsPainted
                  };
                } catch {}
              }
            } catch {}
            // Refrescar estadísticas inmediatamente con los datos exactos del servidor
            try { await updateStats(); } catch {}
          }
          // Mostrar éxito y efecto al finalizar la confirmación
          if (state.running) {
            updateUI(t.msgPaintOk, 'success');
          }
          if (state.running) {
            const effPre = document.getElementById('paintEffect');
            if (effPre) { effPre.style.animation = 'pulse 0.5s'; setTimeout(() => { try { effPre.style.animation = ''; } catch {} }, 500); }
          }
        } else {
          state.consecutiveFails = (state.consecutiveFails || 0) + 1;
          if (state.running) {
            updateUI(t.msgPaintFail, 'error');
          }
          // Si /me está pausado, aplicar espera de 2 minutos antes de continuar para intentar desbloquear
          if (state.meBackoffPaintsLeft > 0) {
            const waitMs = 2 * 60 * 1000;
            const endAt = Date.now() + waitMs;
            while (state.running && Date.now() < endAt) {
              const left = Math.max(0, endAt - Date.now());
              const secs = Math.ceil(left / 1000);
              try { updateUI(t.msgWait2m(`${secs}s`), 'default'); } catch {}
              await sleep(1000);
            }
          }
          // Intentar recuperación de zoom si el usuario lo permite y han pasado al menos 30s
          try {
            const nowTs = Date.now();
            if (state.autoZoomOnFail && (nowTs - (state.lastZoomRecoveryAt || 0) > 30000)) {
              state.lastZoomRecoveryAt = nowTs;
              await ensureDispersionZoom();
            }
          } catch {}
          const maxFails = Number.isFinite(state.userMaxConsecFails) && state.userMaxConsecFails >= 1 ? state.userMaxConsecFails : CONFIG.MAX_CONSEC_FAILS;
          if (state.consecutiveFails >= maxFails) {
            state.running = false;
            triggerSafeReload('consecutive-fails');
            break;
          }
        }

        // Si se pausó durante el proceso, salir de la ráfaga de inmediato
        if (!state.running) {
          break;
        }

        // Si aparece un reto de Cloudflare, intentar resolver antes de continuar
        const challengeStatus = await handleChallengeIfNeeded();
        if (challengeStatus === 'failed' || challengeStatus === 'manual') {
          if (challengeStatus === 'failed') {
            updateUI(t.msgCFChallenge, 'warning');
            await sleep(3000);
          }
          break; // salir de la ráfaga; en 'manual' ya se detuvo y se avisó
        }

        // Pequeña pausa humana entre clics de ráfaga
        await sleep(250 + Math.floor(Math.random() * 400));
        // Refrescar stats cada 3 pinturas
  if (paintedThisBurst % 3 === 0) updateStats();
      }

      // Tras la ráfaga, breve espera y refresco de estado
      await sleep(500 + Math.floor(Math.random() * 600));
      updateStats();
      lastChargesCheck = 0; // forzar nueva lectura de API en el siguiente ciclo
    }
  };

  const createUI = () => {
    if (state.menuOpen) return;
    state.menuOpen = true;

    const fontAwesome = document.createElement('link');
    fontAwesome.rel = 'stylesheet';
    fontAwesome.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
    document.head.appendChild(fontAwesome);

    const style = document.createElement('style');
    style.textContent = `
      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(0, 255, 0, 0.7); }
        70% { box-shadow: 0 0 0 10px rgba(0, 255, 0, 0); }
        100% { box-shadow: 0 0 0 0 rgba(0, 255, 0, 0); }
      }
      @keyframes slideIn {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      .wplace-bot-panel {
        position: fixed;
        top: 20px;
        right: 20px;
        width: 250px;
        background: ${CONFIG.THEME.primary};
        border: 1px solid ${CONFIG.THEME.accent};
        border-radius: 8px;
        padding: 0;
        box-shadow: 0 5px 15px rgba(0,0,0,0.5);
        z-index: 9999;
        font-family: 'Segoe UI', Roboto, sans-serif;
        color: ${CONFIG.THEME.text};
        animation: slideIn 0.4s ease-out;
        overflow: hidden;
      }
      .wplace-header {
        padding: 12px 15px;
        background: ${CONFIG.THEME.secondary};
        color: ${CONFIG.THEME.highlight};
        font-size: 16px;
        font-weight: 600;
        display: flex;
        justify-content: space-between;
        align-items: center;
        cursor: move;
        user-select: none;
      }
      .wplace-header-title {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .wplace-header-controls {
        display: flex;
        gap: 10px;
      }
      .wplace-header-btn {
        background: none;
        border: none;
        color: ${CONFIG.THEME.text};
        cursor: pointer;
        opacity: 0.7;
        transition: opacity 0.2s;
      }
      .wplace-header-btn:hover {
        opacity: 1;
      }
      .wplace-content {
        padding: 15px;
        display: ${state.minimized ? 'none' : 'block'};
  position: relative;
      }
      .wplace-controls {
        display: flex;
        gap: 10px;
        margin-bottom: 15px;
      }
      .wplace-btn {
        flex: 1;
        padding: 10px;
        border: none;
        border-radius: 6px;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        transition: all 0.2s;
      }
      .wplace-btn:hover {
        transform: translateY(-2px);
      }
      .wplace-btn-primary {
        background: ${CONFIG.THEME.accent};
        color: white;
      }
      .wplace-btn-stop {
        background: ${CONFIG.THEME.error};
        color: white;
      }
      .wplace-stats {
        background: ${CONFIG.THEME.secondary};
        padding: 12px;
        border-radius: 6px;
        margin-bottom: 15px;
      }
      .wplace-stat-item {
        display: flex;
        justify-content: space-between;
        padding: 6px 0;
        font-size: 14px;
      }
      .wplace-stat-label {
        display: flex;
        align-items: center;
        gap: 6px;
        opacity: 0.8;
      }
      .wplace-status {
        padding: 8px;
        border-radius: 4px;
        text-align: center;
        font-size: 13px;
      }
      .wplace-footer {
        position: relative;
        display: flex;
        justify-content: flex-end;
        margin-top: 8px;
      }
      .status-default {
        background: rgba(255,255,255,0.1);
      }
      .status-success {
        background: rgba(0, 255, 0, 0.1);
        color: ${CONFIG.THEME.success};
      }
      .status-error {
        background: rgba(255, 0, 0, 0.1);
        color: ${CONFIG.THEME.error};
      }
      #paintEffect {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        border-radius: 8px;
      }
      /* Small settings gear inside panel footer */
      .wplace-gear-btn {
        width: 24px;
        height: 24px;
        border-radius: 4px;
        background: ${CONFIG.THEME.accent};
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        cursor: pointer;
        z-index: 1;
        border: none;
        font-size: 14px;
      }
      .wplace-gear-menu {
        position: absolute;
        right: 0;
        bottom: 36px;
        min-width: 180px;
        background: ${CONFIG.THEME.primary};
        color: ${CONFIG.THEME.text};
        border: 1px solid ${CONFIG.THEME.accent};
        border-radius: 8px;
        box-shadow: 0 8px 20px rgba(0,0,0,0.55);
        z-index: 20;
        display: none;
        overflow: hidden;
      }
      .wplace-gear-item {
        padding: 10px 12px;
        display: flex;
        gap: 8px;
        align-items: center;
        cursor: pointer;
      }
      .wplace-gear-item:hover {
        background: ${CONFIG.THEME.secondary};
      }
      /* Avisos/errores ligeros */
      .wplace-hint {
        margin-top: 4px;
        font-size: 12px;
        color: ${CONFIG.THEME.warning};
      }
      .wplace-input-error {
        border-color: ${CONFIG.THEME.error} !important;
        box-shadow: 0 0 0 2px rgba(255,0,0,0.15);
      }
    `;
    document.head.appendChild(style);

  const translations = getTranslations();
  const t = translations;

    const panel = document.createElement('div');
    panel.className = 'wplace-bot-panel';
    panel.innerHTML = `
      <div id="paintEffect"></div>
      <div class="wplace-header">
        <div class="wplace-header-title">
          <i class="fas fa-paint-brush"></i>
          <span>${t.title}</span>
        </div>
        <div class="wplace-header-controls">
          <button id="minimizeBtn" class="wplace-header-btn" title="${t.minimize}">
            <i class="fas fa-${state.minimized ? 'expand' : 'minus'}"></i>
          </button>
        </div>
      </div>
      <div class="wplace-content">
        <div class="wplace-controls">
          <button id="toggleBtn" class="wplace-btn wplace-btn-primary">
            <i class="fas fa-play"></i>
            <span>${t.start}</span>
          </button>
        </div>
        <div class="wplace-stats" style="margin-top: -5px;">
          <div class="wplace-stat-item" style="gap:8px; align-items:center;">
            <div class="wplace-stat-label"><i class="fas fa-hourglass"></i> ${t.labelConfirmWait}</div>
            <div>
              <input id="inpConfirmWait" type="number" min="0" step="1" value="${CONFIG.CONFIRM_WAIT_SECONDS}" style="width:64px; padding:4px; border-radius:4px; border:1px solid ${CONFIG.THEME.accent}; background:${CONFIG.THEME.primary}; color:${CONFIG.THEME.text};"> s
              <div id="confirmWaitHint" class="wplace-hint" style="display:none;"></div>
            </div>
          </div>
          <div class="wplace-stat-item" style="gap:8px; align-items:center;">
            <div class="wplace-stat-label"><i class="fas fa-battery-three-quarters"></i> ${t.labelResumeThreshold}</div>
            <div>
              <input id="inpResumeThreshold" type="number" min="1" step="1" placeholder="auto" style="width:80px; padding:4px; border-radius:4px; border:1px solid ${CONFIG.THEME.accent}; background:${CONFIG.THEME.primary}; color:${CONFIG.THEME.text};">
            </div>
          </div>
          <div class="wplace-stat-item" style="gap:8px; align-items:center;">
            <div class="wplace-stat-label"><i class="fas fa-th-large"></i> ${t.labelSquaresPerAction}</div>
            <div>
              <input id="inpSquaresPerAction" type="number" min="1" step="1" value="1" style="width:64px; padding:4px; border-radius:4px; border:1px solid ${CONFIG.THEME.accent}; background:${CONFIG.THEME.primary}; color:${CONFIG.THEME.text};">
            </div>
          </div>
          <div class="wplace-stat-item" style="gap:8px; align-items:center;">
            <div class="wplace-stat-label"><i class="fas fa-triangle-exclamation"></i> ${t.labelMaxFails}</div>
            <div>
              <input id="inpMaxFails" type="number" min="1" step="1" value="${CONFIG.MAX_CONSEC_FAILS}" style="width:64px; padding:4px; border-radius:4px; border:1px solid ${CONFIG.THEME.accent}; background:${CONFIG.THEME.primary}; color:${CONFIG.THEME.text};">
            </div>
          </div>
        </div>
        
        <div class="wplace-stats">
          <div id="statsArea">
            <div class="wplace-stat-item">
              <div class="wplace-stat-label"><i class="fas fa-paint-brush"></i> ${t.loading}</div>
            </div>
          </div>
        </div>
        
        <div id="statusText" class="wplace-status status-default">
          ${t.ready}
        </div>
      </div>
    `;
    
  document.body.appendChild(panel);
  // Settings gear inside panel footer, placed below status
    const gearBtn = document.createElement('button');
    gearBtn.className = 'wplace-gear-btn';
    gearBtn.title = t.settings || '';
    gearBtn.innerHTML = `<i class="fas fa-gear"></i>`;
    const gearMenu = document.createElement('div');
    gearMenu.className = 'wplace-gear-menu';
    gearMenu.innerHTML = `
      <div id="wplaceCalibZoomItem" class="wplace-gear-item" title="${t.zoomCalibHint}">
        <i class="fas fa-magnifying-glass"></i>
        <span>${t.zoomCalib}</span>
      </div>
      <div id="wplaceAutoZoomToggle" class="wplace-gear-item" title="${t.autoZoomOnFailHint || ''}">
        <i class="fas fa-microscope"></i>
        <span>${t.autoZoomOnFail || 'Auto-calibrate on fail'}</span>
        <input id="wplaceAutoZoomChk" type="checkbox" style="margin-left:auto;">
      </div>
      <div id="wplaceResetCountersItem" class="wplace-gear-item" title="${t.resetCountersHint || ''}">
        <i class="fas fa-rotate-left"></i>
        <span>${t.resetCounters || 'Reset counter'}</span>
      </div>
      <div id="wplaceRefreshMeItem" class="wplace-gear-item" title="${t.refreshMeHint || ''}">
        <i class="fas fa-bolt"></i>
        <span>${t.refreshMe || 'Refresh /me now'}</span>
      </div>
      <div id="wplaceCheckHealthItem" class="wplace-gear-item" title="${t.healthCheckHint || ''}">
        <i class="fas fa-heart-pulse"></i>
        <span>${t.healthCheck || 'Check health'}</span>
      </div>
    `;
  const contentEl = panel.querySelector('.wplace-content');
  const footer = document.createElement('div');
  footer.className = 'wplace-footer';
  footer.appendChild(gearBtn);
  footer.appendChild(gearMenu);
  contentEl.appendChild(footer);
    
    const header = panel.querySelector('.wplace-header');
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    
    header.onmousedown = dragMouseDown;
    
    function dragMouseDown(e) {
      if (e.target.closest('.wplace-header-btn')) return;
      
      e = e || window.event;
      e.preventDefault();
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    }
    
    function elementDrag(e) {
      e = e || window.event;
      e.preventDefault();
      pos1 = pos3 - e.clientX;
      pos2 = pos4 - e.clientY;
      pos3 = e.clientX;
      pos4 = e.clientY;
      panel.style.top = (panel.offsetTop - pos2) + "px";
      panel.style.left = (panel.offsetLeft - pos1) + "px";
    }
    
    function closeDragElement() {
      document.onmouseup = null;
      document.onmousemove = null;
    }
    
  const toggleBtn = panel.querySelector('#toggleBtn');
    const minimizeBtn = panel.querySelector('#minimizeBtn');
    const statusText = panel.querySelector('#statusText');
    const content = panel.querySelector('.wplace-content');
    const statsArea = panel.querySelector('#statsArea');
  const inpConfirmWait = panel.querySelector('#inpConfirmWait');
  const inpResumeThreshold = panel.querySelector('#inpResumeThreshold');
  const inpSquaresPerAction = panel.querySelector('#inpSquaresPerAction');
  const inpMaxFails = panel.querySelector('#inpMaxFails');
  const confirmWaitHint = panel.querySelector('#confirmWaitHint');

    // Aplicar ajustes cargados
    if (state.userConfirmWaitSec != null && inpConfirmWait) inpConfirmWait.value = state.userConfirmWaitSec;
    // Validación inicial del tiempo de confirmación mínimo recomendado (10s)
    const validateConfirmWait = () => {
      if (!inpConfirmWait || !confirmWaitHint) return;
      const tr = getTranslations();
      const v = parseInt(inpConfirmWait.value, 10);
      const below = Number.isFinite(v) ? v < 10 : false;
      if (below) {
        inpConfirmWait.classList.add('wplace-input-error');
        confirmWaitHint.style.display = 'block';
        confirmWaitHint.textContent = tr.warnConfirmMin || 'Se recomienda mínimo 10s para evitar bloqueos.';
      } else {
        inpConfirmWait.classList.remove('wplace-input-error');
        confirmWaitHint.style.display = 'none';
        confirmWaitHint.textContent = '';
      }
    };
    // Ejecutar una vez al iniciar UI
    setTimeout(validateConfirmWait, 0);
    if (state.userResumeThreshold != null && inpResumeThreshold) inpResumeThreshold.value = state.userResumeThreshold;
  if (state.userMaxConsecFails != null && inpMaxFails) inpMaxFails.value = state.userMaxConsecFails;
  if (state.userSquaresPerAction != null && inpSquaresPerAction) inpSquaresPerAction.value = state.userSquaresPerAction;
    
    const stopBot = () => {
      const tr = getTranslations();
      state.running = false;
      toggleBtn.innerHTML = `<i class="fas fa-play"></i> <span>${tr.start}</span>`;
      toggleBtn.classList.add('wplace-btn-primary');
      toggleBtn.classList.remove('wplace-btn-stop');
      
      // Detener monitoreo de Cloudflare
      stopCloudflareMonitoring();
    };

  toggleBtn.addEventListener('click', async () => {
      if (!state.running) {
        state.running = true;
  toggleBtn.innerHTML = `<i class="fas fa-stop"></i> <span>${t.stop}</span>`;
        toggleBtn.classList.remove('wplace-btn-primary');
        toggleBtn.classList.add('wplace-btn-stop');
  try { await initChargesFromServerOnce(); } catch {}
  updateUI(t.msgStart, 'success');
    
    // Iniciar monitoreo de Cloudflare
    startCloudflareMonitoring();
    
    paintLoop();
      } else {
        stopBot();
        updateUI(t.msgPaused, 'default');
      }
    });
    const openCloseGear = (open) => {
      gearMenu.style.display = open ? 'block' : 'none';
    };
    gearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const opened = gearMenu.style.display === 'block';
      openCloseGear(!opened);
    });
    document.addEventListener('click', (e) => {
      if (!gearMenu.contains(e.target)) openCloseGear(false);
    });
    document.getElementById('wplaceCalibZoomItem')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      openCloseGear(false);
      try { await ensureDispersionZoom(); } catch {}
    });
    // Init auto-zoom checkbox
    const chk = document.getElementById('wplaceAutoZoomChk');
    if (chk) {
      chk.checked = !!state.autoZoomOnFail;
      chk.addEventListener('change', () => {
        state.autoZoomOnFail = !!chk.checked;
        saveSettings();
      });
    }
    document.getElementById('wplaceResetCountersItem')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openCloseGear(false);
      try {
        state.paintedCount = 0;
        state.consecutiveFails = 0;
        try { visited.clear(); } catch {}
        updateStats();
        const tr = getTranslations();
        updateUI(tr.msgCountersReset || 'Counters reset', 'success');
      } catch {}
    });
    document.getElementById('wplaceRefreshMeItem')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      openCloseGear(false);
      try {
        // Llamar a la API, con manejo de 400 (ban temporal CF)
        const res = await fetch('https://backend.wplace.live/me', { credentials: 'include' });
        if (res.status === 400) {
          const tr = getTranslations();
          updateUI(tr.msgCFTempBan || 'Temporarily banned by Cloudflare. Try later.', 'error');
          // Activar pausa de /me por 10 pintadas
          state.meBackoffPaintsLeft = 10;
          try { updateUI(tr.msgMeBackoffStart(10), 'warning'); } catch {}
          return;
        }
        const info = await res.json();
    document.getElementById('wplaceCheckHealthItem')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      openCloseGear(false);
      try {
        const res = await fetch('https://backend.wplace.live/health', { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const info = await res.json();
        const tr = getTranslations();
        const up = info?.up === true ? '✔' : '✖';
        const db = info?.database === true ? '✔' : '✖';
        const uptime = info?.uptime || '-';
        updateUI(tr.msgHealth(up, db, uptime), info?.up ? 'success' : 'warning');
      } catch (err) {
        const tr = getTranslations();
        updateUI(tr.msgHealthError || 'Health check failed', 'error');
      }
    });
        const count = Math.max(0, Math.floor(info?.charges?.count ?? 0));
        const cd = Math.max(0, Math.floor(info?.charges?.cooldownMs ?? 0));
        const mx = Number.isFinite(info?.charges?.max) ? Math.max(1, Math.floor(info.charges.max)) : (state.chargesLocal.max || 80);
        state.chargesLocal.max = mx;
        state.chargesLocal.count = count;
        state.chargesLocal.regenIntervalMs = Math.max(1000, cd || state.chargesLocal.regenIntervalMs || 30000);
        // Si no estamos al máximo, programar siguiente
        state.chargesLocal.nextAt = (state.chargesLocal.count < (state.chargesLocal.max || 80))
          ? Date.now() + state.chargesLocal.regenIntervalMs
          : null;
        // Actualizar datos de usuario relevantes
        try {
          state.userInfo = {
            name: info.name || state.userInfo?.name,
            allianceId: info.allianceId,
            allianceRole: info.allianceRole,
            droplets: info.droplets,
            level: info.level,
            pixelsPainted: info.pixelsPainted
          };
        } catch {}
        updateStats();
        const tr = getTranslations();
        updateUI(tr.msgChargesRefreshed || 'Charges refreshed', 'success');
      } catch {
        const tr = getTranslations();
        updateUI(tr.msgRefreshError || 'Failed to refresh /me', 'error');
      }
    });
    
    minimizeBtn.addEventListener('click', () => {
      state.minimized = !state.minimized;
      content.style.display = state.minimized ? 'none' : 'block';
      minimizeBtn.innerHTML = `<i class="fas fa-${state.minimized ? 'expand' : 'minus'}"></i>`;
    });

  // Gear ahora vive dentro del panel; sin reposicionamiento dinámico externo

    // Handlers de ajustes
    const onConfirmWaitChange = () => {
      const v = parseInt(inpConfirmWait.value, 10);
      state.userConfirmWaitSec = Number.isFinite(v) && v >= 0 ? v : null;
  saveSettings();
      // Validación visual
      const tr = getTranslations();
      const below = Number.isFinite(v) ? v < 10 : false;
      if (below) {
        inpConfirmWait.classList.add('wplace-input-error');
        if (confirmWaitHint) {
          confirmWaitHint.style.display = 'block';
          confirmWaitHint.textContent = tr.warnConfirmMin || 'Se recomienda mínimo 10s para evitar bloqueos.';
        }
      } else {
        inpConfirmWait.classList.remove('wplace-input-error');
        if (confirmWaitHint) {
          confirmWaitHint.style.display = 'none';
          confirmWaitHint.textContent = '';
        }
      }
    };
    inpConfirmWait?.addEventListener('change', onConfirmWaitChange);
    inpConfirmWait?.addEventListener('input', onConfirmWaitChange);
    inpResumeThreshold?.addEventListener('change', () => {
      const v = parseInt(inpResumeThreshold.value, 10);
      state.userResumeThreshold = Number.isFinite(v) && v > 0 ? v : null;
      // Reiniciar objetivo para aplicar en el próximo ciclo de 0
      state.currentResumeTarget = null;
  saveSettings();
    });
    inpSquaresPerAction?.addEventListener('change', () => {
      const v = parseInt(inpSquaresPerAction.value, 10);
      state.userSquaresPerAction = Number.isFinite(v) && v >= 1 ? v : null;
      saveSettings();
    });
    inpMaxFails?.addEventListener('change', () => {
      const v = parseInt(inpMaxFails.value, 10);
      state.userMaxConsecFails = Number.isFinite(v) && v >= 1 ? v : null;
      saveSettings();
    });
    
    window.addEventListener('beforeunload', () => {
      state.menuOpen = false;
    });
  };

  window.updateUI = (message, type = 'default') => {
    const statusText = document.querySelector('#statusText');
    if (statusText) {
      statusText.textContent = message;
      statusText.className = `wplace-status status-${type}`;
      statusText.style.animation = 'none';
      void statusText.offsetWidth;
      statusText.style.animation = 'slideIn 0.3s ease-out';
    }
  };

  window.updateStats = async () => {
    const now = Date.now();
    // En modo UI-only no consultamos la API; solo refrescamos el panel si pasó un tiempo
    if (now - state.lastStatsUpdate <= 1000) return;
    state.lastStatsUpdate = now;
    const statsArea = document.querySelector('#statsArea');
    if (statsArea) {
      const tr = getTranslations();
      // Usar modelo local, fallback a UI
  let chargesText = '-';
      try {
        const lc = getLocalCharges();
        const count = Math.floor(lc.charges || 0);
        chargesText = `${count}`;
      } catch {
        const pb = readPaintButtonState();
        chargesText = (pb.available != null) ? `${pb.available}` : '-';
      }

      const allianceStr = (state.userInfo?.allianceId ? `#${state.userInfo.allianceId}` : '-') + (state.userInfo?.allianceRole ? ` (${state.userInfo.allianceRole})` : '');
      const levelStr = (Number.isFinite(state.userInfo?.level) ? Math.floor(state.userInfo.level) : '-') + '';
      const dropletsStr = Number.isFinite(state.userInfo?.droplets) ? `${state.userInfo.droplets}` : '-';
      const paintedStr = Number.isFinite(state.userInfo?.pixelsPainted) ? `${state.userInfo.pixelsPainted}` : `${state.paintedCount}`;
      const apiRow = (() => {
        const n = Math.max(0, state.meBackoffPaintsLeft || 0);
        if (n > 0) return { label: tr.api, value: tr.apiPaused(n) };
        return { label: tr.api, value: tr.apiActive };
      })();

  statsArea.innerHTML = `
        <div class="wplace-stat-item">
          <div class="wplace-stat-label"><i class="fas fa-user"></i> ${tr.user}</div>
          <div>${state.userInfo?.name || '-'}</div>
        </div>
        <div class="wplace-stat-item">
          <div class="wplace-stat-label"><i class="fas fa-people-group"></i> ${tr.alliance}</div>
          <div>${allianceStr}</div>
        </div>
        <div class="wplace-stat-item">
          <div class="wplace-stat-label"><i class="fas fa-splotch"></i> ${tr.droplets}</div>
          <div>${dropletsStr}</div>
        </div>
        <div class="wplace-stat-item">
          <div class="wplace-stat-label"><i class="fas fa-signal"></i> ${tr.level}</div>
          <div>${levelStr}</div>
        </div>
        <div class="wplace-stat-item">
          <div class="wplace-stat-label"><i class="fas fa-paint-brush"></i> ${tr.pixels}</div>
          <div>${paintedStr}</div>
        </div>
        <div class="wplace-stat-item">
          <div class="wplace-stat-label"><i class="fas fa-bolt"></i> ${tr.charges}</div>
          <div>${chargesText}</div>
        </div>
        <div class="wplace-stat-item">
          <div class="wplace-stat-label"><i class="fas fa-server"></i> ${apiRow.label}</div>
          <div>${apiRow.value}</div>
        </div>
      `;
    }
  };

  // Traducciones y textos
  function getTranslations() {
    const dict = {
      es: {
        title: "WPlace Auto-Farm",
        start: "Iniciar",
        stop: "Detener",
        ready: "Listo para empezar",
        user: "Usuario",
    pixels: "Píxeles",
  charges: "Cargas",
  cooldown: "Espera",
  alliance: "Alianza",
  droplets: "Droplets",
  level: "Nivel",
        minimize: "Minimizar",
        loading: "Cargando...",
        msgStart: "🚀 Pintura iniciada!",
        msgPaused: "⏸️ Pintura en pausa",
        msgPaintOk: "✅ Píxel pintado!",
        msgPaintFail: "❌ Error al pintar",
    msgCFChallenge: "⚠️ Posible reto de seguridad. Cierra las DevTools si están abiertas.",
    msgCFBackoff: (t) => `Esperando ${t} antes de reintentar...`,
  msgCFValidated: "✅ Validación completada. Reanudando...",
  msgCFManual: "⚠️ Pulsa el desafío de Cloudflare y espera 5s. Luego vuelve a Iniciar.",
  msgUIFallback: "🤖 Intentando clic vía UI para validar...",
  msgConfirmWait: (t) => `Espera ${t}`,
  msgWaitTarget: (p, t) => `Recargando ${p} · ETA ${t}`,
  labelConfirmWait: "Confirmación",
  labelResumeThreshold: "Reanudar con",
  labelSquaresPerAction: "Cuadros por acción",
  labelMaxFails: "Reintentos",
  msgReloading: "⚠️ Demasiados errores. Recargando la página…",
  msgAutoResume: "⏩ Reanudando tras recarga..."
  , msgZoomAdjust: "Ajustando zoom…"
  , settings: "Ajustes"
  , zoomCalib: "Calibrar zoom"
  , zoomCalibHint: "Ajusta el zoom si no puedes pintar"
  , autoZoomOnFail: "Auto-calibrar al fallar"
  , autoZoomOnFailHint: "Si un pintado falla, intenta calibrar zoom automáticamente"
  , resetCounters: "Reiniciar contador"
  , resetCountersHint: "Pone a cero píxeles pintados y reintentos"
  , refreshMe: "Refrescar /me ahora"
  , refreshMeHint: "Actualiza las cargas/cooldown de inmediato"
  , msgCountersReset: "Contadores reiniciados"
  , msgChargesRefreshed: "Cargas actualizadas"
  , msgCFTempBan: "Baneo temporal por Cloudflare. Intenta más tarde."
  , msgRefreshError: "No se pudo refrescar /me"
  , api: "API"
  , apiActive: "Activa"
  , apiPaused: (n) => `Pausada (${n} pinturas)`
  , msgMeBackoffStart: (n) => `/me en pausa (${n} pinturas)`
  , msgMeBackoffEnd: "/me reanudado"
  , healthCheck: "Verificar estado"
  , healthCheckHint: "Consultar estado del backend"
  , msgHealth: (up, db, uptime) => `Salud: up ${up} · DB ${db} · uptime ${uptime}`
  , msgHealthError: "Fallo al consultar health"
  , warnConfirmMin: "Se recomienda un mínimo de 10s para confirmar y evitar bloqueos"
      },
      pt: {
        title: "WPlace Auto-Farm",
        start: "Iniciar",
        stop: "Parar",
        ready: "Pronto para começar",
        user: "Usuário",
    pixels: "Pixels",
  charges: "Cargas",
  cooldown: "Espera",
  alliance: "Aliança",
  droplets: "Gotas",
  level: "Nível",
        minimize: "Minimizar",
        loading: "Carregando...",
        msgStart: "🚀 Pintura iniciada!",
        msgPaused: "⏸️ Pintura pausada",
        msgPaintOk: "✅ Pixel pintado!",
        msgPaintFail: "❌ Falha ao pintar",
  msgCFChallenge: "⚠️ Possível desafio de segurança. Feche o console se estiver aberto.",
  msgCFBackoff: (t) => `Aguardando ${t} antes de tentar novamente...`,
  msgCFValidated: "✅ Validação concluída. Retomando...",
  msgCFManual: "⚠️ Clique no desafio do Cloudflare e aguarde 5s. Depois, inicie novamente.",
  msgUIFallback: "🤖 Tentando clicar via UI para validar...",
  msgConfirmWait: (t) => `Espera ${t}`,
  msgWaitTarget: (p, t) => `Recarregando ${p} · ETA ${t}`,
  labelConfirmWait: "Confirmação",
  labelResumeThreshold: "Retomar com",
  labelSquaresPerAction: "Quadros por ação",
  labelMaxFails: "Tentativas",
  msgReloading: "⚠️ Muitos erros. Recarregando a página…",
  msgAutoResume: "⏩ Retomando após recarregar..."
  , msgZoomAdjust: "Ajustando zoom…"
  , settings: "Configurações"
  , zoomCalib: "Calibrar zoom"
  , zoomCalibHint: "Ajuste o zoom se não conseguir pintar"
  , autoZoomOnFail: "Auto-calibrar ao falhar"
  , autoZoomOnFailHint: "Se falhar, tente calibrar o zoom automaticamente"
  , resetCounters: "Reiniciar contador"
  , resetCountersHint: "Zera pixels pintados e tentativas"
  , refreshMe: "Atualizar /me agora"
  , refreshMeHint: "Atualiza cargas/espera imediatamente"
  , msgCountersReset: "Contadores reiniciados"
  , msgChargesRefreshed: "Cargas atualizadas"
  , msgCFTempBan: "Banimento temporário do Cloudflare. Tente mais tarde."
  , msgRefreshError: "Falha ao atualizar /me"
  , api: "API"
  , apiActive: "Ativa"
  , apiPaused: (n) => `Pausada (${n} beurten)`
  , msgMeBackoffStart: (n) => `/me em pausa (${n} beurten)`
  , msgMeBackoffEnd: "/me retomado"
  , healthCheck: "Verificar estado"
  , healthCheckHint: "Consultar estado do backend"
  , msgHealth: (up, db, uptime) => `Saúde: up ${up} · DB ${db} · uptime ${uptime}`
  , msgHealthError: "Falha ao verificar saúde"
  , warnConfirmMin: "Recomenda-se no mínimo 10s para confirmar e evitar bloqueios"
      },
      en: {
        title: "WPlace Auto-Farm",
        start: "Start",
        stop: "Stop",
        ready: "Ready to start",
        user: "User",
    pixels: "Pixels",
  charges: "Charges",
  cooldown: "Cooldown",
  alliance: "Alliance",
  droplets: "Droplets",
  level: "Level",
        minimize: "Minimize",
        loading: "Loading...",
        msgStart: "🚀 Painting started!",
        msgPaused: "⏸️ Painting paused",
        msgPaintOk: "✅ Pixel painted!",
        msgPaintFail: "❌ Failed to paint",
  msgCFChallenge: "⚠️ Possible security challenge. Close DevTools if open.",
  msgCFBackoff: (t) => `Waiting ${t} before retrying...`,
  msgCFValidated: "✅ Validation complete. Resuming...",
  msgCFManual: "⚠️ Click the Cloudflare challenge and wait 5s. Then press Start again.",
  msgUIFallback: "🤖 Trying UI click to validate...",
  msgConfirmWait: (t) => `Cooldown ${t}`,
  msgWaitTarget: (p, t) => `Recharging ${p} · ETA ${t}`,
  labelConfirmWait: "Confirm wait",
  labelResumeThreshold: "Resume at",
  labelSquaresPerAction: "Squares per action",
  labelMaxFails: "Max fails",
  msgReloading: "⚠️ Too many errors. Reloading page…",
  msgAutoResume: "⏩ Resuming after reload..."
  , msgZoomAdjust: "Adjusting zoom…"
  , settings: "Settings"
  , zoomCalib: "Calibrate zoom"
  , zoomCalibHint: "Calibrate zoom if you cannot paint"
  , autoZoomOnFail: "Auto-calibrate on fail"
  , autoZoomOnFailHint: "If a paint fails, try to calibrate zoom automatically"
  , resetCounters: "Reset counter"
  , resetCountersHint: "Zero painted pixels and retries"
  , refreshMe: "Refresh /me now"
  , refreshMeHint: "Update charges/cooldown immediately"
  , msgCountersReset: "Counters reset"
  , msgChargesRefreshed: "Charges refreshed"
  , msgCFTempBan: "Temporarily banned by Cloudflare. Try later."
  , msgRefreshError: "Failed to refresh /me"
  , api: "API"
  , apiActive: "Active"
  , apiPaused: (n) => `Paused (${n} paints)`
  , msgMeBackoffStart: (n) => `/me paused (${n} paints)`
  , msgMeBackoffEnd: "/me resumed"
  , healthCheck: "Check health"
  , healthCheckHint: "Fetch backend health"
  , msgHealth: (up, db, uptime) => `Health: up ${up} · DB ${db} · uptime ${uptime}`
  , msgHealthError: "Health check failed"
  , warnConfirmMin: "We recommend at least 10s to confirm to avoid blocks"
      },
      fr: {
        title: "WPlace Auto-Farm",
        start: "Démarrer",
        stop: "Arrêter",
        ready: "Prêt à démarrer",
        user: "Utilisateur",
    pixels: "Pixels",
  charges: "Charges",
  cooldown: "Attente",
  alliance: "Alliance",
  droplets: "Gouttes",
  level: "Niveau",
        minimize: "Minimiser",
        loading: "Chargement...",
        msgStart: "🚀 Peinture démarrée !",
        msgPaused: "⏸️ Peinture en pause",
        msgPaintOk: "✅ Pixel peint !",
        msgPaintFail: "❌ Échec de la peinture",
  msgCFChallenge: "⚠️ Défi de sécurité possible. Fermez DevTools si ouvert.",
  msgCFBackoff: (t) => `Attente ${t} avant réessai...`,
  msgCFValidated: "✅ Validation terminée. Reprise...",
  msgCFManual: "⚠️ Cliquez sur le défi Cloudflare et attendez 5s. Puis relancez.",
  msgUIFallback: "🤖 Tentative de clic via l'UI pour valider...",
  msgConfirmWait: (t) => `Attente ${t}`,
  msgWaitTarget: (p, t) => `Recharge ${p} · ETA ${t}`,
  labelConfirmWait: "Confirmation",
  labelResumeThreshold: "Reprendre à",
  labelSquaresPerAction: "Cases par action",
  labelMaxFails: "Essais",
  msgReloading: "⚠️ Trop d'erreurs. Rechargement de la page…",
  msgAutoResume: "⏩ Reprise après rechargement..."
  , msgZoomAdjust: "Ajustement du zoom…"
  , settings: "Paramètres"
  , zoomCalib: "Calibrer le zoom"
  , zoomCalibHint: "Ajustez le zoom si vous ne pouvez pas peindre"
  , autoZoomOnFail: "Auto-calibrer en cas d'échec"
  , autoZoomOnFailHint: "Si une peinture échoue, calibrer le zoom automatiquement"
  , resetCounters: "Réinitialiser le compteur"
  , resetCountersHint: "Remet à zéro pixels peints et essais"
  , refreshMe: "Actualiser /me maintenant"
  , refreshMeHint: "Met à jour charges/attente immédiatement"
  , msgCountersReset: "Compteurs réinitialisés"
  , msgChargesRefreshed: "Charges actualisées"
  , msgCFTempBan: "Bannissement temporaire par Cloudflare. Réessayez plus tard."
  , msgRefreshError: "Échec de l'actualisation /me"
  , api: "API"
  , apiActive: "Active"
  , apiPaused: (n) => `En pause (${n} peintures)`
  , msgMeBackoffStart: (n) => `/me en pause (${n} peintures)`
  , msgMeBackoffEnd: "/me repris"
  , healthCheck: "Vérifier l'état"
  , healthCheckHint: "Consulter l'état du backend"
  , msgHealth: (up, db, uptime) => `Santé: up ${up} · DB ${db} · uptime ${uptime}`
  , msgHealthError: "Échec de la vérification de santé"
  , warnConfirmMin: "Nous recommandons au moins 10s de confirmation pour éviter les blocages"
      },
      ru: {
        title: "WPlace Auto-Farm",
        start: "Старт",
        stop: "Стоп",
        ready: "Готов к запуску",
        user: "Пользователь",
    pixels: "Пиксели",
  charges: "Заряды",
  cooldown: "Ожидание",
  alliance: "Альянс",
  droplets: "Капли",
  level: "Уровень",
        minimize: "Свернуть",
        loading: "Загрузка...",
        msgStart: "🚀 Рисование начато!",
        msgPaused: "⏸️ Рисование на паузе",
        msgPaintOk: "✅ Пиксель нарисован!",
        msgPaintFail: "❌ Не удалось нарисовать",
  msgCFChallenge: "⚠️ Возможна проверка безопасности. Закройте DevTools, если открыты.",
  msgCFBackoff: (t) => `Ожидание ${t} перед повторной попыткой...`,
  msgCFValidated: "✅ Проверка завершена. Продолжаем...",
  msgCFManual: "⚠️ Нажмите на проверку Cloudflare и подождите 5с. Затем снова запустите.",
  msgUIFallback: "🤖 Пытаемся кликнуть через UI для подтверждения...",
  msgConfirmWait: (t) => `Ожидание ${t}`,
  msgWaitTarget: (p, t) => `Восстановление ${p} · ETA ${t}`,
  labelConfirmWait: "Подтверждение",
  labelResumeThreshold: "Возобновить при",
  labelSquaresPerAction: "Клеток за действие",
  labelMaxFails: "Попытки",
  msgReloading: "⚠️ Слишком много ошибок. Перезагружаем страницу…",
  msgAutoResume: "⏩ Продолжаем после перезагрузки..."
  , msgZoomAdjust: "Настройка масштаба…"
  , settings: "Настройки"
  , zoomCalib: "Калибровать зум"
  , zoomCalibHint: "Настройте зум, если не удаётся рисовать"
  , autoZoomOnFail: "Автокалибровка при ошибке"
  , autoZoomOnFailHint: "При неудаче попытаться откалибровать масштаб автоматически"
  , resetCounters: "Сбросить счётчик"
  , resetCountersHint: "Обнулить нарисованные пиксели и попытки"
  , refreshMe: "Обновить /me сейчас"
  , refreshMeHint: "Обновить заряды/ожидание немедленно"
  , msgCountersReset: "Счётчики сброшены"
  , msgChargesRefreshed: "Заряды обновлены"
  , msgCFTempBan: "Временная блокировка Cloudflare. Попробуйте позже."
  , msgRefreshError: "Не удалось обновить /me"
  , api: "API"
  , apiActive: "Активна"
  , apiPaused: (n) => `На паузе (${n} рисований)`
  , msgMeBackoffStart: (n) => `/me на паузе (${n} рисований)`
  , msgMeBackoffEnd: "/me возобновлен"
  , healthCheck: "Проверить статус"
  , healthCheckHint: "Проверить состояние бэкенда"
  , msgHealth: (up, db, uptime) => `Статус: up ${up} · DB ${db} · uptime ${uptime}`
  , msgHealthError: "Ошибка проверки статуса"
  , warnConfirmMin: "Рекомендуем минимум 10с подтверждения, чтобы избежать блокировок"
      },
      nl: {
        title: "WPlace Auto-Farm",
        start: "Start",
        stop: "Stop",
        ready: "Klaar om te starten",
        user: "Gebruiker",
    pixels: "Pixels",
  charges: "Ladingen",
  cooldown: "Wachttijd",
  alliance: "Alliantie",
  droplets: "Druppels",
  level: "Niveau",
        minimize: "Minimaliseren",
        loading: "Laden...",
        msgStart: "🚀 Schilderen gestart!",
        msgPaused: "⏸️ Schilderen gepauzeerd",
        msgPaintOk: "✅ Pixel geschilderd!",
        msgPaintFail: "❌ Schilderen mislukt",
  msgCFChallenge: "⚠️ Mogelijke beveiligingsuitdaging. Sluit DevTools indien open.",
  msgCFBackoff: (t) => `Wachten ${t} voordat opnieuw wordt geprobeerd...`,
  msgCFValidated: "✅ Validatie voltooid. Hervatten...",
  msgCFManual: "⚠️ Klik op de Cloudflare-uitdaging en wacht 5s. Start daarna opnieuw.",
  msgUIFallback: "🤖 Proberen UI-klik om te valideren...",
  msgConfirmWait: (t) => `Wachttijd ${t}`,
  msgWaitTarget: (p, t) => `Heropladen ${p} · ETA ${t}`,
  labelConfirmWait: "Bevestiging",
  labelResumeThreshold: "Hervatten bij",
  labelSquaresPerAction: "Vakken per actie",
  labelMaxFails: "Pogingen",
  msgReloading: "⚠️ Te veel fouten. Pagina wordt herladen…",
  msgAutoResume: "⏩ Hervatten na herladen..."
  , msgZoomAdjust: "Zoom aanpassen…"
  , settings: "Instellingen"
  , zoomCalib: "Zoom kalibreren"
  , zoomCalibHint: "Kalibreer zoom als je niet kunt schilderen"
  , autoZoomOnFail: "Auto-kalibreren bij mislukking"
  , autoZoomOnFailHint: "Kalibreer automatisch als schilderen faalt"
  , resetCounters: "Teller resetten"
  , resetCountersHint: "Zet geschilderde pixels en pogingen op nul"
  , refreshMe: "/me nu verversen"
  , refreshMeHint: "Update ladingen/wachttijd direct"
  , msgCountersReset: "Tellers gereset"
  , msgChargesRefreshed: "Ladingen ververst"
  , msgCFTempBan: "Tijdelijk geblokkeerd door Cloudflare. Probeer later opnieuw."
  , msgRefreshError: "/me verversen mislukt"
  , api: "API"
  , apiActive: "Actief"
  , apiPaused: (n) => `Gepauzeerd (${n} schilderbeurten)`
  , msgMeBackoffStart: (n) => `/me gepauzeerd (${n} beurten)`
  , msgMeBackoffEnd: "/me hervat"
  , healthCheck: "Controleer health"
  , healthCheckHint: "Haal backend health op"
  , msgHealth: (up, db, uptime) => `Health: up ${up} · DB ${db} · uptime ${uptime}`
  , msgHealthError: "Health-check mislukt"
  , warnConfirmMin: "We raden minstens 10s bevestiging aan om blokkades te voorkomen"
      },
      uk: {
        title: "WPlace Auto-Farm",
        start: "Почати",
        stop: "Зупинити",
        ready: "Готово до старту",
        user: "Користувач",
    pixels: "Пікселі",
  charges: "Заряди",
  cooldown: "Очікування",
  alliance: "Альянс",
  droplets: "Краплі",
  level: "Рівень",
        minimize: "Згорнути",
        loading: "Завантаження...",
        msgStart: "🚀 Малювання розпочато!",
        msgPaused: "⏸️ Малювання призупинено",
        msgPaintOk: "✅ Піксель намальовано!",
        msgPaintFail: "❌ Не вдалося намалювати",
  msgCFChallenge: "⚠️ Можлива перевірка безпеки. Закрийте DevTools, якщо відкриті.",
  msgCFBackoff: (t) => `Очікування ${t} перед повторною спробою...`,
  msgCFValidated: "✅ Перевірку завершено. Продовжуємо...",
  msgCFManual: "⚠️ Натисніть на перевірку Cloudflare і зачекайте 5с. Потім знову запустіть.",
  msgUIFallback: "🤖 Спроба кліку через UI для підтвердження...",
  msgConfirmWait: (t) => `Очікування ${t}`,
  msgWaitTarget: (p, t) => `Відновлення ${p} · ETA ${t}`,
  labelConfirmWait: "Підтвердження",
  labelResumeThreshold: "Відновити при",
  labelSquaresPerAction: "Клітинок за дію",
  labelMaxFails: "Спроби",
  msgReloading: "⚠️ Забагато помилок. Перезавантаження сторінки…",
  msgAutoResume: "⏩ Продовження після перезавантаження..."
  , msgZoomAdjust: "Налаштування масштабу…"
  , settings: "Налаштування"
  , zoomCalib: "Калібрувати масштаб"
  , zoomCalibHint: "Відкоригуйте масштаб, якщо не вдається малювати"
  , autoZoomOnFail: "Автокалібрування при помилці"
  , autoZoomOnFailHint: "Якщо малювання не вдалося, автоматично калібрувати масштаб"
  , resetCounters: "Скинути лічильник"
  , resetCountersHint: "Обнулити намальовані пікселі та спроби"
  , refreshMe: "Оновити /me зараз"
  , refreshMeHint: "Оновити заряди/очікування негайно"
  , msgCountersReset: "Лічильники скинуто"
  , msgChargesRefreshed: "Заряди оновлено"
  , msgCFTempBan: "Тимчасова заборона Cloudflare. Спробуйте пізніше."
  , msgRefreshError: "Не вдалося оновити /me"
  , api: "API"
  , apiActive: "Активна"
  , apiPaused: (n) => `Призупинено (${n} малювань)`
  , msgMeBackoffStart: (n) => `/me призупинено (${n} малювань)`
  , msgMeBackoffEnd: "/me відновлено"
  , healthCheck: "Перевірити стан"
  , healthCheckHint: "Отримати стан бекенду"
  , msgHealth: (up, db, uptime) => `Стан: up ${up} · DB ${db} · uptime ${uptime}`
  , msgHealthError: "Помилка перевірки стану"
  , warnConfirmMin: "Рекомендуємо щонайменше 10с підтвердження, щоб уникнути блокувань"
      }
    };
    return dict[state.language] || dict.en;
  }

  detectLanguage();
  loadSettings();
  createUI();
  updateStats();

  // Auto-resume tras recarga si fue solicitado (solo si la recarga fue reciente)
  try {
    const intent = readReloadIntent();
    if (intent?.autoStart) {
      const savedAt = parseInt(intent.savedAt || '0', 10);
      const within = Date.now() - savedAt;
      // Solo auto-iniciar si la recarga se solicitó hace ≤60s
      if (Number.isFinite(within) && within <= 60000) {
        clearReloadIntent();
        const t = getTranslations();
        updateUI(t.msgAutoResume, 'success');
        // Espera a que la UI esté lista y pulsa iniciar automáticamente
        const startDeadline = Date.now() + 15000; // hasta 15s
        const tryStart = () => {
          if (state.running) return; // ya arrancó
          const btn = document.querySelector('#toggleBtn');
          if (btn) {
            try { btn.click(); } catch {}
            return;
          }
          if (Date.now() < startDeadline) {
            setTimeout(tryStart, 300);
          }
        };
        setTimeout(tryStart, 700);
      } else {
        // Expirado: no auto-iniciar; limpiar intención
        clearReloadIntent();
      }
    }
  } catch {}
})();
