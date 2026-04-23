/* =========================================================
   Traducteur Universel — Background service worker (MV3)
   - Menus contextuels
   - TTS
   - API de traduction (Google gtx → Google dict → MyMemory)
   ========================================================= */

const DEFAULTS = {
  selection: true,
  qcm: false,
  audio: false,
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
      id: 'tu-start-audio',
      parentId: 'tu-root',
      title: '🎙️ Lancer l\u2019écoute audio sur cet onglet',
      contexts: ['page'],
    });
  });
});

/* ---------- Context menu clicks ---------- */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const map = {
    'tu-translate-selection': 'CTX_TRANSLATE_SELECTION',
    'tu-translate-qcm':       'CTX_TRANSLATE_QCM',
    'tu-start-audio':         'CTX_START_AUDIO',
  };
  const type = map[info.menuItemId];
  if (!type) return;

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

/* =========================================================
   Moteurs de traduction
   ========================================================= */

function sameText(a, b) {
  return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
}

/* 1) Google Translate — endpoint public "gtx" */
async function fetchGoogleGtx(text, from, to) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: from || 'auto',
    tl: to || 'fr',
    dt: 't',
    q: text,
  });
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
  return { translated, detected, engine: 'google-gtx' };
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
    try {
      chrome.tts.stop();
      chrome.tts.speak(msg.text || '', { lang: msg.lang || 'fr-FR', rate: 1.0 });
    } catch (err) { console.warn('TU: tts error', err); }
    return;
  }

  if (msg.type === 'GET_TAB_STREAM_ID') {
    const tabId = sender?.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: 'aucun onglet sender' }); return; }
    try {
      chrome.tabCapture.getMediaStreamId(
        { consumerTabId: tabId, targetTabId: tabId },
        (streamId) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else if (!streamId) {
            sendResponse({ ok: false, error: 'streamId vide' });
          } else {
            sendResponse({ ok: true, streamId });
          }
        }
      );
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
    return true; // async
  }
});
