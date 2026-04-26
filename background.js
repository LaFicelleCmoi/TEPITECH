/* =========================================================
   Traducteur Universel — Background service worker (MV3)
   - Menus contextuels
   - TTS
   - API de traduction (Google gtx → Google dict → MyMemory)
   ========================================================= */

const DEFAULTS = {
  selection: true,
  qcm: false,
  langFrom: 'auto',
  langTo: 'fr',
};

/* ---------- Install ---------- */
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(null);
  const missing = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (stored[k] === undefined) missing[k] = DEFAULTS[k];
  }
  if (Object.keys(missing).length) await chrome.storage.sync.set(missing);

  // Date de première installation (stats profil)
  const local = await chrome.storage.local.get(['installedAt']);
  if (!local.installedAt) await chrome.storage.local.set({ installedAt: Date.now() });

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'tu-root',
      title: '🌐 Traducteur Universel',
      contexts: ['page', 'selection', 'editable'],
    });
    chrome.contextMenus.create({
      id: 'tu-translate-selection',
      parentId: 'tu-root',
      title: '🅰️ Traduire la sélection en Français',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'tu-translate-qcm',
      parentId: 'tu-root',
      title: '📝 Traduire tous les QCM de la page',
      contexts: ['page', 'editable'],
    });
    chrome.contextMenus.create({
      id: 'tu-translate-side',
      parentId: 'tu-root',
      title: '📑 Traduire dans le side panel',
      contexts: ['selection'],
    });
  });

  // Permet à un clic sur l'icône d'ouvrir le side panel sur l'onglet courant.
  // (default_popup reste prioritaire ; ce flag rend le panneau accessible
  // via le bouton "Side panels" de Chrome.)
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch {}
});

/* ---------- Context menu clicks ---------- */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  // Cas spécial : ouvrir le side panel et y déposer la sélection.
  // L'API sidePanel.open() exige un user-gesture, et le clic du menu
  // contextuel en est un — on doit donc l'appeler de façon synchrone.
  if (info.menuItemId === 'tu-translate-side') {
    const text = (info.selectionText || '').trim();
    // Stocker le texte AVANT d'ouvrir, au cas où le side panel se construise
    // après que le message runtime soit envoyé.
    try { await chrome.storage.session.set({ spPendingText: text }); } catch {}
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (err) {
      console.warn('TU: sidePanel.open failed', err);
    }
    // Broadcast aussi un runtime message pour le cas où le side panel était
    // déjà ouvert (et n'aura pas relu storage.session).
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'SIDEPANEL_TRANSLATE_SELECTION',
        text,
      }).catch(() => {});
    }, 250);
    return;
  }

  const map = {
    'tu-translate-selection': 'CTX_TRANSLATE_SELECTION',
    'tu-translate-qcm':       'CTX_TRANSLATE_QCM',
  };
  const type = map[info.menuItemId];
  if (!type) return;
  // (la suite injecte le content script et envoie le message)

  chrome.tabs.sendMessage(tab.id, { type, info }).catch(async () => {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
      await chrome.scripting.insertCSS   ({ target: { tabId: tab.id }, files: ['content/content.css'] });
      await chrome.tabs.sendMessage(tab.id, { type, info });
    } catch (err) {
      console.warn('TU: cannot inject content script', err);
    }
  });
});

/* ---------- Raccourcis clavier (chrome.commands) ----------
   Les commandes "_execute_action" (ouvrir popup) sont gérées par Chrome
   automatiquement. On gère ici nos commandes custom :
     - open-side-panel       (Ctrl+Shift+L)
     - translate-clipboard   (Ctrl+Shift+Y)
*/
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command, tab) => {
    try {
      if (command === 'open-side-panel') {
        const t = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        if (t?.windowId) await chrome.sidePanel.open({ windowId: t.windowId });
        return;
      }
      if (command === 'translate-clipboard') {
        // Le service worker n'a pas accès direct au clipboard ; on demande à
        // un script injecté dans l'onglet actif de lire navigator.clipboard,
        // puis on dépose le texte dans le side panel.
        const t = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        if (!t?.id) return;
        let text = '';
        try {
          const [r] = await chrome.scripting.executeScript({
            target: { tabId: t.id },
            func: async () => { try { return await navigator.clipboard.readText(); } catch { return ''; } },
          });
          text = (r?.result || '').trim();
        } catch {}
        if (!text) return;
        try { await chrome.storage.session.set({ spPendingText: text }); } catch {}
        try { await chrome.sidePanel.open({ tabId: t.id }); } catch {}
        setTimeout(() => {
          chrome.runtime.sendMessage({
            type: 'SIDEPANEL_TRANSLATE_SELECTION',
            text,
          }).catch(() => {});
        }, 250);
      }
    } catch (err) {
      console.warn('TU: command handler error', command, err);
    }
  });
}

