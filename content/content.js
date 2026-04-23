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
    audio: false,
    langFrom: 'auto',
    langTo: 'fr',
  };
  const state = { ...DEFAULTS };

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
        <span class="tu-pos"></span>
      </div>
      <div class="tu-row tu-translated">
        <span class="tu-flag tu-flag-to">🇫🇷</span>
        <span class="tu-fr"></span>
      </div>
      <div class="tu-actions">
        <button class="tu-mini-btn tu-speak"   title="Écouter">🔊</button>
        <button class="tu-mini-btn tu-copy"    title="Copier">📋</button>
        <button class="tu-mini-btn tu-wide tu-more">📖 Plus de détails</button>
      </div>
    `;
    document.documentElement.appendChild(tooltip);

    tooltip.querySelector('.tu-speak').addEventListener('click', (e) => {
      e.stopPropagation();
      const w = tooltip.querySelector('.tu-word').textContent;
      const code = tooltip.dataset.detected || 'en';
      speak(w, SPEECH_LANG[code] || 'en-US');
    });
    tooltip.querySelector('.tu-copy').addEventListener('click', async (e) => {
      e.stopPropagation();
      const fr = tooltip.querySelector('.tu-fr').textContent;
      try { await navigator.clipboard.writeText(fr); toast('Copié'); } catch {}
    });
    tooltip.querySelector('.tu-more').addEventListener('click', (e) => {
      e.stopPropagation();
      const w = tooltip.querySelector('.tu-word').textContent;
      window.open('https://www.google.com/search?q=' + encodeURIComponent('définition ' + w), '_blank', 'noopener');
    });
    return tooltip;
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

    t.style.visibility = 'hidden';
    t.classList.add('tu-show');
    requestAnimationFrame(() => {
      positionTooltip(t, rect);
      t.style.visibility = 'visible';
    });

    try {
      const { translated, detected } = await apiTranslate(text, state.langFrom || 'auto', state.langTo || 'fr');
      if (seq !== tooltipSeq) return;
      t.querySelector('.tu-fr').textContent = translated || '—';
      if (detected && FLAG[detected]) t.querySelector('.tu-flag-from').textContent = FLAG[detected];
      t.dataset.detected = detected || '';
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
    hoverTimer = setTimeout(() => {
      const w = wordAtPoint(cx, cy);
      if (!w) { hoverLastWord = ''; hideTooltip(); return; }
      if (w.text === hoverLastWord && tooltip?.classList.contains('tu-show')) return;
      hoverLastWord = w.text;
      showTooltipForText(w.text, w.rect);
    }, 450);
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTooltip(); });

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

    // 2) Frères précédents (headings, .question, légende implicite)
    let sib = container.previousElementSibling;
    for (let i = 0; sib && i < 6; i++, sib = sib.previousElementSibling) {
      const tag = sib.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag))                     return sib;
      if (sib.matches('legend, [role="heading"]'))  return sib;
      if (sib.matches('.question, .quiz-question, .qcm-question, .survey-question')) return sib;
      const text = (sib.innerText || sib.textContent || '').trim();
      if (text && text.length < 500 && (tag === 'p' || tag === 'div' || tag === 'span' || tag === 'label')) {
        if (/[?:;]\s*$/.test(text) || /^(question\s*\d*|q\d+|qcm)/i.test(text)) return sib;
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
      '.answers .answer', '.quiz-answers .quiz-answer',
      '.qcm-option', '.qcm__option', '.question-choices .choice',
      '.choices .choice', '.options .option',
      '[data-qcm-option]', '[data-answer]', '[data-choice]'
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

      out.push({ select, text: sent.text, afterNode: sent.endNode });
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

    // Extraction du texte de la phrase, select remplacé par "___"
    let text = '';
    let node = startNode;
    const stop = endNode.nextSibling;
    while (node && node !== stop) {
      if (node === select) {
        text += ' ___ ';
      } else if (node.nodeType === 3) {
        text += node.textContent || '';
      } else if (node.nodeType === 1) {
        const tag = node.tagName;
        if (tag === 'SELECT' || tag === 'INPUT' || tag === 'BUTTON' || tag === 'SCRIPT' || tag === 'STYLE') {
          // skip
        } else {
          text += node.innerText || node.textContent || '';
        }
      }
      node = node.nextSibling;
    }
    text = text.replace(/\s+/g, ' ').trim();
    // Enlève la numérotation "1." ou "12." en début (optionnel, améliore la traduction)
    // On la garde pour rester fidèle.
    return { text, endNode };
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

      // Phrases à trou (selects) : on traduit la phrase entière
      // + chaque option du select individuellement (affichée dans le dropdown)
      for (const fb of fillBlanks) {
        jobs.push({ node: fb.select, afterNode: fb.afterNode, text: fb.text, type: 'sentence' });
        Array.from(fb.select.options || []).forEach(opt => {
          if (opt.dataset.tuTranslated === '1') return;
          const txt = (opt.text || '').trim();
          if (!txt || txt.length > 120) return;
          jobs.push({ node: opt, text: txt, type: 'select-option' });
        });
      }

      if (!jobs.length) return 0;

      // "Sniff" : pré-détection pour éviter de traduire une page déjà dans la langue cible.
      const sniff = jobs.slice().sort((a, b) => b.text.length - a.text.length)[0];
      const sniffRes = await cachedTranslate(sniff.text, from, to);
      if (sniffRes && sniffRes.detected && sniffRes.detected === to) {
        return 0;
      }

      // Traduction en LOT : 1 requête pour N textes (x4 à x8 plus rapide)
      const texts = jobs.map(j => j.text);
      const { results } = await batchTranslateTexts(texts, from, to);

      jobs.forEach((job, i) => {
        const r = results[i];
        if (!r || !r.translated) return;
        if (sameText(r.translated, job.text)) return;
        if (r.detected && r.detected === to) return;

        if (job.type === 'sentence') {
          if (job.afterNode && job.afterNode.nextSibling &&
              job.afterNode.nextSibling.nodeType === 1 &&
              job.afterNode.nextSibling.classList?.contains(TRAD_Q_CLASS)) return;
          const span = document.createElement('span');
          span.className = TRAD_Q_CLASS;
          span.textContent = r.translated;
          (job.afterNode || job.node).after(span);
        } else if (job.type === 'select-option') {
          const original = (job.node.dataset.tuOriginal || job.node.text || '').trim();
          if (!job.node.dataset.tuOriginal) job.node.dataset.tuOriginal = original;
          job.node.text = original + '  —  ' + r.translated;
        } else {
          injectTranslation(job.node, r.translated, job.type);
        }
        job.node.dataset.tuTranslated = '1';
      });

      const count = jobs.filter(j => j.node.dataset.tuTranslated === '1').length;
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
     3. AUDIO WIDGET — sous-titres réels
     ========================================================= */
  let widget = null;
  let subtitleEngine = null;
  const WIDGET_STATE_KEY = 'tuAudioWidget'; // position, taille font, minimisé, historique visible

  const WIDGET_DEFAULTS = {
    left: null, top: null,       // null → bottom-right par défaut
    minimized: false,
    fontSize: 14,                // px, valeur baseline
    showHistory: true,
    tabGain: 1.0,                // multiplicateur d'amplification de l'audio onglet
    showHelp: false,
  };
  let widgetUI = { ...WIDGET_DEFAULTS };

  function saveWidgetState(patch) {
    Object.assign(widgetUI, patch || {});
    try { chrome.storage.local.set({ [WIDGET_STATE_KEY]: widgetUI }); } catch {}
  }
  async function loadWidgetState() {
    try {
      const s = await new Promise(res => chrome.storage.local.get([WIDGET_STATE_KEY], res));
      widgetUI = { ...WIDGET_DEFAULTS, ...(s?.[WIDGET_STATE_KEY] || {}) };
    } catch {}
  }

  function buildWidget() {
    if (widget) return widget;
    widget = el('div', `${TU_ROOT_CLASS} tu-audio tu-glass`);
    widget.innerHTML = `
      <div class="tu-head">
        <div class="tu-title">
          <span class="tu-rec-dot"></span>
          <strong>Live Audio</strong>
          <span class="tu-muted tu-small tu-status">en attente…</span>
        </div>
        <div class="tu-head-btns">
          <button class="tu-mini-btn tu-btn-help"      title="Aide / conseils pour un test d'anglais">?</button>
          <button class="tu-mini-btn tu-btn-font-down" title="Texte plus petit">A−</button>
          <button class="tu-mini-btn tu-btn-font-up"   title="Texte plus grand">A+</button>
          <button class="tu-mini-btn tu-btn-min"       title="Réduire">—</button>
          <button class="tu-mini-btn tu-btn-close"     title="Fermer">✕</button>
        </div>
      </div>
      <div class="tu-body">
        <div class="tu-line">
          <span class="tu-flag tu-flag-src">🌍</span>
          <span class="tu-muted tu-small">Original</span>
          <span class="tu-muted tu-small tu-src-label"></span>
          <p class="tu-orig tu-muted">Capture en cours — lance un audio sur la page.</p>
        </div>
        <div class="tu-divider"></div>
        <div class="tu-line">
          <span class="tu-flag tu-flag-tgt">🇫🇷</span>
          <span class="tu-muted tu-small">Traduction</span>
          <p class="tu-trad tu-muted">—</p>
        </div>

        <div class="tu-gain-row">
          <span class="tu-muted tu-small">🔊 Boost</span>
          <input class="tu-gain" type="range" min="0" max="3" step="0.1" value="1" title="Amplification de l'audio onglet"/>
          <span class="tu-gain-val tu-muted tu-small">1.0×</span>
        </div>
        <div class="tu-level"><div class="tu-level-bar"></div></div>

        <div class="tu-help" hidden>
          <div class="tu-help-title">🎯 Capture audio de l'onglet</div>
          <ul>
            <li><b>Aucun micro utilisé</b> — seul l'audio produit par l'onglet est capté (<code>chrome.tabCapture</code>).</li>
            <li>L'audio reste audible normalement (casque ou enceintes).</li>
            <li>Le boost amplifie jusqu'à ×3 si le son est faible.</li>
            <li>Le VU-mètre confirme que l'audio est bien capturé.</li>
            <li><i>Transcription locale (Whisper WASM) : option à activer dans une prochaine version.</i></li>
          </ul>
        </div>

        <div class="tu-history" hidden></div>
      </div>
      <div class="tu-foot">
        <button class="tu-mini-btn tu-btn-source"  title="Changer la source (auto / tab / mic / sous-titres…)">📡 Source</button>
        <button class="tu-mini-btn tu-btn-pause"   title="Pause">⏸️</button>
        <button class="tu-mini-btn tu-btn-history" title="Historique">📜</button>
        <button class="tu-mini-btn tu-btn-export"  title="Export TXT">💾 TXT</button>
        <button class="tu-mini-btn tu-btn-export-srt" title="Export SRT">🎬 SRT</button>
      </div>
    `;
    document.documentElement.appendChild(widget);

    // Applique les préférences persistantes
    if (widgetUI.left != null && widgetUI.top != null) {
      widget.style.left  = widgetUI.left  + 'px';
      widget.style.top   = widgetUI.top   + 'px';
      widget.style.right = 'auto'; widget.style.bottom = 'auto';
    }
    if (widgetUI.minimized) widget.classList.add('tu-min');
    widget.style.setProperty('--tu-font-size', (widgetUI.fontSize || 14) + 'px');
    const history = widget.querySelector('.tu-history');
    if (history && !widgetUI.showHistory) history.hidden = true;
    const helpEl = widget.querySelector('.tu-help');
    if (helpEl && widgetUI.showHelp) helpEl.hidden = false;
    // Slider de gain
    const gainSlider = widget.querySelector('.tu-gain');
    const gainVal    = widget.querySelector('.tu-gain-val');
    if (gainSlider && gainVal) {
      const initGain = Number(widgetUI.tabGain);
      const g = Number.isFinite(initGain) ? initGain : 1.0;
      gainSlider.value = String(g);
      gainVal.textContent = g.toFixed(1) + '×';
      gainSlider.addEventListener('input', () => {
        const v = parseFloat(gainSlider.value) || 1;
        gainVal.textContent = v.toFixed(1) + '×';
        saveWidgetState({ tabGain: v });
        if (subtitleEngine?.setTabGain) subtitleEngine.setTabGain(v);
      });
    }

    /* Drag */
    const head = widget.querySelector('.tu-head');
    let drag = null;
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('.tu-head-btns')) return;
      const r = widget.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const x = e.clientX - drag.dx;
      const y = e.clientY - drag.dy;
      const nx = Math.min(Math.max(8, x), window.innerWidth  - widget.offsetWidth  - 8);
      const ny = Math.min(Math.max(8, y), window.innerHeight - widget.offsetHeight - 8);
      widget.style.left   = nx + 'px';
      widget.style.top    = ny + 'px';
      widget.style.right  = 'auto'; widget.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (drag) {
        const r = widget.getBoundingClientRect();
        saveWidgetState({ left: Math.round(r.left), top: Math.round(r.top) });
      }
      drag = null;
    });

    widget.querySelector('.tu-btn-min').addEventListener('click', () => {
      widget.classList.toggle('tu-min');
      saveWidgetState({ minimized: widget.classList.contains('tu-min') });
    });
    widget.querySelector('.tu-btn-close').addEventListener('click', () => {
      stopAudio();
      chrome.storage.sync.set({ audio: false });
    });

    widget.querySelector('.tu-btn-font-up').addEventListener('click', () => {
      const cur = parseFloat(getComputedStyle(widget).getPropertyValue('--tu-font-size')) || 14;
      const next = Math.min(28, cur + 2);
      widget.style.setProperty('--tu-font-size', next + 'px');
      saveWidgetState({ fontSize: next });
    });
    widget.querySelector('.tu-btn-font-down').addEventListener('click', () => {
      const cur = parseFloat(getComputedStyle(widget).getPropertyValue('--tu-font-size')) || 14;
      const next = Math.max(11, cur - 2);
      widget.style.setProperty('--tu-font-size', next + 'px');
      saveWidgetState({ fontSize: next });
    });

    let paused = false;
    const pauseBtn = widget.querySelector('.tu-btn-pause');
    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? '▶️' : '⏸️';
      pauseBtn.title = paused ? 'Reprendre' : 'Pause';
      if (subtitleEngine) subtitleEngine.paused = paused;
    });

    widget.querySelector('.tu-btn-source').addEventListener('click', () => {
      if (!subtitleEngine) return;
      subtitleEngine.cycleSource();
    });

    widget.querySelector('.tu-btn-history').addEventListener('click', () => {
      const h = widget.querySelector('.tu-history');
      h.hidden = !h.hidden;
      saveWidgetState({ showHistory: !h.hidden });
      if (!h.hidden) renderHistoryList();
    });

    widget.querySelector('.tu-btn-help').addEventListener('click', () => {
      const h = widget.querySelector('.tu-help');
      h.hidden = !h.hidden;
      saveWidgetState({ showHelp: !h.hidden });
    });

    widget.querySelector('.tu-btn-export').addEventListener('click', () => {
      const log = subtitleEngine?.log || [];
      const txt = log.map(e => `[${e.t}]\n${e.src}\n→ ${e.trad}\n`).join('\n');
      downloadBlob(txt || '(aucun sous-titre)', 'subtitles.txt', 'text/plain;charset=utf-8');
      toast('Export TXT téléchargé');
    });
    widget.querySelector('.tu-btn-export-srt').addEventListener('click', () => {
      const log = subtitleEngine?.log || [];
      if (!log.length) { toast('Aucun sous-titre à exporter'); return; }
      downloadBlob(buildSrt(log), 'subtitles.srt', 'text/plain;charset=utf-8');
      toast('Export SRT téléchargé');
    });

    return widget;
  }

  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = el('a'); a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function buildSrt(log) {
    const fmt = (ms) => {
      const s = Math.floor(ms / 1000);
      const h = String(Math.floor(s / 3600)).padStart(2, '0');
      const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const sec = String(s % 60).padStart(2, '0');
      const mss = String(ms % 1000).padStart(3, '0');
      return `${h}:${m}:${sec},${mss}`;
    };
    // Si on a des ms absolus, on les utilise ; sinon on répartit 3 s par item
    const hasMs = log.every(e => typeof e.ms === 'number');
    const t0 = hasMs ? log[0].ms : 0;
    const lines = [];
    log.forEach((e, i) => {
      const start = hasMs ? (e.ms - t0) : (i * 3000);
      const end   = hasMs ? (log[i + 1] ? log[i + 1].ms - t0 : start + 3000) : (start + 3000);
      lines.push(
        String(i + 1),
        `${fmt(start)} --> ${fmt(end)}`,
        e.src || '',
        e.trad ? e.trad : '',
        ''
      );
    });
    return lines.join('\n');
  }

  function renderHistoryList() {
    const h = widget?.querySelector('.tu-history');
    if (!h || !subtitleEngine) return;
    const lastN = subtitleEngine.log.slice(-6);
    h.innerHTML = lastN.map(e => `
      <div class="tu-hist-item">
        <div class="tu-hist-time">${e.t}</div>
        <div class="tu-hist-src">${escapeHtml(e.src)}</div>
        <div class="tu-hist-trad">${escapeHtml(e.trad || '')}</div>
      </div>
    `).join('') || '<div class="tu-muted tu-small">Historique vide</div>';
    h.scrollTop = h.scrollHeight;
  }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  function setStatus(txt) {
    const s = widget?.querySelector('.tu-status'); if (s) s.textContent = txt;
  }
  function setSourceLabel(txt) {
    const s = widget?.querySelector('.tu-src-label'); if (s) s.textContent = txt ? '· ' + txt : '';
  }
  function setOrig(text, langCode) {
    if (!widget) return;
    const p = widget.querySelector('.tu-orig');
    const f = widget.querySelector('.tu-flag-src');
    if (f) f.textContent = FLAG[langCode] || '🌍';
    p.classList.remove('tu-muted');
    if (p.textContent === text) return;
    p.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' }).onfinish = () => {
      p.textContent = text;
      p.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, fill: 'forwards' });
    };
  }
  function setTrad(text, langCode) {
    if (!widget) return;
    const p = widget.querySelector('.tu-trad');
    const f = widget.querySelector('.tu-flag-tgt');
    if (f) f.textContent = FLAG[langCode] || '🇫🇷';
    p.classList.remove('tu-muted');
    p.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' }).onfinish = () => {
      p.textContent = text;
      p.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, fill: 'forwards' });
    };
  }

  /* =========================================================
     SubtitleEngine — capture AUDIO de l'onglet (priorité)
     - PRIORITÉ : capture directe de l'audio de l'onglet via chrome.tabCapture
       → amplification + lecture audible (Web Audio API)
       → transcription via l'entrée audio par défaut du système
         (micro OU Stereo Mix / Loopback pour les utilisateurs casque)
     - Micro seul (fallback)
     - Sous-titres (opt-in via cycleSource) : HTML5 tracks, YouTube,
       Netflix, Vimeo, Twitch, video.js, Shaka, JW, Plyr
     ========================================================= */
  class SubtitleEngine {
    constructor() {
      this.log = [];
      this.paused = false;
      this.lastText = '';
      // Modes : 'auto' | 'tab' | sous-titres ('video' | 'youtube' | ...)
      // PAS de mode micro — capture onglet uniquement.
      this.sourceMode = 'auto';
      this.detachers = [];
      this.detectedLang = state.langFrom !== 'auto' ? state.langFrom : 'en';

      // Tab audio
      this.tabStream = null;
      this.audioCtx  = null;
      this.tabGain   = null;
      this.tabAnalyser = null;
      this.levelRAF  = null;
    }

    async start() {
      this.stop();
      if (this.sourceMode === 'auto' || this.sourceMode === 'tab') {
        // Audio de l'onglet UNIQUEMENT — jamais de micro.
        const ok = await this.try_tab();
        if (ok) {
          setSourceLabel('tab');
          setOrig('🎧 Audio de l\u2019onglet capturé — lance un audio/une vidéo sur la page.', 'auto');
          setTrad('(transcription non dispo sans STT local — à venir)', state.langTo);
        } else {
          setSourceLabel('—');
          setStatus('❌ capture de l\u2019onglet refusée');
          setOrig('Clique "Écouter" dans le popup pour autoriser la capture.', 'auto');
          setTrad('—', state.langTo);
        }
        return;
      }
      // Modes sous-titres (opt-in via cycleSource)
      if (this[`try_${this.sourceMode}`] && this[`try_${this.sourceMode}`]()) {
        setSourceLabel(this.sourceMode);
        return;
      }
      // Si un mode non-supporté a été sélectionné, on retombe sur tab
      const fallback = await this.try_tab();
      setSourceLabel(fallback ? 'tab' : '—');
    }

    stop() {
      this.detachers.forEach(fn => { try { fn(); } catch {} });
      this.detachers = [];
      if (this.levelRAF) { cancelAnimationFrame(this.levelRAF); this.levelRAF = null; }
      if (this.tabStream) {
        try { this.tabStream.getTracks().forEach(t => t.stop()); } catch {}
        this.tabStream = null;
      }
      if (this.audioCtx) {
        try { this.audioCtx.close(); } catch {}
        this.audioCtx = null;
      }
      this.tabGain = null; this.tabAnalyser = null;
    }

    cycleSource() {
      // Plus de 'mic' — audio de l'onglet uniquement (+ sous-titres opt-in)
      const order = ['auto', 'tab', 'video', 'youtube', 'netflix', 'vimeo', 'twitch', 'generic'];
      const idx = order.indexOf(this.sourceMode);
      this.sourceMode = order[(idx + 1) % order.length];
      toast('Source : ' + this.sourceMode);
      this.start();
    }

    setTabGain(v) {
      if (this.tabGain) {
        try { this.tabGain.gain.value = Math.max(0, Math.min(4, Number(v) || 1)); } catch {}
      }
    }

    /* --- Capture audio de l'onglet : chrome.tabCapture + Web Audio ---
       Fait DEUX choses :
       1) Reste audible pour l'utilisateur (route vers destination)
       2) Expose un AnalyserNode pour l'indicateur de niveau
       La TRANSCRIPTION, elle, passe par l'entrée audio système
       (webkitSpeechRecognition ne sait pas consommer un stream custom).
       → Pour un usage casque : activer "Stereo Mix" (Win) ou "Loopback" (Mac). */
    async try_tab() {
      try {
        const res = await sendBG({ type: 'GET_TAB_STREAM_ID' });
        if (!res?.ok || !res.streamId) {
          setStatus('capture onglet indisponible (' + (res?.error || 'inconnu') + ')');
          return false;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource:  'tab',
              chromeMediaSourceId: res.streamId,
            }
          },
          video: false,
        });
        this.tabStream = stream;

        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        const src = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        gain.gain.value = 1.0;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;

        // src → gain → destination (audible) ET → analyser (meter)
        src.connect(gain);
        gain.connect(ctx.destination);
        src.connect(analyser);

        this.audioCtx = ctx;
        this.tabGain = gain;
        this.tabAnalyser = analyser;

        this.startLevelMeter();
        setStatus('🎧 audio onglet capturé — amplification active');
        return true;
      } catch (err) {
        console.warn('TU: tab capture failed', err);
        setStatus('capture onglet refusée/indisponible');
        return false;
      }
    }

    startLevelMeter() {
      const meter = widget?.querySelector('.tu-level-bar');
      if (!meter || !this.tabAnalyser) return;
      const buf = new Uint8Array(this.tabAnalyser.frequencyBinCount);
      const loop = () => {
        if (!this.tabAnalyser || !meter.isConnected) return;
        this.tabAnalyser.getByteTimeDomainData(buf);
        // RMS normalisé 0..1
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        const pct = Math.min(100, Math.round(rms * 220)); // amplifie visuellement
        meter.style.width = pct + '%';
        meter.classList.toggle('tu-level-hot', pct > 75);
        this.levelRAF = requestAnimationFrame(loop);
      };
      this.levelRAF = requestAnimationFrame(loop);
    }

    /* --- Tracks HTML5 natifs --- */
    try_video() {
      const videos = Array.from(document.querySelectorAll('video'));
      let activated = false;
      for (const v of videos) {
        const tracks = v.textTracks;
        if (!tracks || tracks.length === 0) continue;
        for (let i = 0; i < tracks.length; i++) {
          const tr = tracks[i];
          if (tr.kind !== 'captions' && tr.kind !== 'subtitles') continue;
          try { tr.mode = 'hidden'; } catch {}
          const onCue = () => {
            const cue = tr.activeCues?.[0];
            if (!cue) return;
            const text = (cue.text || '').replace(/<[^>]+>/g, '').trim();
            if (text) this.handleCaption(text, tr.language || 'en');
          };
          tr.addEventListener('cuechange', onCue);
          this.detachers.push(() => tr.removeEventListener('cuechange', onCue));
          activated = true;
        }
      }
      if (activated) { setStatus('sous-titres vidéo détectés'); return true; }
      return false;
    }

    /* --- YouTube --- */
    try_youtube() {
      if (!/(^|\.)youtube\.com$/.test(location.hostname)) return false;
      return this._attachDomCaptions(
        () => document.querySelector('.ytp-caption-window-container') || document.querySelector('.caption-window'),
        '.ytp-caption-segment, .captions-text span',
        'sous-titres YouTube actifs',
        'en attente des sous-titres YouTube… (activez les CC)'
      );
    }

    /* --- Netflix --- */
    try_netflix() {
      if (!/(^|\.)netflix\.com$/.test(location.hostname)) return false;
      return this._attachDomCaptions(
        () => document.querySelector('.player-timedtext'),
        '.player-timedtext-text-container span, .player-timedtext span',
        'sous-titres Netflix actifs',
        'activez les sous-titres Netflix…'
      );
    }

    /* --- Vimeo --- */
    try_vimeo() {
      if (!/(^|\.)vimeo\.com$/.test(location.hostname)) return false;
      return this._attachDomCaptions(
        () => document.querySelector('.vp-captions') || document.querySelector('[class*="CaptionsRenderer"]'),
        '.vp-captions-line, .vp-captions span, [class*="CaptionsRenderer"] span',
        'sous-titres Vimeo actifs',
        'activez les CC Vimeo…'
      );
    }

    /* --- Twitch --- */
    try_twitch() {
      if (!/(^|\.)twitch\.tv$/.test(location.hostname)) return false;
      return this._attachDomCaptions(
        () => document.querySelector('.player-captions-container') || document.querySelector('.tw-captions'),
        '.player-captions-container span, .player-captions-container p',
        'sous-titres Twitch actifs',
        'activez les CC Twitch…'
      );
    }

    /* --- Players génériques (video.js, Shaka, JW, Plyr) --- */
    try_generic() {
      const selectors = [
        '.vjs-text-track-display',              // video.js
        '.shaka-text-container',                // Shaka Player
        '.jw-captions',                         // JW Player
        '.plyr__captions',                      // Plyr
        '[aria-label="captions"]',
      ];
      for (const sel of selectors) {
        const n = document.querySelector(sel);
        if (n) {
          return this._attachDomCaptions(
            () => document.querySelector(sel),
            sel + ' div, ' + sel + ' span, ' + sel + ' p',
            'sous-titres détectés (' + sel + ')',
            null
          );
        }
      }
      return false;
    }

    /* Helper mutualisé */
    _attachDomCaptions(getContainer, innerSel, activeMsg, waitingMsg) {
      const attach = (container) => {
        let lastEmit = '';
        const emit = () => {
          const segs = container.querySelectorAll(innerSel);
          const text = Array.from(segs).map(s => s.textContent).join(' ').replace(/\s+/g, ' ').trim();
          if (text && text !== lastEmit) {
            lastEmit = text;
            this.handleCaption(text, 'auto');
          }
        };
        const mo = new MutationObserver(emit);
        mo.observe(container, { childList: true, subtree: true, characterData: true });
        this.detachers.push(() => mo.disconnect());
        emit();
      };

      const existing = getContainer();
      if (existing) { attach(existing); setStatus(activeMsg); return true; }
      if (!waitingMsg) return false;

      const rootObs = new MutationObserver(() => {
        const c = getContainer();
        if (c) { attach(c); setStatus(activeMsg); rootObs.disconnect(); }
      });
      rootObs.observe(document.body, { childList: true, subtree: true });
      this.detachers.push(() => rootObs.disconnect());
      setStatus(waitingMsg);
      return true;
    }

    /* Micro volontairement supprimé — capture onglet uniquement. */

    async handleCaption(rawText, sourceLang) {
      if (this.paused) return;
      const text = rawText.replace(/\s+/g, ' ').trim();
      if (!text || text === this.lastText) return;
      this.lastText = text;

      setOrig(text, sourceLang);
      setTrad('…', state.langTo);

      try {
        const { translated, detected } = await apiTranslate(text, state.langFrom || 'auto', state.langTo || 'fr');
        if (text !== this.lastText) return; // dépassé par un plus récent
        setOrig(text, detected || sourceLang);
        setTrad(translated || '—', state.langTo);
        this.log.push({
          t: new Date().toISOString().slice(11, 19),
          ms: Date.now(),
          src: text,
          trad: translated || '',
          lang: detected || sourceLang || '',
        });
        if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
        renderHistoryList();
      } catch {
        setTrad('⚠️ traduction indisponible', state.langTo);
      }
    }
  }

  let audioStarting = false;
  async function startAudio() {
    // Idempotent : si le widget tourne déjà, on ne relance pas
    if (audioStarting) return;
    if (widget && subtitleEngine) return;
    audioStarting = true;
    try {
      await loadWidgetState();
      buildWidget();
      clampWidgetToViewport();
      if (!subtitleEngine) subtitleEngine = new SubtitleEngine();
      await subtitleEngine.start();
      subtitleEngine.setTabGain(widgetUI.tabGain ?? 1.0);
      window.addEventListener('resize', clampWidgetToViewport, { passive: true });
    } catch (err) {
      console.warn('TU: startAudio failed', err);
      // Ne laisse PAS l'utilisateur sans widget
      if (!widget) buildWidget();
      setStatus('⚠️ erreur audio : ' + (err?.message || err));
    } finally {
      audioStarting = false;
    }
  }
  function clampWidgetToViewport() {
    if (!widget) return;
    const r = widget.getBoundingClientRect();
    // Si le widget est partiellement ou totalement hors écran, on le repose en bas-droite
    const outRight  = r.left > window.innerWidth  - 20;
    const outBottom = r.top  > window.innerHeight - 20;
    const outLeft   = r.right < 20;
    const outTop    = r.bottom < 20;
    if (outRight || outBottom || outLeft || outTop) {
      widget.style.left = 'auto';
      widget.style.top  = 'auto';
      widget.style.right = '24px';
      widget.style.bottom = '24px';
      saveWidgetState({ left: null, top: null });
      return;
    }
    const maxLeft = window.innerWidth  - widget.offsetWidth  - 8;
    const maxTop  = window.innerHeight - widget.offsetHeight - 8;
    let changed = false;
    if (r.left > maxLeft) { widget.style.left = Math.max(8, maxLeft) + 'px'; changed = true; }
    if (r.top  > maxTop)  { widget.style.top  = Math.max(8, maxTop)  + 'px'; changed = true; }
    if (changed) saveWidgetState({ left: parseInt(widget.style.left, 10), top: parseInt(widget.style.top, 10) });
  }
  function stopAudio() {
    if (subtitleEngine) { subtitleEngine.stop(); subtitleEngine = null; }
    removeEl(widget); widget = null;
    window.removeEventListener('resize', clampWidgetToViewport);
  }

  /* =========================================================
     Apply settings
     ========================================================= */
  function applyState() {
    if (state.audio) startAudio();
    else stopAudio();

    if (state.qcm) startQcmAuto();
    else stopQcmAuto();

    if (!state.selection) hideTooltip();
  }

  /* =========================================================
     Messaging
     ========================================================= */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'SETTINGS_UPDATED') {
      Object.assign(state, msg.settings || {});
      applyState();
      return;
    }
    if (msg.type === 'CTX_TRANSLATE_SELECTION') {
      state.selection = true;
      showTooltipForSelection();
      return;
    }
    if (msg.type === 'CTX_TRANSLATE_QCM' || msg.type === 'RUN_QCM') {
      translateQcm()
        .then(count => { try { sendResponse({ ok: true, count: count || 0 }); } catch {} })
        .catch(err => { try { sendResponse({ ok: false, error: err.message }); } catch {} });
      return true; // async response
    }
    if (msg.type === 'CTX_START_AUDIO') {
      state.audio = true;
      startAudio();
      toast('Écoute audio activée');
      return;
    }
    if (msg.type === 'CLEAR_CACHE') {
      try { QCM_CACHE.clear(); QCM_MISS.clear(); } catch {}
      try { chrome.storage.local.remove(PERSIST_KEY); } catch {}
      toast('Cache vidé');
      return;
    }
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
