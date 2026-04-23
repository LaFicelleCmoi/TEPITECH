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
    audio: true,
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
     - Détection multi-stratégies (inputs, ARIA, listes, frameworks)
     - Détection de la question associée
     - Cache local + parallélisation
     ========================================================= */
  const TRAD_CLASS   = 'tu-trad-inline';
  const TRAD_Q_CLASS = 'tu-trad-question';
  const QCM_CACHE = new Map();

  async function cachedTranslate(text, from, to) {
    const key = (from || 'auto') + '|' + (to || 'fr') + '|' + text.trim();
    if (QCM_CACHE.has(key)) return QCM_CACHE.get(key);
    try {
      const r = await apiTranslate(text, from, to);
      QCM_CACHE.set(key, r);
      return r;
    } catch { return null; }
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

  async function translateQcm() {
    if (qcmRunning) return 0;
    qcmRunning = true;

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

      // "Sniff" : traduis le plus long job d'abord pour détecter la langue.
      const sniff = jobs.slice().sort((a, b) => b.text.length - a.text.length)[0];
      const sniffRes = await cachedTranslate(sniff.text, from, to);
      if (sniffRes && sniffRes.detected && sniffRes.detected === to) {
        return 0;
      }

      // Traduction parallèle avec cache
      await runParallel(jobs, 4, async (job) => {
        const r = await cachedTranslate(job.text, from, to);
        if (!r || !r.translated) return;
        if (sameText(r.translated, job.text)) return;
        if (r.detected && r.detected === to) return;

        if (job.type === 'sentence') {
          // Évite d'injecter deux fois
          if (job.afterNode.nextSibling &&
              job.afterNode.nextSibling.nodeType === 1 &&
              job.afterNode.nextSibling.classList?.contains(TRAD_Q_CLASS)) return;
          const span = document.createElement('span');
          span.className = TRAD_Q_CLASS;
          span.textContent = r.translated;
          job.afterNode.after(span);
        } else if (job.type === 'select-option') {
          // Les <option> ne peuvent contenir que du texte :
          // on concatène la traduction au texte affiché (le value reste intact).
          const original = (job.node.dataset.tuOriginal || job.node.text || '').trim();
          if (!job.node.dataset.tuOriginal) job.node.dataset.tuOriginal = original;
          job.node.text = original + '  —  ' + r.translated;
        } else {
          injectTranslation(job.node, r.translated, job.type);
        }
        job.node.dataset.tuTranslated = '1';
      });

      const count = jobs.filter(j => j.node.dataset.tuTranslated === '1').length;
      if (count > 0) {
        toast('🌐 ' + count + ' élément' + (count > 1 ? 's' : '') + ' traduit' + (count > 1 ? 's' : ''));
      }
      return count;
    } finally {
      qcmRunning = false;
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
  }

  /* =========================================================
     3. AUDIO WIDGET — sous-titres réels
     ========================================================= */
  let widget = null;
  let subtitleEngine = null;

  function buildWidget() {
    if (widget) return widget;
    widget = el('div', `${TU_ROOT_CLASS} tu-audio tu-glass`);
    widget.innerHTML = `
      <div class="tu-head">
        <div class="tu-title">
          <span class="tu-rec-dot"></span>
          <strong>Live Subtitles</strong>
          <span class="tu-muted tu-small tu-status">en attente…</span>
        </div>
        <div class="tu-head-btns">
          <button class="tu-mini-btn tu-btn-min"   title="Réduire">—</button>
          <button class="tu-mini-btn tu-btn-close" title="Fermer">✕</button>
        </div>
      </div>
      <div class="tu-body">
        <div class="tu-line">
          <span class="tu-flag tu-flag-src">🌍</span>
          <span class="tu-muted tu-small">Original</span>
          <p class="tu-orig tu-muted">En attente d'une source audio…</p>
        </div>
        <div class="tu-divider"></div>
        <div class="tu-line">
          <span class="tu-flag tu-flag-tgt">🇫🇷</span>
          <span class="tu-muted tu-small">Traduction</span>
          <p class="tu-trad tu-muted">—</p>
        </div>
      </div>
      <div class="tu-foot">
        <button class="tu-mini-btn tu-btn-source" title="Changer la source">📡 Source</button>
        <button class="tu-mini-btn tu-btn-pause">⏸️ Pause</button>
        <button class="tu-mini-btn tu-btn-export">💾 Export</button>
      </div>
    `;
    document.documentElement.appendChild(widget);

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
      widget.style.left   = Math.min(Math.max(8, x), window.innerWidth  - widget.offsetWidth  - 8) + 'px';
      widget.style.top    = Math.min(Math.max(8, y), window.innerHeight - widget.offsetHeight - 8) + 'px';
      widget.style.right  = 'auto'; widget.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { drag = null; });

    widget.querySelector('.tu-btn-min').addEventListener('click', () => widget.classList.toggle('tu-min'));
    widget.querySelector('.tu-btn-close').addEventListener('click', () => {
      stopAudio();
      chrome.storage.sync.set({ audio: false });
    });

    let paused = false;
    const pauseBtn = widget.querySelector('.tu-btn-pause');
    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? '▶️ Reprendre' : '⏸️ Pause';
      if (subtitleEngine) subtitleEngine.paused = paused;
    });

    widget.querySelector('.tu-btn-source').addEventListener('click', () => {
      if (!subtitleEngine) return;
      subtitleEngine.cycleSource();
    });

    widget.querySelector('.tu-btn-export').addEventListener('click', () => {
      const log = subtitleEngine?.log || [];
      const txt = log.map(e => `[${e.t}]\n${e.src}\n→ ${e.trad}\n`).join('\n');
      const blob = new Blob([txt || '(aucun sous-titre)'], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = el('a'); a.href = url; a.download = 'subtitles.txt'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Export téléchargé');
    });

    return widget;
  }

  function setStatus(txt) {
    const s = widget?.querySelector('.tu-status'); if (s) s.textContent = txt;
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
     SubtitleEngine — captures réelles
     ========================================================= */
  class SubtitleEngine {
    constructor() {
      this.log = [];
      this.paused = false;
      this.lastText = '';
      this.sourceMode = 'auto'; // 'auto' | 'video' | 'youtube' | 'mic'
      this.detachers = [];
      this.detectedLang = state.langFrom !== 'auto' ? state.langFrom : 'en';
    }

    start() {
      this.stop();
      // Essai par priorité : vidéo → YouTube → micro
      if (this.tryVideoTracks()) return;
      if (this.tryYouTubeCaptions()) return;
      this.startMicRecognition();
    }

    stop() {
      this.detachers.forEach(fn => { try { fn(); } catch {} });
      this.detachers = [];
      if (this.recognition) {
        try { this.recognition.onend = null; this.recognition.stop(); } catch {}
        this.recognition = null;
      }
    }

    cycleSource() {
      const order = ['auto', 'video', 'youtube', 'mic'];
      const idx = order.indexOf(this.sourceMode);
      this.sourceMode = order[(idx + 1) % order.length];
      toast('Source : ' + this.sourceMode);
      this.start();
    }

    tryVideoTracks() {
      if (this.sourceMode !== 'auto' && this.sourceMode !== 'video') return false;
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
      if (activated) {
        setStatus('sous-titres vidéo détectés');
        return true;
      }
      return false;
    }

    tryYouTubeCaptions() {
      if (this.sourceMode !== 'auto' && this.sourceMode !== 'youtube') return false;
      if (!/(^|\.)youtube\.com$/.test(location.hostname)) return false;

      const getContainer = () => document.querySelector('.ytp-caption-window-container')
                              || document.querySelector('.caption-window');

      const attach = (container) => {
        const mo = new MutationObserver(() => {
          const segs = container.querySelectorAll('.ytp-caption-segment, .captions-text span');
          const text = Array.from(segs).map(s => s.textContent).join(' ').trim();
          if (text) this.handleCaption(text, 'auto');
        });
        mo.observe(container, { childList: true, subtree: true, characterData: true });
        this.detachers.push(() => mo.disconnect());
      };

      const existing = getContainer();
      if (existing) {
        attach(existing);
        setStatus('sous-titres YouTube actifs');
        return true;
      }

      // Attend l'apparition du conteneur (ex: CC activé après coup)
      const rootObs = new MutationObserver(() => {
        const c = getContainer();
        if (c) {
          attach(c);
          setStatus('sous-titres YouTube actifs');
          rootObs.disconnect();
        }
      });
      rootObs.observe(document.body, { childList: true, subtree: true });
      this.detachers.push(() => rootObs.disconnect());
      setStatus('en attente des sous-titres YouTube… (activez les CC)');
      return true;
    }

    startMicRecognition() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) {
        setStatus('reconnaissance vocale non supportée');
        setOrig('⚠️ Votre navigateur ne supporte pas SpeechRecognition.', 'auto');
        return;
      }
      const r = new SR();
      r.continuous = true;
      r.interimResults = true;
      r.lang = SPEECH_LANG[state.langFrom] || 'en-US';

      let lastFinal = '';
      r.onresult = (e) => {
        let interim = '', final = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) final += res[0].transcript;
          else interim += res[0].transcript;
        }
        const text = (final || interim).trim();
        if (!text) return;
        if (final && final !== lastFinal) {
          lastFinal = final;
          this.handleCaption(final.trim(), state.langFrom === 'auto' ? 'en' : state.langFrom);
        } else if (interim) {
          setOrig(text + ' …', state.langFrom === 'auto' ? 'en' : state.langFrom);
        }
      };
      r.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          setStatus('micro refusé');
          setOrig('⚠️ Autorisez le microphone pour la capture audio.', 'auto');
        } else {
          setStatus('erreur : ' + e.error);
        }
      };
      r.onend = () => {
        // Relance automatique tant que l'audio est actif
        if (state.audio && !this.paused) {
          try { r.start(); } catch {}
        }
      };
      try {
        r.start();
        setStatus('🎙️ micro actif');
        setOrig('Parlez ou laissez la vidéo jouer près du micro…', 'auto');
      } catch (err) {
        setStatus('impossible de démarrer');
      }
      this.recognition = r;
    }

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
          src: text,
          trad: translated || '',
        });
        if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
      } catch {
        setTrad('⚠️ traduction indisponible', state.langTo);
      }
    }
  }

  function startAudio() {
    buildWidget();
    if (!subtitleEngine) subtitleEngine = new SubtitleEngine();
    subtitleEngine.start();
  }
  function stopAudio() {
    if (subtitleEngine) { subtitleEngine.stop(); subtitleEngine = null; }
    removeEl(widget); widget = null;
  }

  /* =========================================================
     Apply settings
     ========================================================= */
  function applyState() {
    if (state.audio) startAudio();
    else stopAudio();

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
      try { QCM_CACHE.clear(); } catch {}
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