/* =========================================================
   Moteurs de traduction
   ========================================================= */

function sameText(a, b) {
  return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
}

/* ---------- Cache LRU en mémoire (persistance soft via storage.local) ---------- */
const TRANS_CACHE = new Map();         // clé "from|to|text" → result
const CACHE_MAX = 1000;
const CACHE_PERSIST_KEY = 'tuTransCacheV1';
let cacheHydrated = false;

function cacheKey(text, from, to) {
  return (from || 'auto') + '|' + (to || 'fr') + '|' + (text || '').trim();
}

async function hydrateCache() {
  if (cacheHydrated) return;
  cacheHydrated = true;
  try {
    const s = await chrome.storage.local.get(CACHE_PERSIST_KEY);
    const arr = Array.isArray(s?.[CACHE_PERSIST_KEY]) ? s[CACHE_PERSIST_KEY] : [];
    for (const [k, v] of arr) TRANS_CACHE.set(k, v);
  } catch {}
}
let _persistTimer = null;
function persistCacheSoon() {
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(async () => {
    try {
      // Sauve les 500 plus récents seulement
      const entries = Array.from(TRANS_CACHE.entries()).slice(-500);
      await chrome.storage.local.set({ [CACHE_PERSIST_KEY]: entries });
    } catch {}
  }, 1500);
}

function cacheGet(text, from, to) {
  const k = cacheKey(text, from, to);
  if (!TRANS_CACHE.has(k)) return null;
  // LRU touch : re-insert pour passer en queue
  const v = TRANS_CACHE.get(k);
  TRANS_CACHE.delete(k);
  TRANS_CACHE.set(k, v);
  return v;
}
function cacheSet(text, from, to, value) {
  const k = cacheKey(text, from, to);
  TRANS_CACHE.set(k, value);
  if (TRANS_CACHE.size > CACHE_MAX) {
    // Supprime la plus ancienne entrée (premier élément du Map)
    const oldest = TRANS_CACHE.keys().next().value;
    if (oldest) TRANS_CACHE.delete(oldest);
  }
  persistCacheSoon();
}

/* 1) Google Translate — endpoint public "gtx".
   On demande aussi `dt=bd` (alternatives), `dt=rm` (transliteration / phonétique)
   pour enrichir le résultat sans coût supplémentaire. */
async function fetchGoogleGtx(text, from, to) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: from || 'auto',
    tl: to || 'fr',
    q: text,
  });
  // dt : t=traduction, bd=alternatives, rm=phonétique source/cible
  ['t', 'bd', 'rm'].forEach(d => params.append('dt', d));
  const url = 'https://translate.googleapis.com/translate_a/single?' + params.toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error('gtx HTTP ' + res.status);

  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error('gtx: JSON invalide'); }

  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('gtx: format inattendu');
  }
  const translated = data[0]
    .map(part => Array.isArray(part) ? (part[0] || '') : '')
    .filter(Boolean)
    .join('');
  if (!translated) throw new Error('gtx: réponse vide');

  const detected = (typeof data[2] === 'string' && data[2]) ? data[2] : (from === 'auto' ? '' : from);

  // Phonétique : data[0][N] peut contenir [null,null,"phonetic_target","phonetic_source"]
  let phoneticSrc = '', phoneticTgt = '';
  for (const part of data[0]) {
    if (Array.isArray(part)) {
      if (typeof part[3] === 'string' && part[3]) phoneticSrc = (phoneticSrc + ' ' + part[3]).trim();
      if (typeof part[2] === 'string' && part[2]) phoneticTgt = (phoneticTgt + ' ' + part[2]).trim();
    }
  }

  // Alternatives par classe grammaticale : data[1] = [[pos, [translations…], …], …]
  const alternatives = [];
  if (Array.isArray(data[1])) {
    for (const block of data[1]) {
      if (!Array.isArray(block)) continue;
      const pos = block[0] || '';
      const arr = Array.isArray(block[2]) ? block[2] : [];
      for (const item of arr) {
        if (Array.isArray(item) && typeof item[0] === 'string') {
          alternatives.push({
            word: item[0],
            pos,
            backTranslations: Array.isArray(item[1]) ? item[1].slice(0, 4) : [],
          });
        }
      }
    }
  }

  return {
    translated,
    detected,
    engine: 'google-gtx',
    phoneticSrc,
    phoneticTgt,
    alternatives: alternatives.slice(0, 8),
  };
}

