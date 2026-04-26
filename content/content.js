/* =========================================================
   Traducteur Universel — Content Script
   - Info-bulle de traduction sur sélection (API réelle)
   - Traductions in-line des QCM (API réelle)
   - Widget audio "Live Subtitles" :
       (1) Capture des sous-titres HTML5 <track>
       (2) Capture YouTube .ytp-caption-segment
       (3) Fallback reconnaissance vocale (webkitSpeechRecognition)
   ========================================================= */

(() => {
  'use strict';

  if (window.__tuInjected) return;
  window.__tuInjected = true;

  const DEFAULTS = {
    selection: true,
    qcm: false,
    langFrom: 'auto',
    langTo: 'fr',
    hoverDelay: 450,
    ipa: true,
    alts: true,
    qcmHint:    true,  // suggérer la réponse probable (analyseur)
    qcmAudio:   true,  // bouton TTS sur phrase originale
  };
  const state = { ...DEFAULTS };

  // Compteur QCM traduits dans cette session (visible dans le toast + console)
  let qcmSessionCount = 0;

  const FLAG = {
    auto: '🌍', en: '🇺🇸', fr: '🇫🇷', es: '🇪🇸', de: '🇩🇪',
    it: '🇮🇹', pt: '🇵🇹', ja: '🇯🇵', zh: '🇨🇳', ru: '🇷🇺',
    ar: '🇸🇦', ko: '🇰🇷', nl: '🇳🇱', hi: '🇮🇳', tr: '🇹🇷',
  };
  const SPEECH_LANG = {
    en: 'en-US', fr: 'fr-FR', es: 'es-ES', de: 'de-DE', it: 'it-IT',
    ja: 'ja-JP', zh: 'zh-CN', ru: 'ru-RU', pt: 'pt-PT', ar: 'ar-SA',
    ko: 'ko-KR', nl: 'nl-NL', hi: 'hi-IN', tr: 'tr-TR',
  };

  /* ---------- Background API ---------- */
  function sendBG(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, (res) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          resolve(res);
        });
      } catch (err) { reject(err); }
    });
  }
  async function apiTranslate(text, from = 'auto', to = 'fr') {
    const res = await sendBG({ type: 'TRANSLATE', text, from, to });
    if (!res?.ok) throw new Error(res?.error || 'translation failed');
    return res;
  }
  function speak(text, lang) {
    try { chrome.runtime.sendMessage({ type: 'TTS_SPEAK', text, lang }); }
    catch {
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } catch {}
    }
  }

  /* ---------- Utils ---------- */
  const TU_ROOT_CLASS = 'tu-root';
  function el(tag, className, html) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function removeEl(e) { try { e?.remove(); } catch {} }

  function toast(msg, dur = 1800) {
    const t = el('div', `${TU_ROOT_CLASS} tu-toast tu-glass`);
    t.textContent = msg;
    document.documentElement.appendChild(t);
    requestAnimationFrame(() => t.classList.add('tu-show'));
    setTimeout(() => {
      t.classList.remove('tu-show');
      setTimeout(() => removeEl(t), 350);
    }, dur);
  }

  /* =========================================================
     1. TOOLTIP DE SÉLECTION
     ========================================================= */
  let tooltip = null;
  let tooltipSeq = 0;

  function ensureTooltip() {
    if (tooltip && document.documentElement.contains(tooltip)) return tooltip;
    tooltip = el('div', `${TU_ROOT_CLASS} tu-tooltip tu-glass`);
    tooltip.innerHTML = `
      <div class="tu-arrow"></div>
      <div class="tu-row">
        <span class="tu-flag tu-flag-from">🌍</span>
        <span class="tu-word"></span>
        <span class="tu-ipa" hidden></span>
        <span class="tu-pos"></span>
      </div>
      <div class="tu-row tu-translated">
        <span class="tu-flag tu-flag-to">🇫🇷</span>
        <span class="tu-fr"></span>
      </div>
      <div class="tu-alts" hidden></div>
      <div class="tu-actions">
        <button class="tu-mini-btn tu-speak"      title="Écouter (langue source)">🔊</button>
        <button class="tu-mini-btn tu-speak-tgt"  title="Écouter la traduction">🇫🇷🔊</button>
        <button class="tu-mini-btn tu-copy"       title="Copier la traduction">📋</button>
        <button class="tu-mini-btn tu-fav"        title="Ajouter aux favoris">☆</button>
        <button class="tu-mini-btn tu-wide tu-more" title="Définition en ligne">📖</button>
      </div>
    `;
    document.documentElement.appendChild(tooltip);

    tooltip.querySelector('.tu-speak').addEventListener('click', (e) => {
      e.stopPropagation();
      const w = tooltip.querySelector('.tu-word').textContent;
      const code = tooltip.dataset.detected || 'en';
      speak(w, SPEECH_LANG[code] || 'en-US');
    });
    tooltip.querySelector('.tu-speak-tgt').addEventListener('click', (e) => {
      e.stopPropagation();
      const w = tooltip.querySelector('.tu-fr').textContent;
      const code = state.langTo || 'fr';
      if (w && w !== '…' && !w.startsWith('⚠️')) {
        speak(w, SPEECH_LANG[code] || 'fr-FR');
      }
    });
    tooltip.querySelector('.tu-copy').addEventListener('click', async (e) => {
      e.stopPropagation();
      const fr = tooltip.querySelector('.tu-fr').textContent;
      try { await navigator.clipboard.writeText(fr); toast('Copié'); } catch {}
    });
    tooltip.querySelector('.tu-fav').addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = tooltip.querySelector('.tu-word').textContent;
      const translated = tooltip.querySelector('.tu-fr').textContent;
      const from = tooltip.dataset.detected || (state.langFrom || 'auto');
      const to = state.langTo || 'fr';
      if (!text || !translated || translated === '…' || translated.startsWith('⚠️')) return;
      try {
        const local = await chrome.storage.local.get(['favorites']);
        const favs = Array.isArray(local.favorites) ? local.favorites : [];
        const exists = favs.findIndex(f => f.text === text && f.to === to);
        const btn = tooltip.querySelector('.tu-fav');
        if (exists >= 0) {
          favs.splice(exists, 1);
          btn.textContent = '☆';
          btn.classList.remove('is-active');
          toast('Retiré des favoris');
        } else {
          favs.unshift({ text, translated, from, to, favoritedAt: Date.now() });
          btn.textContent = '★';
          btn.classList.add('is-active');
          toast('Ajouté aux favoris');
        }
        await chrome.storage.local.set({ favorites: favs.slice(0, 200) });
      } catch {}
    });
    tooltip.querySelector('.tu-more').addEventListener('click', (e) => {
      e.stopPropagation();
      const w = tooltip.querySelector('.tu-word').textContent;
      window.open('https://www.google.com/search?q=' + encodeURIComponent('définition ' + w), '_blank', 'noopener');
    });

    // Délégation : clic sur une alternative → la copier
    tooltip.querySelector('.tu-alts').addEventListener('click', async (e) => {
      const chip = e.target.closest('.tu-alt-chip');
      if (!chip) return;
      e.stopPropagation();
      const w = chip.dataset.word || chip.textContent.trim();
      try { await navigator.clipboard.writeText(w); toast('« ' + w + ' » copié'); } catch {}
    });
    return tooltip;
  }

  // Indique si un mot/phrase est déjà dans les favoris pour mettre à jour l'icône ☆/★
  async function isFavorite(text, to) {
    try {
      const local = await chrome.storage.local.get(['favorites']);
      const favs = Array.isArray(local.favorites) ? local.favorites : [];
      return favs.some(f => f.text === text && f.to === to);
    } catch { return false; }
  }

  function positionTooltip(t, rect) {
    const pageX = window.scrollX, pageY = window.scrollY;
    const tipW = t.offsetWidth || 280;
    const x = Math.max(8, Math.min(pageX + rect.left, pageX + window.innerWidth - tipW - 8));
    t.style.left = x + 'px';
    const tipH = t.offsetHeight || 120;
    let y = pageY + rect.top - tipH - 10;
    if (y < pageY + 8) y = pageY + rect.bottom + 10;
    t.style.top = y + 'px';
  }

  async function showTooltipForText(text, rect) {
    if (!text || text.length > 500 || !rect) return;
    if (rect.width === 0 && rect.height === 0) return;

    const t = ensureTooltip();
    const seq = ++tooltipSeq;

    t.querySelector('.tu-word').textContent = text;
    t.querySelector('.tu-pos').textContent  = '';
    t.querySelector('.tu-fr').textContent   = '…';
    t.querySelector('.tu-flag-from').textContent = FLAG[state.langFrom] || '🌍';
    t.querySelector('.tu-flag-to').textContent   = FLAG[state.langTo]   || '🇫🇷';
    // Reset des champs enrichis
    const ipaEl  = t.querySelector('.tu-ipa');
    const altsEl = t.querySelector('.tu-alts');
    const favBtn = t.querySelector('.tu-fav');
    ipaEl.hidden = true; ipaEl.textContent = '';
    altsEl.hidden = true; altsEl.innerHTML = '';
    favBtn.textContent = '☆'; favBtn.classList.remove('is-active');

    t.style.visibility = 'hidden';
    t.classList.add('tu-show');
    requestAnimationFrame(() => {
      positionTooltip(t, rect);
      t.style.visibility = 'visible';
    });

    try {
      const r = await apiTranslate(text, state.langFrom || 'auto', state.langTo || 'fr');
      if (seq !== tooltipSeq) return;
      const { translated, detected, phoneticSrc, alternatives, fromCache, engine } = r;

      t.querySelector('.tu-fr').textContent = translated || '—';
      if (detected && FLAG[detected]) t.querySelector('.tu-flag-from').textContent = FLAG[detected];
      t.dataset.detected = detected || '';

      // IPA / phonétique source si disponible (et activé en réglages)
      if (state.ipa !== false && phoneticSrc && phoneticSrc.length < 60) {
        ipaEl.textContent = '/' + phoneticSrc + '/';
        ipaEl.hidden = false;
      }

      // Alternatives (si Google a renvoyé des synonymes par classe grammaticale)
      if (state.alts !== false && Array.isArray(alternatives) && alternatives.length > 0) {
        // Limite à 5 chips, dédupliqué, filtre la traduction principale
        const seen = new Set([(translated || '').toLowerCase()]);
        const chips = [];
        for (const a of alternatives) {
          const w = (a.word || '').trim();
          if (!w || seen.has(w.toLowerCase())) continue;
          seen.add(w.toLowerCase());
          chips.push(`<button class="tu-alt-chip" data-word="${w.replace(/"/g, '&quot;')}" title="${a.pos || ''} — clic pour copier">${w}</button>`);
          if (chips.length >= 5) break;
        }
        if (chips.length) {
          altsEl.innerHTML = chips.join('');
          altsEl.hidden = false;
        }
      }

      // Indicateur si la réponse vient du cache (petit point dans le pos)
      if (fromCache) {
        t.querySelector('.tu-pos').textContent = '⚡';
        t.querySelector('.tu-pos').title = 'Réponse instantanée (cache)';
      } else if (engine && engine !== 'google-gtx') {
        t.querySelector('.tu-pos').textContent = '·' + engine.replace('google-', '');
      }

      // État du bouton favori
      const fav = await isFavorite(text, state.langTo || 'fr');
      if (fav) { favBtn.textContent = '★'; favBtn.classList.add('is-active'); }

      requestAnimationFrame(() => positionTooltip(t, rect));
    } catch (err) {
      if (seq !== tooltipSeq) return;
      t.querySelector('.tu-fr').textContent = '⚠️ traduction indisponible';
    }
  }

  function showTooltipForSelection() {
    if (!state.selection) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    showTooltipForText(text, rect);
  }

  /* -------- Traduction au survol (hover) -------- */
  const WORD_RE = /[\p{L}\p{N}_'’-]/u;

  function wordAtPoint(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p?.offsetNode) {
        try {
          range = document.createRange();
          range.setStart(p.offsetNode, p.offset);
          range.collapse(true);
        } catch { range = null; }
      }
    }
    if (!range) return null;
    const node = range.startContainer;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    // Ne pas déclencher dans les champs de saisie / notre propre UI
    let anc = node.parentElement;
    while (anc) {
      if (anc.closest && anc.closest('.tu-root, input, textarea, select, button, code, pre')) return null;
      anc = anc.parentElement;
    }
    const text = node.textContent || '';
    const offset = range.startOffset;
    let s = offset, e = offset;
    while (s > 0 && WORD_RE.test(text[s - 1])) s--;
    while (e < text.length && WORD_RE.test(text[e])) e++;
    const word = text.slice(s, e).trim();
    if (!word || word.length < 2) return null;

    const r = document.createRange();
    try { r.setStart(node, s); r.setEnd(node, e); }
    catch { return null; }
    const rect = r.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return { text: word, rect };
  }

  let hoverTimer = null;
  let hoverLastWord = '';

  function scheduleHover(e) {
    if (!state.selection) return;
    // Ne pas écraser une sélection active
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    // Ne pas déclencher si on survole la tooltip
    if (e.target && e.target.closest && e.target.closest('.tu-tooltip')) return;

    clearTimeout(hoverTimer);
    const cx = e.clientX, cy = e.clientY;
    const delay = Math.max(80, Math.min(2000, Number(state.hoverDelay) || 450));
    hoverTimer = setTimeout(() => {
      const w = wordAtPoint(cx, cy);
      if (!w) { hoverLastWord = ''; hideTooltip(); return; }
      if (w.text === hoverLastWord && tooltip?.classList.contains('tu-show')) return;
      hoverLastWord = w.text;
      showTooltipForText(w.text, w.rect);
    }, delay);
  }

  function hideTooltip() { if (tooltip) tooltip.classList.remove('tu-show'); hoverLastWord = ''; }

  /* -------- Events -------- */
  document.addEventListener('mouseup',   () => setTimeout(showTooltipForSelection, 60));
  document.addEventListener('mousemove', scheduleHover, { passive: true });
  document.addEventListener('mousedown', (e) => {
    if (tooltip && !tooltip.contains(e.target)) hideTooltip();
  });
  document.addEventListener('mouseleave', () => { clearTimeout(hoverTimer); });
  document.addEventListener('scroll', hideTooltip, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideTooltip();
    // Raccourci 1-9 : bascule la sélection du <select> focus actuellement
    // (utile pour parcourir rapidement les options d'un fill-blank traduit).
    // Désactivé si on tape dans un champ texte.
    const target = e.target;
    if (e.altKey && /^[1-9]$/.test(e.key) && target?.tagName === 'SELECT') {
      const idx = parseInt(e.key, 10) - 1;
      if (idx < target.options.length) {
        e.preventDefault();
        target.selectedIndex = idx;
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });

  /* =========================================================
     2. QCM INLINE TRANSLATIONS
     - Détection multi-stratégies (inputs, ARIA, listes, tableaux, dl, frameworks)
     - Détection de la question associée
     - Cache mémoire + cache persistant (chrome.storage.local, TTL 24 h)
     - Traduction en lot (1 requête → N textes)
     - Auto-mode (observer des changements DOM)
     ========================================================= */
  const TRAD_CLASS   = 'tu-trad-inline';
  const TRAD_Q_CLASS = 'tu-trad-question';
  const QCM_CACHE = new Map();          // mémoire (clé → {translated, detected})
  const QCM_MISS  = new Set();          // textes déjà essayés sans résultat
  const PERSIST_KEY = 'tuQcmCache';     // chrome.storage.local
  const PERSIST_TTL = 24 * 3600 * 1000; // 24 h
  let persistLoaded = false;
  let persistPending = null;
  let persistSaveTimer = null;

  function cacheKey(text, from, to) {
    return (from || 'auto') + '|' + (to || 'fr') + '|' + text.trim();
  }

  async function loadPersistentCache() {
    if (persistLoaded) return;
    persistLoaded = true;
    try {
      const stored = await new Promise(res => chrome.storage.local.get([PERSIST_KEY], res));
      const data = stored?.[PERSIST_KEY] || {};
      const now = Date.now();
      for (const [k, v] of Object.entries(data)) {
        if (!v || !v.t || (v.at && now - v.at > PERSIST_TTL)) continue;
        QCM_CACHE.set(k, { translated: v.t, detected: v.d || '', engine: v.e || 'cache' });
      }
    } catch {}
  }

  function schedulePersistSave(key, val) {
    if (!persistPending) persistPending = {};
    persistPending[key] = { t: val.translated, d: val.detected || '', e: val.engine || '', at: Date.now() };
    clearTimeout(persistSaveTimer);
    persistSaveTimer = setTimeout(async () => {
      const toWrite = persistPending;
      persistPending = null;
      try {
        const stored = await new Promise(res => chrome.storage.local.get([PERSIST_KEY], res));
        const data = stored?.[PERSIST_KEY] || {};
        Object.assign(data, toWrite);
        // Garde-fou : taille raisonnable (~2000 entrées)
        const entries = Object.entries(data);
        if (entries.length > 2200) {
          entries.sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
          const trimmed = Object.fromEntries(entries.slice(0, 2000));
          await new Promise(res => chrome.storage.local.set({ [PERSIST_KEY]: trimmed }, res));
        } else {
          await new Promise(res => chrome.storage.local.set({ [PERSIST_KEY]: data }, res));
        }
      } catch {}
    }, 600);
  }

  async function cachedTranslate(text, from, to) {
    const key = cacheKey(text, from, to);
    if (QCM_CACHE.has(key)) return QCM_CACHE.get(key);
    if (QCM_MISS.has(key))  return null;
    try {
      const r = await apiTranslate(text, from, to);
      if (r && r.translated) {
        QCM_CACHE.set(key, r);
        schedulePersistSave(key, r);
      } else {
        QCM_MISS.add(key);
      }
      return r;
    } catch { QCM_MISS.add(key); return null; }
  }

  /* --- Traduction en lot : gros gain sur les QCM (1 requête = N textes) --- */
  async function batchTranslateTexts(texts, from, to) {
    // Applique le cache d'abord
    const results = new Array(texts.length).fill(null);
    const pending = [];
    const pendingIdx = [];
    texts.forEach((t, i) => {
      const k = cacheKey(t, from, to);
      if (QCM_CACHE.has(k)) { results[i] = QCM_CACHE.get(k); return; }
      if (QCM_MISS.has(k))  { return; }
      pending.push(t);
      pendingIdx.push(i);
    });
    if (!pending.length) return { results, detected: '' };

    let detected = '';
    try {
      const res = await sendBG({ type: 'TRANSLATE_BATCH', texts: pending, from, to });
      if (res?.ok && Array.isArray(res.results)) {
        detected = res.detected || '';
        res.results.forEach((r, k) => {
          const text = pending[k];
          const idx  = pendingIdx[k];
          const key  = cacheKey(text, from, to);
          if (r && r.translated) {
            results[idx] = r;
            QCM_CACHE.set(key, r);
            schedulePersistSave(key, r);
          } else {
            QCM_MISS.add(key);
          }
        });
      }
    } catch {}
    return { results, detected };
  }

  function sameText(a, b) {
    return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
  }

  function getCleanText(node) {
    if (!node) return '';
    const clone = node.cloneNode(true);
    clone.querySelectorAll('.' + TRAD_CLASS + ', .' + TRAD_Q_CLASS).forEach(n => n.remove());
    clone.querySelectorAll('input, select, textarea, button, script, style').forEach(n => n.remove());
    return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function nearestCommonAncestor(nodes) {
    if (!nodes.length) return null;
    if (nodes.length === 1) return nodes[0].parentElement;
    const chain = [];
    for (let el = nodes[0]; el; el = el.parentElement) chain.push(el);
    let idx = 0;
    for (let i = 1; i < nodes.length; i++) {
      let cur = nodes[i], found = -1;
      while (cur) {
        const k = chain.indexOf(cur);
        if (k >= 0) { found = k; break; }
        cur = cur.parentElement;
      }
      if (found < 0) return null;
      if (found > idx) idx = found;
    }
    return chain[idx] || null;
  }

  function findQuestionFor(container) {
    if (!container) return null;
    // 1) <legend> direct (fieldset)
    const legend = container.querySelector(':scope > legend');
    if (legend) return legend;
    // 1b) ARIA labelled-by ou aria-label sur le container
    const labelledBy = container.getAttribute && container.getAttribute('aria-labelledby');
    if (labelledBy) {
      const lbl = document.getElementById(labelledBy);
      if (lbl) return lbl;
    }

    // 2) Frères précédents (headings, .question, légende implicite)
    //    Élargi à 8 frères et plus de classes communes
    let sib = container.previousElementSibling;
    for (let i = 0; sib && i < 8; i++, sib = sib.previousElementSibling) {
      const tag = sib.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag))                     return sib;
      if (sib.matches('legend, [role="heading"], [aria-label]')) return sib;
      if (sib.matches('.question, .quiz-question, .qcm-question, .survey-question, .prompt, .stem, .question-stem, .question-text, [data-question]')) return sib;
      const text = (sib.innerText || sib.textContent || '').trim();
      if (text && text.length < 500 && (tag === 'p' || tag === 'div' || tag === 'span' || tag === 'label')) {
        // Question avec ?, : ou ; final, OU numérotation Q1/Question N, OU mots-clés QCM
        if (/[?:;]\s*$/.test(text)
            || /^(question\s*\d*|q\d+|qcm|exercice|exo)/i.test(text)
            || /(choose|select|pick|which|what|where|when|why|how|qui|que|quoi|combien|où|quand|pourquoi|comment|laquelle|lesquels)\b/i.test(text.slice(0, 80))) {
          return sib;
        }
      }
    }

    // 3) Remonter : chercher un heading précédent un ancêtre du container
    let node = container;
    for (let depth = 0; node && node.parentElement && depth < 3; depth++) {
      node = node.parentElement;
      let s = node.previousElementSibling;
      for (let i = 0; s && i < 4; i++, s = s.previousElementSibling) {
        const tag = s.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) return s;
        if (s.matches('legend, .question, .quiz-question, .qcm-question, [role="heading"]')) return s;
      }
    }
    return null;
  }

  function findOptionGroups() {
    const groups = [];
    const seen = new WeakSet();

    /* --- Stratégie 1 : inputs radio/checkbox groupés par name --- */
    const inputs = document.querySelectorAll('input[type=radio], input[type=checkbox]');
    const byName = new Map();
    inputs.forEach(input => {
      const name = input.name || ('__id_' + (input.id || Math.random().toString(36).slice(2)));
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(input);
    });
    byName.forEach(list => {
      if (!list.length) return;
      // Récupère le label associé à chaque input
      const items = [];
      list.forEach(input => {
        let lab = null;
        if (input.id) { try { lab = document.querySelector('label[for="' + CSS.escape(input.id) + '"]'); } catch {} }
        if (!lab) lab = input.closest('label');
        if (!lab) lab = input.parentElement;
        if (lab && !seen.has(lab)) { seen.add(lab); items.push(lab); }
      });
      if (items.length < 1) return;
      const container = nearestCommonAncestor(items) || items[0].parentElement;
      groups.push({ container, options: items, kind: 'input' });
    });

    /* --- Stratégie 2 : ARIA (radiogroup, listbox) --- */
    document.querySelectorAll('[role="radiogroup"], [role="listbox"]').forEach(group => {
      const opts = Array.from(group.querySelectorAll('[role="radio"], [role="option"], [role="checkbox"]'))
                        .filter(n => !seen.has(n));
      if (opts.length < 2) return;
      opts.forEach(n => seen.add(n));
      groups.push({ container: group, options: opts, kind: 'aria' });
    });

    /* --- Stratégie 3 : listes (ul/ol) d'items courts suivant une question --- */
    document.querySelectorAll('ul, ol').forEach(list => {
      if (seen.has(list)) return;
      const items = Array.from(list.querySelectorAll(':scope > li')).filter(n => !seen.has(n));
      if (items.length < 2 || items.length > 12) return;
      let total = 0;
      items.forEach(li => total += (li.textContent || '').length);
      const avg = total / items.length;
      if (avg > 140) return;
      // Besoin d'une question en préalable
      const q = findQuestionFor(list);
      if (!q) return;
      // Ne pas prendre des listes d'articles / navigation
      if (list.closest('nav, header, footer, aside')) return;
      items.forEach(n => seen.add(n));
      seen.add(list);
      groups.push({ container: list, options: items, kind: 'list' });
    });

    /* --- Stratégie 4 : <dl><dt><dd> --- */
    document.querySelectorAll('dl').forEach(dl => {
      if (seen.has(dl)) return;
      const dds = Array.from(dl.querySelectorAll(':scope > dd')).filter(n => !seen.has(n));
      if (dds.length < 2 || dds.length > 12) return;
      let total = 0;
      dds.forEach(dd => total += (dd.textContent || '').length);
      if (total / dds.length > 160) return;
      if (dl.closest('nav, header, footer, aside')) return;
      dds.forEach(n => seen.add(n));
      seen.add(dl);
      groups.push({ container: dl, options: dds, kind: 'dl' });
    });

    /* --- Stratégie 5 : classes usuelles des frameworks de quiz --- */
    const QCM_SELECTORS = [
      // Frameworks classiques
      '.answers .answer', '.quiz-answers .quiz-answer',
      '.qcm-option', '.qcm__option', '.question-choices .choice',
      '.choices .choice', '.options .option', '.answer-option',
      // Data attributes
      '[data-qcm-option]', '[data-answer]', '[data-choice]',
      '[data-option]', '[data-test-id*="option"]',
      // Sites de tests d'anglais français : Tepitech, anglaisfacile, etc.
      '.tepitech-option', '.tep-option', '.exo-option', '.exercice-option',
      '.reponse', '.reponse-item', '.proposition',
      // ProjetVoltaire / OrthographeFR
      '.pv-answer', '.voltaire-choice',
      // Plateformes Moodle / Sakai
      '.qtype_multichoice .answer', '.que .answer',
      // Genially / Wooclap / Kahoot embeds
      '.genially-answer', '.wooclap-choice', '.kahoot-answer',
      // Boutons générique avec rôle "answer"
      'button[role="option"]', '[role="answer"]',
    ].join(',');
    const candidateGroups = new Map();
    document.querySelectorAll(QCM_SELECTORS).forEach(n => {
      if (seen.has(n)) return;
      const p = n.parentElement;
      if (!p) return;
      if (!candidateGroups.has(p)) candidateGroups.set(p, []);
      candidateGroups.get(p).push(n);
    });
    candidateGroups.forEach((options, parent) => {
      if (options.length < 2) return;
      if (parent.closest('nav, header, footer, aside')) return;
      options.forEach(n => seen.add(n));
      groups.push({ container: parent, options, kind: 'framework' });
    });

    /* --- Stratégie 6 : tableaux de réponses (<tr> avec input + libellé) --- */
    document.querySelectorAll('table').forEach(table => {
      if (seen.has(table)) return;
      const rows = Array.from(table.querySelectorAll('tbody > tr, tr')).filter(tr => {
        if (seen.has(tr)) return false;
        return !!tr.querySelector('input[type=radio], input[type=checkbox]');
      });
      if (rows.length < 2 || rows.length > 12) return;
      // Le libellé est la cellule sans input
      const items = rows.map(tr => {
        const cells = Array.from(tr.children);
        const label = cells.find(c => !c.querySelector('input'));
        return label || tr;
      });
      items.forEach(n => seen.add(n));
      seen.add(table);
      groups.push({ container: table, options: items, kind: 'table' });
    });

    return groups;
  }

  /* --- Stratégie dédiée : <select> fill-in-the-blank (anglaisfacile, QCM type trou) --- */
  function findFillBlankSelects() {
    const out = [];
    document.querySelectorAll('select').forEach(select => {
      if (select.dataset.tuTranslated === '1') return;
      const opts = Array.from(select.options || []).map(o => (o.text || '').trim()).filter(Boolean);
      if (opts.length < 2) return;
      if (select.closest('nav, header, footer, aside, [role="toolbar"]')) return;
      // Évite les gros selects (pays, devises, …) — généralement pas une question
      if (opts.length > 40) return;

      const sent = sentenceAroundSelect(select);
      if (!sent || !sent.text || sent.text.length < 5 || sent.text.length > 500) return;

      out.push({
        select,
        text: sent.text,
        afterNode: sent.endNode,
        buildWith: sent.buildWith,
        rawSentence: sent.raw,  // phrase EN avec __TUBLANK__ pour reconstruction
      });
    });
    return out;
  }

  function sentenceAroundSelect(select) {
    // Remonte parmi les frères jusqu'à un <BR>, un élément bloc, ou début de parent
    const BLOCK = /^(BR|DIV|P|LI|TR|TD|SECTION|ARTICLE|H[1-6]|FORM|FIELDSET)$/i;
    const parent = select.parentElement;
    if (!parent) return null;

    let startNode = select;
    let cur = select.previousSibling;
    while (cur) {
      if (cur.nodeType === 1 && BLOCK.test(cur.tagName)) break;
      startNode = cur;
      cur = cur.previousSibling;
    }
    let endNode = select;
    cur = select.nextSibling;
    while (cur) {
      if (cur.nodeType === 1 && BLOCK.test(cur.tagName)) break;
      endNode = cur;
      cur = cur.nextSibling;
    }

    // On extrait le texte avec un TOKEN unique à la place du <select>.
    // Ce token nous permet de RECONSTRUIRE la phrase avec n'importe quel
    // remplacement, et donc de demander à Google de traduire des variantes
    // grammaticalement complètes (au lieu de "...___..." qui casse la syntaxe).
    const TOKEN = '__TUBLANK__';
    let raw = '';
    let node = startNode;
    const stop = endNode.nextSibling;
    while (node && node !== stop) {
      if (node === select) {
        raw += ' ' + TOKEN + ' ';
      } else if (node.nodeType === 3) {
        raw += node.textContent || '';
      } else if (node.nodeType === 1) {
        const tag = node.tagName;
        if (tag === 'SELECT' || tag === 'INPUT' || tag === 'BUTTON' || tag === 'SCRIPT' || tag === 'STYLE') {
          // skip
        } else {
          raw += node.innerText || node.textContent || '';
        }
      }
      node = node.nextSibling;
    }
    raw = raw.replace(/\s+/g, ' ').trim();

    const buildWith = (replacement) => {
      const repl = (replacement == null ? '' : String(replacement)).trim() || '…';
      return raw.split(TOKEN).join(repl);
    };
    // Texte affichable de référence (pour le sniff de langue cible)
    const text = buildWith('___');

    return { text, endNode, buildWith, raw, token: TOKEN };
  }

  async function runParallel(items, concurrency, fn) {
    const q = items.slice();
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push((async () => {
        while (q.length) {
          const item = q.shift();
          try { await fn(item); } catch {}
        }
      })());
    }
    await Promise.all(workers);
  }

  function injectTranslation(node, translated, type) {
    if (!node || !translated) return;
    node.querySelectorAll('.' + TRAD_CLASS + ', .' + TRAD_Q_CLASS).forEach(n => n.remove());
    const span = document.createElement('span');
    if (type === 'question') {
      span.className = TRAD_Q_CLASS;
      span.textContent = translated;
    } else {
      span.className = TRAD_CLASS;
      span.textContent = ' (' + translated + ')';
    }
    node.appendChild(span);
  }

  /* === Helpers QCM === */

  const escapeHtml = (s) => (s || '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));

  const optOrigText = (opt) => {
    if (!opt) return '';
    return (opt.dataset.tuOriginal || opt.text || opt.value || '').replace(/\s+—\s+.*/, '').trim();
  };

  // Trouve la position de `needle` dans `hay` (insensible à la casse, word-boundary).
  // Retourne [start, end] ou null.
  function findInSentence(hay, needle) {
    if (!needle || needle.length < 1) return null;
    const escRe = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^\\p{L}\\p{N}\'’])(' + escRe + ')(?![\\p{L}\\p{N}])', 'iu');
    const m = re.exec(hay);
    if (!m) return null;
    const start = m.index + m[1].length;
    return [start, start + m[2].length];
  }

  /* === Analyseur de phrase pour suggérer la bonne réponse ===
     Score chaque variante traduite selon sa "naturalité" en français.
     Plus le score est élevé, plus la phrase semble grammaticalement correcte.

     Critères pondérés (positifs et négatifs) :
       + substitution propre (l'option traduite apparaît verbatim dans la phrase)
       + commence par majuscule
       + finit par ponctuation finale
       + structure article + nom + prép + nom (typique français correct)
       − longueur excessive vs autres variantes (français correct = concis)
       − artefacts (___ résiduel, double espace)
       − mot dupliqué consécutif (ex : "pour pour")
       − doublon d'article (le le, du de)
       − doublon de préposition (à de, en sur)
       − orphelins / construction cassée */
  function scoreFillVariant(variant, optTrans, allVariants) {
    if (!variant) return -100;
    const v = variant.trim();
    let s = 100;

    // Longueur RELATIVE par rapport à la plus courte (pénalité douce)
    if (allVariants && allVariants.length) {
      const minLen = Math.min(...allVariants.filter(Boolean).map(x => x.length));
      s -= Math.max(0, v.length - minLen) * 0.18;
    } else {
      s -= v.length * 0.05;
    }

    // Substitution propre : l'option traduite apparaît verbatim
    if (optTrans) {
      if (findInSentence(v, optTrans)) s += 25;
      else s -= 8;
    }

    // === Pénalités d'artefacts / fautes typiques de Google ===
    if (/_{2,}/.test(v))                      s -= 60; // ___ résiduel
    if (/\s{2,}/.test(v))                     s -= 4;  // double espace
    if (/^[.,;:]/.test(v))                    s -= 20; // commence par ponct
    if (/(\b\w{2,}\b)\s+\1\b/i.test(v))       s -= 18; // mot dupliqué consécutif

    // Doublons d'articles français
    if (/\b(le|la|les|du|des|de la)\s+(le|la|les|du|des|un|une)\b/i.test(v)) s -= 25;
    // Doublons de prépositions
    if (/\b(à|de|en|sur|sous|avec|pour|par|dans|chez|vers|sans)\s+(à|de|en|sur|sous|avec|pour|par|dans|chez|vers|sans)\b/i.test(v)) s -= 20;
    // "de + le" devrait être "du", "de + les" → "des", "à + le" → "au"
    if (/\bde le\b/i.test(v))   s -= 15;
    if (/\bde les\b/i.test(v))  s -= 15;
    if (/\bà le\b/i.test(v))    s -= 15;
    if (/\bà les\b/i.test(v))   s -= 15;
    // Article puis verbe (chaîne cassée)
    if (/\b(le|la|les|un|une|des)\s+(est|sont|était|étaient|sera|seront|a été|ont été)\b/i.test(v)) s -= 12;

    // === Bonus d'ordre grammatical ===
    if (/^[A-ZÀ-Ö]/.test(v))                  s += 2;  // majuscule initiale
    if (/[.!?]$/.test(v))                     s += 2;  // ponctuation finale
    // Pattern article + nom + préposition + nom
    if (/\b(le|la|les|un|une|des)\s+\w+\s+(de|du|des|à|au|aux|en)\s+\w+/i.test(v)) s += 4;
    // Pattern verbe au passé composé (j'ai/tu as/il a + participe)
    if (/\b(j'ai|tu as|il a|elle a|nous avons|vous avez|ils ont|elles ont)\s+\w+é\b/i.test(v)) s += 3;
    // Pronom réfléchi correct
    if (/\b(me|te|se|nous|vous)\s+\w+/i.test(v)) s += 1;

    return s;
  }

  function pickProbableAnswer(variantsMap, optTransMap) {
    const r = pickProbableAnswerWithConfidence(variantsMap, optTransMap);
    return r ? r.orig : null;
  }

  /* Retourne la meilleure option ET un % de confiance basé sur la marge
     entre le 1er et le 2e score. Marge faible → confiance basse (incertain). */
  function pickProbableAnswerWithConfidence(variantsMap, optTransMap) {
    const allVariants = Object.values(variantsMap || {});
    const scored = [];
    for (const [orig, variant] of Object.entries(variantsMap || {})) {
      if (!variant) continue;
      scored.push({
        orig,
        variant,
        trans: optTransMap?.[orig] || '',
        score: scoreFillVariant(variant, optTransMap?.[orig] || '', allVariants),
      });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const second = scored[1];
    const margin = second ? Math.max(0, best.score - second.score) : 50;
    // Mapping marge → confiance % : marge 0 = 40%, marge 50+ = 95%
    const confidence = Math.min(95, Math.max(40, Math.round(40 + margin * 1.1)));
    return { orig: best.orig, confidence, scored };
  }

  /* Rendu enrichi de la traduction d'un fill-blank :
     - Phrase principale : variante de l'option active, avec surlignage
     - Tableau de comparaison : toutes les variantes, cliquables pour sélectionner
     - Suggestion 💡 sur l'option probable (si activé)
     - Bouton 🔉 audio TTS de la phrase originale
     - Bouton ⭐ pour sauvegarder la question
  */
  function renderFillBlankTranslation(selectEl, variantsMap, optTransMap, rawSentence) {
    const span = document.createElement('span');
    span.className = TRAD_Q_CLASS + ' tu-fill-blank';

    const opts = Array.from(selectEl.options || []);
    const optsOrigList = opts.map(o => optOrigText(o));
    const suggestion = state.qcmHint ? pickProbableAnswerWithConfidence(variantsMap, optTransMap) : null;
    qcmSessionCount++;

    const renderActive = () => {
      const cur = selectEl.options[selectEl.selectedIndex];
      const curOrig = optOrigText(cur);
      const variant = variantsMap[curOrig] || '';
      const curOptTrans = optTransMap[curOrig] || '';

      let sentenceHtml;
      if (variant) {
        const range = curOptTrans ? findInSentence(variant, curOptTrans) : null;
        if (range) {
          sentenceHtml =
            escapeHtml(variant.slice(0, range[0])) +
            `<mark class="tu-fill-mark" title="${escapeHtml(curOrig)}">${escapeHtml(variant.slice(range[0], range[1]))}</mark>` +
            escapeHtml(variant.slice(range[1]));
        } else {
          sentenceHtml = escapeHtml(variant) +
            (curOptTrans ? ` <mark class="tu-fill-mark" title="${escapeHtml(curOrig)}">→ ${escapeHtml(curOptTrans)}</mark>` : '');
        }
      } else {
        sentenceHtml = curOptTrans
          ? `<mark class="tu-fill-mark">${escapeHtml(curOptTrans)}</mark>`
          : `<mark class="tu-fill-mark tu-fill-empty">…</mark>`;
      }
      return sentenceHtml;
    };

    const renderSuggestion = () => {
      if (!suggestion || !suggestion.orig) return '';
      const cur = selectEl.options[selectEl.selectedIndex];
      const curOrig = optOrigText(cur);
      const isChosen = curOrig === suggestion.orig;
      const optTrans = optTransMap[suggestion.orig] || '';
      // Niveau de confiance → classe CSS pour la couleur
      const lvl = suggestion.confidence >= 80 ? 'high'
                : suggestion.confidence >= 60 ? 'mid'
                : 'low';
      return `<div class="tu-fill-suggest tu-conf-${lvl}${isChosen ? ' is-chosen' : ''}">
        <span class="tu-suggest-icon">⚜</span>
        <span class="tu-suggest-label">Réponse probable</span>
        <strong class="tu-suggest-word">${escapeHtml(suggestion.orig)}</strong>
        ${optTrans ? `<span class="tu-suggest-arrow">→</span><em class="tu-suggest-trans">${escapeHtml(optTrans)}</em>` : ''}
        <span class="tu-suggest-conf" title="Confiance basée sur l'analyse grammaticale">${suggestion.confidence}%</span>
        ${isChosen
          ? '<span class="tu-suggest-applied" title="Vous avez déjà cette option sélectionnée">✓</span>'
          : `<button type="button" class="tu-suggest-apply" data-orig="${escapeHtml(suggestion.orig)}" title="Sélectionner cette option dans le menu">⚔ Choisir</button>`
        }
      </div>`;
    };

    const renderTools = () => {
      const audio = state.qcmAudio !== false
        ? `<button type="button" class="tu-fill-tool tu-fill-speak" title="Écouter la phrase originale">🔉 Écouter</button>` : '';
      const bookmark = `<button type="button" class="tu-fill-tool tu-fill-bookmark" title="Sauvegarder la question dans les favoris">☆ Garder</button>`;
      return `<div class="tu-fill-tools">${audio}${bookmark}</div>`;
    };

    const render = () => {
      span.innerHTML = renderSuggestion() + renderActive() + renderTools();
    };

    render();

    // === Wire interactions ===
    span.addEventListener('click', (e) => {
      // Bouton "Choisir" (Suggestion → applique l'option dans le <select>)
      const apply = e.target.closest('.tu-suggest-apply');
      if (apply) {
        const orig = apply.dataset.orig;
        const idx = optsOrigList.indexOf(orig);
        if (idx >= 0) {
          selectEl.selectedIndex = idx;
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return;
      }
      const speak = e.target.closest('.tu-fill-speak');
      if (speak) {
        const cur = selectEl.options[selectEl.selectedIndex];
        const curOrig = optOrigText(cur) || '___';
        // Reconstitue la phrase originale en remplaçant le token par l'option
        // active. Si rawSentence n'est pas fourni, fallback = phrase + option.
        const utter = rawSentence
          ? rawSentence.split('__TUBLANK__').join(curOrig)
          : curOrig;
        chrome.runtime.sendMessage({ type: 'TTS_SPEAK', text: utter, lang: 'en-US' });
        return;
      }
      const bm = e.target.closest('.tu-fill-bookmark');
      if (bm) {
        const cur = selectEl.options[selectEl.selectedIndex];
        const curOrig = optOrigText(cur);
        const variant = variantsMap[curOrig] || '';
        // Construire le payload favori
        try {
          chrome.storage.local.get(['favorites'], (s) => {
            const favs = Array.isArray(s.favorites) ? s.favorites : [];
            const text = `[QCM] ${curOrig} (parmi : ${optsOrigList.filter(Boolean).join(' / ')})`;
            const translated = variant || optTransMap[curOrig] || '';
            favs.unshift({
              text, translated,
              from: state.langFrom !== 'auto' ? state.langFrom : 'en',
              to: state.langTo || 'fr',
              kind: 'qcm-fill',
              context: { options: optsOrigList, variants: variantsMap },
              favoritedAt: Date.now(),
            });
            chrome.storage.local.set({ favorites: favs.slice(0, 200) });
            bm.textContent = '★';
            bm.classList.add('is-active');
            toast('Question ajoutée aux favoris');
          });
        } catch {}
      }
    });

    // Maj quand l'utilisateur change la sélection (depuis le <select> ou nos boutons)
    const onChange = () => render();
    selectEl.addEventListener('change', onChange);
    selectEl._tuFillCleanup = () => selectEl.removeEventListener('change', onChange);

    return span;
  }

  let qcmRunning = false;
  let qcmPendingRun = false;

  async function translateQcm({ silent = false } = {}) {
    if (qcmRunning) { qcmPendingRun = true; return 0; }
    qcmRunning = true;
    await loadPersistentCache();

    try {
      const groups      = findOptionGroups();
      const fillBlanks  = findFillBlankSelects();
      if (!groups.length && !fillBlanks.length) return 0;

      const from = state.langFrom || 'auto';
      const to   = state.langTo   || 'fr';

      // Si la page est explicitement dans la langue cible, on skip.
      const htmlLang = (document.documentElement.lang || '').split('-')[0].toLowerCase();
      if (htmlLang && htmlLang === to) return 0;

      /* Jobs : {node, text, type} */
      const jobs = [];
      const seenQs = new WeakSet();

      for (const g of groups) {
        const q = findQuestionFor(g.container);
        if (q && !seenQs.has(q) && q.dataset.tuTranslated !== '1') {
          const qText = getCleanText(q);
          if (qText && qText.length >= 3 && qText.length <= 600) {
            seenQs.add(q);
            jobs.push({ node: q, text: qText, type: 'question' });
          }
        }
        for (const opt of g.options) {
          if (opt.dataset.tuTranslated === '1') continue;
          const txt = getCleanText(opt);
          if (!txt || txt.length < 1 || txt.length > 300) continue;
          jobs.push({ node: opt, text: txt, type: 'option' });
        }
      }

      // Phrases à trou (selects) : pour chaque option, on traduit la phrase
      // ENTIÈRE avec l'option substituée (donne du contexte à Google et
      // garantit accords/articles/prépositions corrects), PLUS l'option
      // seule (pour la chip et le surlignage du mot dans la phrase traduite).
      for (const fb of fillBlanks) {
        const opts = Array.from(fb.select.options || []);
        // Conteneur de placement : on attache UN seul span après afterNode
        // qui rassemblera tout. Marqué via un job 'fill-anchor' pour le rendu final.
        jobs.push({
          type: 'fill-anchor',
          select: fb.select,
          afterNode: fb.afterNode,
          buildWith: fb.buildWith,
          rawSentence: fb.rawSentence,
          // pas de traduction à faire pour ce job, juste un marqueur
          text: '',
          skip: true,
        });
        for (const opt of opts) {
          const orig = ((opt.dataset.tuOriginal || opt.text || opt.value || '') + '').trim();
          if (!orig || orig.length > 120) continue;
          // Variante de phrase complète avec cette option substituée
          const variantText = fb.buildWith(orig);
          if (variantText.length <= 500) {
            jobs.push({
              type: 'fill-variant',
              select: fb.select,
              optOrig: orig,
              text: variantText,
            });
          }
          // Option seule (pour la chip + matching highlight)
          if (opt.dataset.tuTranslated !== '1') {
            jobs.push({
              type: 'select-option',
              node: opt,
              optOrig: orig,
              text: orig,
            });
          }
        }
      }

      if (!jobs.length) return 0;

      // "Sniff" : pré-détection pour éviter de traduire une page déjà dans la langue cible.
      const sniff = jobs.slice().sort((a, b) => b.text.length - a.text.length)[0];
      const sniffRes = await cachedTranslate(sniff.text, from, to);
      if (sniffRes && sniffRes.detected && sniffRes.detected === to) {
        return 0;
      }

      // Sépare les jobs traduisibles des jobs marqueurs (fill-anchor)
      const translateJobs = jobs.filter(j => !j.skip);
      const texts = translateJobs.map(j => j.text);
      const { results: tres } = await batchTranslateTexts(texts, from, to);
      // Re-mappe les résultats sur les indices d'origine
      const results = new Array(jobs.length).fill(null);
      let ti = 0;
      jobs.forEach((j, i) => { if (!j.skip) results[i] = tres[ti++]; });

      // Indexes par <select> :
      //   fillBlankVariants : { select → { optOrig: translatedFullSentence } }
      //   fillBlankOptTrans : { select → { optOrig: translatedOptionAlone } }
      const fillBlankVariants = new Map();
      const fillBlankOptTrans = new Map();
      jobs.forEach((job, i) => {
        const r = results[i];
        if (!r || !r.translated) return;
        if (job.type === 'fill-variant') {
          if (!fillBlankVariants.has(job.select)) fillBlankVariants.set(job.select, {});
          fillBlankVariants.get(job.select)[job.optOrig] = r.translated;
        } else if (job.type === 'select-option') {
          const sel = job.node?.parentNode;
          if (!sel || sel.tagName !== 'SELECT') return;
          if (!fillBlankOptTrans.has(sel)) fillBlankOptTrans.set(sel, {});
          fillBlankOptTrans.get(sel)[job.optOrig] = r.translated;
        }
      });

      jobs.forEach((job, i) => {
        const r = results[i];

        // Anchor pour fill-blank : on rend MAINTENANT en agrégeant
        // les variantes et options traduites collectées plus haut.
        if (job.type === 'fill-anchor') {
          const variants = fillBlankVariants.get(job.select) || {};
          const optTrans = fillBlankOptTrans.get(job.select) || {};
          if (!Object.keys(variants).length && !Object.keys(optTrans).length) return;
          // Évite la double-injection si on relance translateQcm sur le même DOM
          const after = job.afterNode || job.select;
          if (after.nextSibling && after.nextSibling.classList?.contains(TRAD_Q_CLASS)) return;
          const span = renderFillBlankTranslation(job.select, variants, optTrans, job.rawSentence);
          after.after(span);
          // Marque les options du select comme traduites pour le compteur
          Array.from(job.select.options || []).forEach(o => { o.dataset.tuTranslated = '1'; });
          return;
        }

        if (!r || !r.translated) return;
        if (sameText(r.translated, job.text)) return;
        if (r.detected && r.detected === to) return;

        if (job.type === 'fill-variant') {
          // Le résultat est déjà collecté plus haut, rien à faire ici
          return;
        }
        if (job.type === 'select-option') {
          // Affiche la traduction directement dans le <option> du dropdown
          const opt = job.node;
          const original = (opt.dataset.tuOriginal || opt.text || '').trim();
          if (!opt.dataset.tuOriginal) opt.dataset.tuOriginal = original;
          opt.text = original + '  —  ' + r.translated;
          opt.dataset.tuTranslated = '1';
          return;
        }
        // Cas standards (question / option de QCM classique)
        injectTranslation(job.node, r.translated, job.type);
        if (job.node) job.node.dataset.tuTranslated = '1';
      });

      const count = jobs.filter(j => j.node && j.node.dataset && j.node.dataset.tuTranslated === '1').length;
      if (count > 0 && !silent) {
        toast('🌐 ' + count + ' élément' + (count > 1 ? 's' : '') + ' traduit' + (count > 1 ? 's' : ''));
      }
      return count;
    } finally {
      qcmRunning = false;
      if (qcmPendingRun) {
        qcmPendingRun = false;
        // Relance différée pour capter les nouveaux nœuds mutés pendant la traduction
        setTimeout(() => translateQcm({ silent: true }), 500);
      }
    }
  }

  function clearQcm() {
    document.querySelectorAll('.' + TRAD_CLASS + ', .' + TRAD_Q_CLASS).forEach(removeEl);
    // Restaure les <option> modifiées
    document.querySelectorAll('option[data-tu-original]').forEach(opt => {
      opt.text = opt.dataset.tuOriginal;
      delete opt.dataset.tuOriginal;
    });
    document.querySelectorAll('[data-tu-translated]').forEach(l => delete l.dataset.tuTranslated);
    QCM_CACHE.clear();
    QCM_MISS.clear();
  }

  /* --- Auto-mode : surveille les mutations pour retraduire les nouveaux QCM --- */
  let qcmObserver = null;
  let qcmDebounce = null;

  function startQcmAuto() {
    if (qcmObserver) return;
    const scheduleRun = (silent = true) => {
      clearTimeout(qcmDebounce);
      qcmDebounce = setTimeout(() => translateQcm({ silent }).catch(() => {}), 450);
    };

    qcmObserver = new MutationObserver((mutations) => {
      // Ignore nos propres mutations
      for (const m of mutations) {
        const added = [...m.addedNodes];
        const relevant = added.some(n => {
          if (!(n && n.nodeType === 1)) return false;
          if (n.classList && n.classList.contains(TRAD_CLASS)) return false;
          if (n.classList && n.classList.contains(TRAD_Q_CLASS)) return false;
          if (n.closest && n.closest('.tu-root')) return false;
          return true;
        });
        if (relevant) { scheduleRun(true); return; }
      }
    });
    const root = document.body || document.documentElement;
    try { qcmObserver.observe(root, { childList: true, subtree: true }); } catch {}

    // Premier run différé pour laisser la page se stabiliser
    setTimeout(() => translateQcm({ silent: false }).catch(() => {}), 500);
  }

  function stopQcmAuto() {
    if (qcmObserver) { try { qcmObserver.disconnect(); } catch {} qcmObserver = null; }
    clearTimeout(qcmDebounce);
  }

  /* =========================================================
     Apply settings
     ========================================================= */
  function applyState() {
    if (state.qcm) startQcmAuto();
    else stopQcmAuto();

    if (!state.selection) hideTooltip();
  }

  /* =========================================================
     Messaging
     ========================================================= */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    if (msg.type === 'SETTINGS_UPDATED') {
      Object.assign(state, msg.settings || {});
      applyState();
      try { sendResponse({ ok: true }); } catch {}
      return false;
    }
    if (msg.type === 'CTX_TRANSLATE_SELECTION') {
      state.selection = true;
      showTooltipForSelection();
      try { sendResponse({ ok: true }); } catch {}
      return false;
    }
    if (msg.type === 'CTX_TRANSLATE_QCM' || msg.type === 'RUN_QCM') {
      translateQcm()
        .then(count => { try { sendResponse({ ok: true, count: count || 0 }); } catch {} })
        .catch(err => { try { sendResponse({ ok: false, error: err.message }); } catch {} });
      return true; // async response
    }
    if (msg.type === 'CLEAR_CACHE') {
      try { QCM_CACHE.clear(); QCM_MISS.clear(); } catch {}
      try { chrome.storage.local.remove(PERSIST_KEY); } catch {}
      toast('Cache vidé');
      try { sendResponse({ ok: true }); } catch {}
      return false;
    }

    return false;
  });

  /* =========================================================
     Init
     ========================================================= */
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    Object.assign(state, stored || {});
    applyState();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    let changed = false;
    for (const k of Object.keys(changes)) {
      if (k in state) { state[k] = changes[k].newValue; changed = true; }
    }
    if (changed) applyState();
  });
})();
