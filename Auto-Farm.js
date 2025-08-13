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
  currentResumeTarget: null   // se fija cuando llegamos a 0, hasta alcanzar el objetivo
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

  // Hace clic exacto en el canvas en coordenadas de cliente
  const clickCanvasAt = (clientX, clientY) => {
    const canvas = getMainCanvas();
    if (!canvas) return false;
    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const type of events) {
      const evt = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: Math.floor(clientX),
        clientY: Math.floor(clientY),
        view: window
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
  const clickCanvasRandom = () => {
    const canvas = getMainCanvas();
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const rangeX = rect.width * 0.3;
    const rangeY = rect.height * 0.3;
    const cx = rect.left + rect.width / 2 + (Math.random() - 0.5) * rangeX;
    const cy = rect.top + rect.height / 2 + (Math.random() - 0.5) * rangeY;
    return clickCanvasAt(cx, cy);
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

  const uiPaintFallback = () => {
    if (!CONFIG.UI_MODE) return false;
    // Clic en punto no visitado
    let p = pickUnvisitedPoint();
    if (!p) p = (() => { const c = getMainCanvas(); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })();
    const ok = p ? clickCanvasAt(p.x, p.y) : clickCanvasRandom();
  // Importante: no enviar un segundo clic para evitar zoom por doble clic
    return ok;
  };

  // Una acción de pintura completa: abrir paleta -> elegir área -> color -> confirmar
  const doOneUIPaint = async () => {
    // Abrir paleta si está cerrada
    const opened = await ensurePaletteOpen();
    // Aunque no se abra, intentamos continuar: el flujo puede permitir pintar con color previo
    // Elegir un área aleatoria
    uiPaintFallback();
    await sleep(100 + Math.floor(Math.random() * 200));
    // Elegir color tras el área (la paleta se cierra tras pintar, así que el orden garantiza que esté visible)
    const id = chooseColor();
    selectColorInUI(id);
    await sleep(80 + Math.floor(Math.random() * 140));
    // Confirmar Paint
    const pb = readPaintButtonState();
    if (pb.btn) {
      clickElement(pb.btn);
      return true;
    }
    return false;
  };

  // Cloudflare challenge detection and auto-click handling
  const findChallengeElements = () => {
    const candidates = [];
    const isVisible = (el) => {
      try {
        const r = el.getBoundingClientRect();
        const st = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      } catch { return false; }
    };
    try {
      // 1) Iframes típicos de Turnstile/Cloudflare
      const iframes = Array.from(document.querySelectorAll('iframe'));
      for (const f of iframes) {
        const src = (f.getAttribute('src') || '').toLowerCase();
        const id = (f.id || '').toLowerCase();
        const title = (f.getAttribute('title') || '').toLowerCase();
        const cls = (f.className || '').toLowerCase();
        if (
          src.includes('challenges.cloudflare.com') ||
          id.startsWith('cf-chl-widget') ||
          title.includes('cloudflare') || title.includes('challenge') || title.includes('desaf') || title.includes('verif') || title.includes('humano') ||
          cls.includes('cf') || cls.includes('turnstile') || cls.includes('challenge')
        ) {
          candidates.push(f);
        }
      }
      // 2) Contenedores comunes
      const sel = [
        'div[id^="cf-chl-widget"]',
        '.cf-turnstile', '.cf-challenge', '.challenge-container',
        '[data-sitekey][data-cf]', '[data-sitekey][class*="turnstile"]'
      ].join(',');
      const others = Array.from(document.querySelectorAll(sel));
      for (const el of others) if (isVisible(el)) candidates.push(el);
    } catch {}
    // Quitar duplicados y priorizar más grandes (más clicables)
    const uniq = Array.from(new Set(candidates));
    return uniq
      .filter(isVisible)
      .sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return (rb.width * rb.height) - (ra.width * ra.height);
      });
  };

  const isChallengePresent = () => findChallengeElements().length > 0;

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

  const handleChallengeIfNeeded = async () => {
    if (!isChallengePresent()) return 'none';
    const t = getTranslations();
    updateUI(t.msgCFChallenge, 'warning');
    // Un único intento: elegir el widget visible más grande, hacer scroll y pulsar el centro
    const els = findChallengeElements();
    if (els.length > 0) {
      const el = els[0];
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
      await sleep(250);
      clickElementCenter(el);
    }
    // Espera fija de 5s tras pulsar (con cuenta atrás)
    for (let i = 5; i > 0; i--) {
      if (!isChallengePresent()) break;
      updateUI(t.msgCFBackoff(`${i}s`), 'default');
      await sleep(1000);
    }

    if (!isChallengePresent()) {
      updateUI(t.msgCFValidated, 'success');
      return 'solved';
    }
  // No se resolvió: detener y pedir intervención manual
    try {
      const tr = getTranslations();
      const toggleBtn = document.querySelector('#toggleBtn');
      state.running = false;
      if (toggleBtn) {
        toggleBtn.innerHTML = `<i class="fas fa-play"></i> <span>${tr.start}</span>`;
        toggleBtn.classList.add('wplace-btn-primary');
        toggleBtn.classList.remove('wplace-btn-stop');
      }
      updateUI(tr.msgCFManual, 'warning');
    } catch {}
    return 'manual';
  };

  // Espera en tiempo real hasta que haya cargas disponibles, actualizando el ETA
  const waitForChargesRealtime = async () => {
    const t = getTranslations();
    while (state.running) {
      const { charges, cooldownMs } = await WPlaceService.getCharges();
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
    let cachedCharges = { charges: 0, cooldownMs: 30000 };
    while (state.running) {
  // Chequeo temprano de reto Cloudflare
  const preStatus = await handleChallengeIfNeeded();
  if (preStatus === 'manual') break; // ya se detuvo y avisó
      // Asegurar colores de la UI antes de intentar pintar
      if (!state.availableColors || state.availableColors.length === 0) {
        state.availableColors = extractAvailableColors();
      }

      const now = Date.now();
      if (now - lastChargesCheck > 1500) {
        cachedCharges = await WPlaceService.getCharges();
        lastChargesCheck = now;
      }

      const t = getTranslations();
      let available = Math.floor(cachedCharges.charges || 0);

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
        // Mientras esperamos cargas, seguir vigilando reto CF
        const waitLoop = async () => {
          while (state.running) {
            const s = await handleChallengeIfNeeded();
            if (s === 'manual') return 'manual';
            const { charges } = await WPlaceService.getCharges();
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
        // No pan para evitar cambios de posición/zoom
        const beforeSnapshot = Math.floor(available);
        const committed = await doOneUIPaint();
        await sleep(120 + Math.floor(Math.random() * 220));
        const t = getTranslations();
        // Mostrar "píxel pintado" inmediatamente antes de iniciar la cuenta atrás
        updateUI(t.msgPaintOk, 'success');
        const effPre = document.getElementById('paintEffect');
        if (effPre) { effPre.style.animation = 'pulse 0.5s'; setTimeout(() => { try { effPre.style.animation = ''; } catch {} }, 500); }
        await sleep(800);
        // Espera con cuenta regresiva visible y consulta /me cada segundo para reflejar cargas actualizadas
        const confirmWaitSec = Number.isFinite(state.userConfirmWaitSec) && state.userConfirmWaitSec >= 0
          ? state.userConfirmWaitSec
          : CONFIG.CONFIRM_WAIT_SECONDS;
        const confirmWaitMs = confirmWaitSec * 1000;
        const startConfirm = Date.now();
        let observedAfter = beforeSnapshot;
        while (state.running && Date.now() - startConfirm < confirmWaitMs) {
          const left = Math.max(0, confirmWaitMs - (Date.now() - startConfirm));
          const secs = Math.ceil(left / 1000);
          updateUI(t.msgConfirmWait(`${secs}s`), 'default');
          // Consultar /me para mantener las cargas al día y detectar decremento
          try {
            const checkLoop = await WPlaceService.getCharges();
            const floorNow = Math.floor(checkLoop.charges || 0);
            observedAfter = floorNow;
            available = floorNow; // sincronizar la ráfaga con la realidad
            updateStats();
            if (floorNow < beforeSnapshot) break; // ya se consumió al menos 1 carga
          } catch {}
          await sleep(1000);
        }
        // Resultado final observado en el sondeo
        const afterFloor = observedAfter;
        if (committed && afterFloor < beforeSnapshot) {
          state.consecutiveFails = 0;
          state.paintedCount++;
          paintedThisBurst++;
          // Ya se mostró el mensaje de éxito previo; mantener continuidad
        } else {
          state.consecutiveFails = Math.min((state.consecutiveFails || 0) + 1, 5);
          updateUI(t.msgPaintFail, 'error');
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
            </div>
          </div>
          <div class="wplace-stat-item" style="gap:8px; align-items:center;">
            <div class="wplace-stat-label"><i class="fas fa-battery-three-quarters"></i> ${t.labelResumeThreshold}</div>
            <div>
              <input id="inpResumeThreshold" type="number" min="1" step="1" placeholder="auto" style="width:80px; padding:4px; border-radius:4px; border:1px solid ${CONFIG.THEME.accent}; background:${CONFIG.THEME.primary}; color:${CONFIG.THEME.text};">
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
    
    const stopBot = () => {
      const tr = getTranslations();
      state.running = false;
      toggleBtn.innerHTML = `<i class="fas fa-play"></i> <span>${tr.start}</span>`;
      toggleBtn.classList.add('wplace-btn-primary');
      toggleBtn.classList.remove('wplace-btn-stop');
    };

    toggleBtn.addEventListener('click', () => {
      if (!state.running) {
        state.running = true;
  toggleBtn.innerHTML = `<i class="fas fa-stop"></i> <span>${t.stop}</span>`;
        toggleBtn.classList.remove('wplace-btn-primary');
        toggleBtn.classList.add('wplace-btn-stop');
        updateUI(t.msgStart, 'success');
        paintLoop();
      } else {
        stopBot();
        updateUI(t.msgPaused, 'default');
      }
    });
    
    minimizeBtn.addEventListener('click', () => {
      state.minimized = !state.minimized;
      content.style.display = state.minimized ? 'none' : 'block';
      minimizeBtn.innerHTML = `<i class="fas fa-${state.minimized ? 'expand' : 'minus'}"></i>`;
    });

    // Handlers de ajustes
    inpConfirmWait?.addEventListener('change', () => {
      const v = parseInt(inpConfirmWait.value, 10);
      state.userConfirmWaitSec = Number.isFinite(v) && v >= 0 ? v : null;
    });
    inpResumeThreshold?.addEventListener('change', () => {
      const v = parseInt(inpResumeThreshold.value, 10);
      state.userResumeThreshold = Number.isFinite(v) && v > 0 ? v : null;
      // Reiniciar objetivo para aplicar en el próximo ciclo de 0
      state.currentResumeTarget = null;
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
      // Preferir datos de API para cargas/cooldown
      let chargesText = '-';
      let cooldownText = '-';
      try {
        const info = await WPlaceService.getCharges();
        chargesText = `${Math.floor(info.charges)}`;
        cooldownText = formatTimeShort(info.cooldownMs || 0);
      } catch {
        const pb = readPaintButtonState();
        chargesText = (pb.available != null && pb.max != null) ? `${pb.available}/${pb.max}` : '-';
        cooldownText = pb.cooldownMs > 0 ? formatTimeShort(pb.cooldownMs) : '0s';
      }

      statsArea.innerHTML = `
        <div class="wplace-stat-item">
          <div class="wplace-stat-label"><i class="fas fa-user"></i> ${tr.user}</div>
          <div>${state.userInfo?.name || '-'}</div>
        </div>
        <div class="wplace-stat-item">
          <div class="wplace-stat-label"><i class="fas fa-paint-brush"></i> ${tr.pixels}</div>
          <div>${state.paintedCount}</div>
        </div>
        <div class="wplace-stat-item">
          <div class="wplace-stat-label"><i class="fas fa-bolt"></i> ${tr.charges}</div>
          <div>${chargesText}</div>
        </div>
        <div class="wplace-stat-item">
          <div class="wplace-stat-label"><i class="fas fa-hourglass-half"></i> ${tr.cooldown}</div>
          <div>${cooldownText}</div>
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
  msgConfirmWait: (t) => `Confirmando pintura… ${t}`,
  msgWaitTarget: (p, t) => `Recargando ${p} · ETA ${t}`,
  labelConfirmWait: "Confirmación",
  labelResumeThreshold: "Reanudar con"
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
  msgConfirmWait: (t) => `Confirmando pintura… ${t}`,
  msgWaitTarget: (p, t) => `Recarregando ${p} · ETA ${t}`,
  labelConfirmWait: "Confirmação",
  labelResumeThreshold: "Retomar com"
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
  msgConfirmWait: (t) => `Confirming paint… ${t}`,
  msgWaitTarget: (p, t) => `Recharging ${p} · ETA ${t}`,
  labelConfirmWait: "Confirm wait",
  labelResumeThreshold: "Resume at"
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
  msgConfirmWait: (t) => `Confirmation de peinture… ${t}`,
  msgWaitTarget: (p, t) => `Recharge ${p} · ETA ${t}`,
  labelConfirmWait: "Confirmation",
  labelResumeThreshold: "Reprendre à"
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
  msgConfirmWait: (t) => `Подтверждение рисования… ${t}`,
  msgWaitTarget: (p, t) => `Восстановление ${p} · ETA ${t}`,
  labelConfirmWait: "Подтверждение",
  labelResumeThreshold: "Возобновить при"
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
  msgConfirmWait: (t) => `Schilderbevestiging… ${t}`,
  msgWaitTarget: (p, t) => `Heropladen ${p} · ETA ${t}`,
  labelConfirmWait: "Bevestiging",
  labelResumeThreshold: "Hervatten bij"
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
  msgConfirmWait: (t) => `Підтвердження малювання… ${t}`,
  msgWaitTarget: (p, t) => `Відновлення ${p} · ETA ${t}`,
  labelConfirmWait: "Підтвердження",
  labelResumeThreshold: "Відновити при"
      }
    };
    return dict[state.language] || dict.en;
  }

  detectLanguage();
  createUI();
  updateStats();
})();