/* 2) Google Translate — endpoint "dict-chrome-ex" (utilisé par Chrome) */
async function fetchGoogleDict(text, from, to) {
  const params = new URLSearchParams({
    client: 'dict-chrome-ex',
    sl: from || 'auto',
    tl: to || 'fr',
    q: text,
  });
  const url = 'https://clients5.google.com/translate_a/t?' + params.toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error('dict HTTP ' + res.status);
  const data = await res.json();

  let translated = '';
  let detected = (from === 'auto' ? '' : from);

  if (Array.isArray(data)) {
    if (Array.isArray(data[0])) {
      if (typeof data[0][0] === 'string') translated = data[0][0];
      else if (Array.isArray(data[0][0])) {
        translated = data[0].map(x => (Array.isArray(x) ? (x[0] || '') : '')).filter(Boolean).join('');
      }
    }
    if (Array.isArray(data[1])) detected = data[1][0] || detected;
    else if (typeof data[1] === 'string') detected = data[1];
  } else if (data && typeof data === 'object' && Array.isArray(data.sentences)) {
    translated = data.sentences.map(s => s.trans || '').join('');
    if (typeof data.src === 'string') detected = data.src;
  }

  if (!translated) throw new Error('dict: réponse vide');
  return { translated, detected, engine: 'google-dict' };
}

/* 3) MyMemory (fallback) */
async function fetchMyMemory(text, from, to) {
  const src = (from && from !== 'auto') ? from : 'en';
  const url = 'https://api.mymemory.translated.net/get?q=' +
              encodeURIComponent(text) + '&langpair=' + src + '|' + (to || 'fr');
  const res = await fetch(url);
  if (!res.ok) throw new Error('mm HTTP ' + res.status);
  const data = await res.json();
  const t = data?.responseData?.translatedText || '';
  if (!t) throw new Error('mm: réponse vide');
  if (sameText(t, text)) throw new Error('mm: aucune traduction trouvée');
  if (/^please\s+use|invalid|quota/i.test(t)) throw new Error('mm: quota/erreur');
  return { translated: t, detected: src, engine: 'mymemory' };
}

/* Orchestrateur */
async function translate(text, from, to) {
  const clean = (text || '').trim();
  if (!clean) return { translated: '', detected: from || '', engine: 'none' };

  await hydrateCache();
  const cached = cacheGet(clean, from, to);
  if (cached) return { ...cached, fromCache: true };

  const engines = [fetchGoogleGtx, fetchGoogleDict, fetchMyMemory];
  const errs = [];

  for (const fn of engines) {
    try {
      let r = await fn(clean, from, to);

      // Cas pathologique : détecté == cible ET sortie identique à l'entrée
      //   → Google a mal détecté la langue source. On force "en".
      if (from === 'auto'
          && r.detected && to && r.detected === to
          && sameText(r.translated, clean)) {
        try {
          const r2 = await fn(clean, 'en', to);
          if (r2.translated && !sameText(r2.translated, clean)) {
            r = { ...r2, detected: r2.detected || 'en' };
          }
        } catch (e) {
          errs.push(fn.name + ' retry en→' + to + ': ' + e.message);
        }
      }

      // Si le résultat est identique (casse ignorée), on tente le moteur suivant
      if (sameText(r.translated, clean)) {
        errs.push(fn.name + ': identique à l\u2019entrée');
        continue;
      }

      cacheSet(clean, from, to, r);
      return r;
    } catch (e) {
      errs.push(fn.name + ': ' + (e.message || e));
    }
  }
  throw new Error('Traduction indisponible — ' + errs.join(' | '));
}

