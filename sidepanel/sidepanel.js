/* =========================================================
   Side panel — Traducteur Universel
   - Traduction rapide (textarea → résultat)
   - Capture de la sélection courante de l'onglet actif
   - Reçoit le texte du clic-droit "Traduire dans le side panel"
   - Historique de session (in-memory + chrome.storage.session)
   - Guide Live Caption + bouton copier l'URL des réglages
   ========================================================= */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SESSION_KEY = 'spPendingText';
  const HIST_KEY    = 'spHistorySession';

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
  async function apiTranslate(text, from, to) {
    const res = await sendBG({ type: 'TRANSLATE', text, from, to });
    if (!res?.ok) throw new Error(res?.error || 'Traduction indisponible');
    return res;
  }

  /* ---------- Domain pill ---------- */
  async function updateDomainPill() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) { $('spDomain').textContent = '—'; return; }
      const u = new URL(tab.url);
      $('spDomain').textContent = u.hostname.replace(/^www\./, '') || '—';
    } catch {
      $('spDomain').textContent = '—';
    }
  }
  // L'onglet actif change → on met à jour le pill
  chrome.tabs.onActivated.addListener(updateDomainPill);
  chrome.tabs.onUpdated.addListener((_, info) => {
    if (info.url) updateDomainPill();
  });

  /* ---------- History (session-only, persiste tant que l'extension tourne) ---------- */
  let history = [];

  async function loadHistory() {
    try {
      const s = await chrome.storage.session.get(HIST_KEY);
      history = Array.isArray(s[HIST_KEY]) ? s[HIST_KEY] : [];
    } catch { history = []; }
    renderHistory();
  }
  async function saveHistory() {
    try { await chrome.storage.session.set({ [HIST_KEY]: history }); } catch {}
  }
  function pushHistory(entry) {
    // Déduplication : si la dernière entrée est identique, on n'ajoute pas
    const head = history[0];
    if (!head || head.text !== entry.text || head.to !== entry.to) {
      history.unshift({ ...entry, at: Date.now() });
      if (history.length > 50) history.length = 50;
      saveHistory();
      renderHistory();
    }
  }
  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  let historyFilter = '';
  function renderHistory() {
    const el = $('spHistory');
    const q = historyFilter.toLowerCase();
    const filtered = q
      ? history.filter(h => (h.text + ' ' + h.translated).toLowerCase().includes(q))
      : history;
    if (!filtered.length) {
      el.innerHTML = '<p class="sp-muted sp-small">' +
        (q ? 'Aucun résultat pour « ' + escapeHtml(q) + ' ».' : 'Aucune traduction encore.') +
        '</p>';
      return;
    }
    el.innerHTML = '';
    filtered.forEach((h) => {
      // Récupère l'index réel dans `history` pour le delete
      const realIdx = history.indexOf(h);
      const div = document.createElement('div');
      div.className = 'sp-hist-item';
      div.innerHTML = `
        <div class="sp-hist-src">${escapeHtml(h.text)}</div>
        <div class="sp-hist-tgt">→ ${escapeHtml(h.translated)}</div>
        <button class="sp-hist-del" data-i="${realIdx}" title="Supprimer">✕</button>
      `;
      div.addEventListener('click', (e) => {
        if (e.target.closest('.sp-hist-del')) {
          e.stopPropagation();
          if (realIdx >= 0) {
            history.splice(realIdx, 1);
            saveHistory();
            renderHistory();
          }
          return;
        }
        $('spSrc').value = h.text;
        if (h.from && h.from !== 'auto') $('spLangFrom').value = h.from;
        if (h.to)                        $('spLangTo').value   = h.to;
        doTranslate(h.text);
      });
      el.appendChild(div);
    });
  }

  /* ---------- Export historique ---------- */
  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }
  function csvEscape(s) {
    const v = String(s == null ? '' : s);
    if (/["\n,;]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }
  function exportCSV() {
    if (!history.length) { flash($('spExportHist'), '∅'); return; }
    const rows = [['date', 'source', 'cible', 'texte', 'traduction']];
    for (const h of history) {
      const d = new Date(h.at || Date.now()).toISOString();
      rows.push([d, h.from || '', h.to || '', h.text || '', h.translated || '']);
    }
    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob('﻿' + csv, `tu-historique-${stamp}.csv`, 'text/csv;charset=utf-8');
    flash($('spExportHist'), '✅');
  }
  function exportAnki() {
    if (!history.length) { flash($('spExportAnki'), '∅'); return; }
    // Format Anki TSV : recto<TAB>verso (tagué pour import direct)
    const lines = history.map(h => `${(h.text || '').replace(/\t/g, ' ')}\t${(h.translated || '').replace(/\t/g, ' ')}\ttepitech-${h.from || 'auto'}-${h.to || 'fr'}`);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(lines.join('\n'), `tu-anki-${stamp}.tsv`, 'text/tab-separated-values;charset=utf-8');
    flash($('spExportAnki'), '✅');
  }

  /* ---------- Translate ---------- */
  let translateSeq = 0;

  async function doTranslate(forceText) {
    const text = (forceText !== undefined ? forceText : $('spSrc').value).trim();
    if (!text) {
      $('spResult').textContent = '—';
      $('spResult').classList.add('muted');
      return;
    }
    const from = $('spLangFrom').value;
    const to   = $('spLangTo').value;
    const seq = ++translateSeq;

    $('spResult').textContent = '…';
    $('spResult').classList.add('muted');

    try {
      const r = await apiTranslate(text, from, to);
      if (seq !== translateSeq) return;
      $('spResult').textContent = r.translated || '—';
      $('spResult').classList.remove('muted');
      pushHistory({
        text,
        translated: r.translated || '',
        from: r.detected || from,
        to,
      });
      // Sauvegarde lang prefs
      chrome.storage.sync.set({ langFrom: from, langTo: to }).catch(() => {});
    } catch (err) {
      if (seq !== translateSeq) return;
      $('spResult').textContent = '⚠️ ' + (err.message || 'Erreur');
      $('spResult').classList.remove('muted');
    }
  }

  /* ---------- Wire UI ---------- */
  $('spTranslate').addEventListener('click', () => doTranslate());
  $('spSrc').addEventListener('input', () => {
    clearTimeout($('spSrc')._t);
    $('spSrc')._t = setTimeout(() => doTranslate(), 600);
  });
  $('spSrc').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      doTranslate();
    }
  });

  $('spLangFrom').addEventListener('change', () => doTranslate());
  $('spLangTo')  .addEventListener('change', () => doTranslate());

  $('spSwap').addEventListener('click', () => {
    if ($('spLangFrom').value === 'auto') return;
    const a = $('spLangFrom').value, b = $('spLangTo').value;
    $('spLangFrom').value = b;
    $('spLangTo').value   = a;
    if ($('spSrc').value.trim()) doTranslate();
  });

  $('spSpeak').addEventListener('click', () => {
    const txt = $('spResult').textContent;
    if (!txt || txt === '—' || txt.startsWith('⚠️')) return;
    const TTS = {
      fr: 'fr-FR', en: 'en-US', es: 'es-ES', de: 'de-DE', it: 'it-IT',
      ja: 'ja-JP', zh: 'zh-CN', ru: 'ru-RU', pt: 'pt-PT', ar: 'ar-SA', ko: 'ko-KR',
    };
    sendBG({ type: 'TTS_SPEAK', text: txt, lang: TTS[$('spLangTo').value] || 'fr-FR' });
  });

  $('spCopy').addEventListener('click', async () => {
    const txt = $('spResult').textContent;
    if (!txt || txt === '—' || txt.startsWith('⚠️')) return;
    try { await navigator.clipboard.writeText(txt); flash($('spCopy'), '✅'); }
    catch { flash($('spCopy'), '⚠️'); }
  });

  $('spClear').addEventListener('click', () => {
    $('spSrc').value = '';
    $('spResult').textContent = '—';
    $('spResult').classList.add('muted');
    $('spSrc').focus();
  });

  $('spClearHist').addEventListener('click', () => {
    if (!history.length) return;
    if (!confirm('Vider tout l\'historique de session ?')) return;
    history = [];
    saveHistory();
    renderHistory();
  });
  $('spExportHist').addEventListener('click', exportCSV);
  $('spExportAnki').addEventListener('click', exportAnki);
  $('spHistSearch').addEventListener('input', (e) => {
    historyFilter = e.target.value || '';
    renderHistory();
  });

  /* ---------- Coller depuis le presse-papier ---------- */
  $('spPaste').addEventListener('click', async () => {
    try {
      const txt = await navigator.clipboard.readText();
      if (txt && txt.trim()) {
        $('spSrc').value = txt;
        doTranslate(txt);
      } else {
        flash($('spPaste'), '∅');
      }
    } catch {
      flash($('spPaste'), '⚠️');
    }
  });

  /* ---------- Saisie vocale (Web Speech API) ---------- */
  let recognition = null;
  function getRecognitionLang() {
    const TO_LOCALE = {
      en: 'en-US', fr: 'fr-FR', es: 'es-ES', de: 'de-DE', it: 'it-IT',
      ja: 'ja-JP', zh: 'zh-CN', ru: 'ru-RU', pt: 'pt-PT', ar: 'ar-SA', ko: 'ko-KR',
    };
    const from = $('spLangFrom').value;
    if (from && from !== 'auto') return TO_LOCALE[from] || 'en-US';
    // En auto : on devine selon la langue de l'OS
    return navigator.language || 'en-US';
  }
  $('spMic').addEventListener('click', () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { flash($('spMic'), '🚫'); return; }
    if (recognition) {
      try { recognition.stop(); } catch {}
      recognition = null;
      $('spMic').classList.remove('is-recording');
      return;
    }
    recognition = new SR();
    recognition.lang = getRecognitionLang();
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    let finalText = '';
    recognition.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      $('spSrc').value = (finalText + ' ' + interim).trim();
    };
    recognition.onerror = (ev) => {
      console.warn('[TU sidepanel] speech error', ev.error);
      $('spMic').classList.remove('is-recording');
      flash($('spMic'), '⚠️');
      recognition = null;
    };
    recognition.onend = () => {
      $('spMic').classList.remove('is-recording');
      recognition = null;
      if ($('spSrc').value.trim()) doTranslate();
    };
    try {
      recognition.start();
      $('spMic').classList.add('is-recording');
    } catch (err) {
      console.warn('[TU sidepanel] cannot start recognition', err);
      flash($('spMic'), '⚠️');
      recognition = null;
    }
  });

  $('spGetSelection').addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) { flash($('spGetSelection'), '⚠️ Pas d\'onglet'); return; }
      // Pages restreintes (chrome://, etc.) n'autorisent pas executeScript
      if (/^(chrome|edge|about|chrome-extension|view-source|devtools):/i.test(tab.url || '')) {
        flash($('spGetSelection'), '🚫 Page système');
        return;
      }
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => (window.getSelection()?.toString() || '').trim(),
      });
      const sel = r?.result || '';
      if (!sel) { flash($('spGetSelection'), '⚠️ Aucune sélection'); return; }
      $('spSrc').value = sel;
      doTranslate(sel);
    } catch {
      flash($('spGetSelection'), '⚠️ Erreur');
    }
  });

  /* Détection du navigateur pour copier le bon schéma d'URL.
     Brave / Edge / Opera / Vivaldi sont basés sur Chromium et ont chacun leur
     propre préfixe (`brave://`, `edge://`, …). */
  async function detectBrowser() {
    try {
      if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
        const b = await navigator.brave.isBrave();
        if (b) return { name: 'Brave', scheme: 'brave', emoji: '🦁' };
      }
    } catch {}
    const ua = navigator.userAgent || '';
    if (/Edg\//.test(ua))                  return { name: 'Edge',    scheme: 'edge',    emoji: '🔵' };
    if (/OPR\/|Opera/.test(ua))            return { name: 'Opera',   scheme: 'opera',   emoji: '🔴' };
    if (/Vivaldi/.test(ua))                return { name: 'Vivaldi', scheme: 'vivaldi', emoji: '🟠' };
    return { name: 'Chrome', scheme: 'chrome', emoji: '🟢' };
  }

  // Affiche le navigateur détecté + adapte l'URL d'aide
  detectBrowser().then(b => {
    const url = b.scheme + '://settings/accessibility';
    const badge = $('spBrowserBadge');
    const lcUrl = $('spLcUrl');
    if (badge) badge.textContent = b.emoji + ' ' + b.name;
    if (lcUrl) lcUrl.textContent = url;
  }).catch(() => {});

  $('spCopyAccess').addEventListener('click', async () => {
    const b = await detectBrowser();
    const url = b.scheme + '://settings/accessibility';
    try {
      await navigator.clipboard.writeText(url);
      flash($('spCopyAccess'), '✅ Copié pour ' + b.name + ' — colle dans la barre', 2400);
    } catch {
      flash($('spCopyAccess'), '⚠️ Copie refusée — ouvre ' + url + ' manuellement', 3200);
    }
  });

  function flash(btn, label, dur = 1400) {
    const orig = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, dur);
  }

  /* ---------- Réception clic-droit "Traduire dans le side panel" ---------- */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'SIDEPANEL_TRANSLATE_SELECTION' && typeof msg.text === 'string' && msg.text) {
      $('spSrc').value = msg.text;
      doTranslate(msg.text);
      try { sendResponse({ ok: true }); } catch {}
    }
    return false;
  });

  /* ---------- Init ---------- */
  (async () => {
    // Lang prefs depuis le storage sync
    try {
      const s = await chrome.storage.sync.get({ langFrom: 'auto', langTo: 'fr' });
      $('spLangFrom').value = s.langFrom || 'auto';
      $('spLangTo').value   = s.langTo   || 'fr';
    } catch {}

    await loadHistory();
    await updateDomainPill();

    // Si une traduction a été déposée dans storage.session par le contexte menu
    // (avant que le side panel ne soit prêt à recevoir un message), on la consomme
    try {
      const s = await chrome.storage.session.get(SESSION_KEY);
      const pending = s?.[SESSION_KEY];
      if (pending && typeof pending === 'string') {
        $('spSrc').value = pending;
        doTranslate(pending);
        await chrome.storage.session.remove(SESSION_KEY);
      }
    } catch {}

    $('spSrc').focus();
  })();
})();