/* =========================================================
   Traduction en lot (plusieurs textes d'un coup)
   - Google gtx accepte plusieurs &q=... mais la réponse combine
     les phrases. On utilise un séparateur unique inséré côté client
     pour rester robuste et minimiser les requêtes (×4 à ×8 plus rapide).
   ========================================================= */
const BATCH_SEP = '\n@@@TU_SEP@@@\n';

async function translateBatchJoined(texts, from, to) {
  const joined = texts.join(BATCH_SEP);
  // 1) essai gtx (meilleur rendu phrase par phrase)
  try {
    const r = await fetchGoogleGtx(joined, from, to);
    const parts = (r.translated || '').split(/\s*@@@TU_SEP@@@\s*/);
    if (parts.length === texts.length) {
      return { parts, detected: r.detected || '', engine: r.engine };
    }
  } catch {}
  // 2) fallback dict
  try {
    const r = await fetchGoogleDict(joined, from, to);
    const parts = (r.translated || '').split(/\s*@@@TU_SEP@@@\s*/);
    if (parts.length === texts.length) {
      return { parts, detected: r.detected || '', engine: r.engine };
    }
  } catch {}
  return null; // on retombera sur un fallback individuel côté caller
}

async function translateBatch(texts, from, to) {
  const clean = texts.map(t => (t || '').trim());
  const valid = clean.map((t, i) => ({ t, i })).filter(x => x.t);
  const results = new Array(clean.length).fill(null);

  if (!valid.length) return { results, detected: '' };

  // Découpe en paquets qui rentrent dans une URL (~2000 chars par batch)
  const MAX_BATCH_CHARS = 1800;
  const batches = [];
  let cur = [];
  let curLen = 0;
  for (const v of valid) {
    const add = v.t.length + BATCH_SEP.length;
    if (cur.length && curLen + add > MAX_BATCH_CHARS) {
      batches.push(cur); cur = []; curLen = 0;
    }
    cur.push(v);
    curLen += add;
  }
  if (cur.length) batches.push(cur);

  let detected = '';
  await Promise.all(batches.map(async (batch) => {
    const texts = batch.map(x => x.t);
    const b = await translateBatchJoined(texts, from, to);
    if (b && Array.isArray(b.parts) && b.parts.length === batch.length) {
      if (!detected) detected = b.detected || '';
      batch.forEach((x, k) => {
        const tr = (b.parts[k] || '').trim();
        if (tr && !sameText(tr, x.t)) {
          results[x.i] = { translated: tr, detected: b.detected || '', engine: b.engine };
        }
      });
    } else {
      // Fallback individuel (limité en parallèle)
      const concurrency = 4;
      let idx = 0;
      const workers = Array.from({ length: concurrency }, () => (async () => {
        while (idx < batch.length) {
          const my = batch[idx++];
          try {
            const r = await translate(my.t, from, to);
            if (r && r.translated && !sameText(r.translated, my.t)) {
              results[my.i] = r;
              if (!detected) detected = r.detected || '';
            }
          } catch {}
        }
      })());
      await Promise.all(workers);
    }
  }));

  return { results, detected };
}

/* =========================================================
   Messages
   ========================================================= */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'TRANSLATE') {
    translate(msg.text || '', msg.from || 'auto', msg.to || 'fr')
      .then(r => {
        console.log('[TU] translate', { in: msg.text, from: msg.from, to: msg.to, ...r });
        sendResponse({ ok: true, ...r });
      })
      .catch(err => {
        console.warn('[TU] translate failed', err);
        sendResponse({ ok: false, error: err.message || String(err) });
      });
    return true; // réponse asynchrone
  }

  if (msg.type === 'TRANSLATE_BATCH') {
    const arr = Array.isArray(msg.texts) ? msg.texts : [];
    translateBatch(arr, msg.from || 'auto', msg.to || 'fr')
      .then(r => sendResponse({ ok: true, results: r.results, detected: r.detected }))
      .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'TTS_SPEAK') {
    (async () => {
      try {
        const { ttsRate = 1.0 } = await chrome.storage.sync.get(['ttsRate']);
        const rate = Number.isFinite(+ttsRate) ? Math.min(2, Math.max(0.5, +ttsRate)) : 1.0;
        chrome.tts.stop();
        chrome.tts.speak(msg.text || '', { lang: msg.lang || 'fr-FR', rate });
      } catch (err) { console.warn('TU: tts error', err); }
    })();
    return;
  }

});
