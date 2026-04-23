/* =========================================================
   Traducteur Universel — Popup logic
   - Traduction rapide (API réelle)
   - Panels Paramètres & Profil
   - Historique, favoris, statistiques
   ========================================================= */

(() => {
  'use strict';

  const SYNC_DEFAULTS = {
    selection: true,
    qcm: false,
    audio: false,
    langFrom: 'auto',
    langTo: 'fr',
    hoverDelay: 450,
    ttsRate: 1.0,
    history: true,
    avatar: '👤',
    displayName: '',
  };

  const LOCAL_DEFAULTS = {
    installedAt: 0,
    totalTranslations: 0,
    langStats: {},
    history: [],
    favorites: [],
  };

  const LANG_LABEL = {
    auto: 'Auto', en: 'Anglais', fr: 'Français', es: 'Espagnol',
    de: 'Allemand', it: 'Italien', pt: 'Portugais', ja: 'Japonais',
    zh: 'Chinois', ru: 'Russe', ar: 'Arabe', ko: 'Coréen',
  };
  const TTS_LANG = {
    fr: 'fr-FR', en: 'en-US', es: 'es-ES', de: 'de-DE',
    it: 'it-IT', ja: 'ja-JP', zh: 'zh-CN', ru: 'ru-RU',
    pt: 'pt-PT', ar: 'ar-SA', ko: 'ko-KR',
  };

  const $ = (id) => document.getElementById(id);

  const el = {
    // Main
    domain:     $('domainPill'),
    tgSelection:$('tgSelection'),
    tgQcm:      $('tgQcm'),
    btnQcm:     $('btnQcm'),
    tgAudio:    $('tgAudio'),
    btnAudio:   $('btnAudio'),
    langFrom:   $('langFrom'),
    langTo:     $('langTo'),
    swap:       $('swapLang'),
    src:        $('srcText'),
    result:     $('resultText'),
    btnT:       $('translateBtn'),
    btnCopy:    $('copyBtn'),
    btnListen:  $('listenBtn'),
    btnFav:     $('btnFav'),
    btnSettings:$('btnSettings'),
    btnProfile: $('btnProfile'),
    mainView:   $('mainView'),
    settingsView: $('settingsView'),
    profileView:  $('profileView'),

    // Settings
    settLangFrom:   $('settLangFrom'),
    settLangTo:     $('settLangTo'),
    settSelection:  $('settSelection'),
    settHoverDelay: $('settHoverDelay'),
    settHoverVal:   $('settHoverVal'),
    settTtsRate:    $('settTtsRate'),
    settTtsVal:     $('settTtsVal'),
    settHistory:    $('settHistory'),
    btnClearHistory:$('btnClearHistory'),
    btnClearCache:  $('btnClearCache'),
    btnResetAll:    $('btnResetAll'),

    // Profile
    profileAvatar: $('profileAvatar'),
    profileName:   $('profileName'),
    avatarPicker:  $('avatarPicker'),
    statTotal:     $('statTotal'),
    statLang:      $('statLang'),
    statDays:      $('statDays'),
    historyCount:  $('historyCount'),
    favoritesCount:$('favoritesCount'),
    historyList:   $('historyList'),
    favoritesList: $('favoritesList'),
  };

  /* ---------- Messaging ---------- */
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

  /* ---------- Active tab ---------- */
  async function getActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    } catch { return null; }
  }
  async function updateDomainPill() {
    const tab = await getActiveTab();
    if (!tab || !tab.url) { el.domain.textContent = '—'; return; }
    try {
      const u = new URL(tab.url);
      el.domain.textContent = u.hostname.replace(/^www\./, '') || '—';
    } catch { el.domain.textContent = '—'; }
  }

  /* ---------- Storage helpers ---------- */
  async function loadSync() {
    const s = await chrome.storage.sync.get(SYNC_DEFAULTS);
    return { ...SYNC_DEFAULTS, ...s };
  }
  async function saveSync(partial) {
    await chrome.storage.sync.set(partial);
    const tab = await getActiveTab();
    if (tab?.id) {
      try { await chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings: partial }); }
      catch {}
    }
  }
  async function loadLocal() {
    const s = await chrome.storage.local.get(LOCAL_DEFAULTS);
    return { ...LOCAL_DEFAULTS, ...s };
  }

  /* ---------- Panel switching ---------- */
  function showView(id) {
    [el.mainView, el.settingsView, el.profileView].forEach(v => {
      const visible = v.id === id;
      v.classList.toggle('is-visible', visible);
      v.setAttribute('aria-hidden', visible ? 'false' : 'true');
    });
    if (id === 'profileView') {
      renderProfile();
      renderStats();
      renderHistory();
    }
    if (id === 'settingsView') {
      syncSettingsUI();
    }
  }

  el.btnSettings.addEventListener('click', () => showView('settingsView'));
  el.btnProfile .addEventListener('click', () => showView('profileView'));
  document.querySelectorAll('[data-close-panel]').forEach(btn => {
    btn.addEventListener('click', () => showView('mainView'));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') showView('mainView');
  });

  /* =========================================================
     MAIN VIEW : traduction rapide, toggles, QCM
     ========================================================= */

  el.tgSelection.addEventListener('change', () => saveSync({ selection: el.tgSelection.checked }));
  el.tgAudio    .addEventListener('change', () => saveSync({ audio:     el.tgAudio.checked }));
  el.tgQcm      .addEventListener('change', async () => {
    const on = el.tgQcm.checked;
    await saveSync({ qcm: on });
    // Quand on active l'auto, on lance immédiatement un premier scan
    if (on) {
      try {
        const tab = await getActiveTab();
        if (tab?.id) {
          try { await chrome.tabs.sendMessage(tab.id, { type: 'RUN_QCM' }); }
          catch {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
            await chrome.scripting.insertCSS   ({ target: { tabId: tab.id }, files: ['content/content.css'] });
            await chrome.tabs.sendMessage(tab.id, { type: 'RUN_QCM' });
          }
        }
      } catch {}
    }
  });

  el.langFrom.addEventListener('change', () => { saveSync({ langFrom: el.langFrom.value }); doTranslate(); });
  el.langTo  .addEventListener('change', () => { saveSync({ langTo:   el.langTo.value });   doTranslate(); });

  el.swap.addEventListener('click', () => {
    if (el.langFrom.value === 'auto') return;
    const a = el.langFrom.value, b = el.langTo.value;
    el.langFrom.value = b;
    el.langTo.value   = a;
    saveSync({ langFrom: el.langFrom.value, langTo: el.langTo.value });
    if (el.src.value.trim()) doTranslate();
  });

  /* Bouton Audio (action à la demande — garantit un user gesture pour tabCapture) */
  el.btnAudio.addEventListener('click', async () => {
    const original = el.btnAudio.textContent;
    el.btnAudio.disabled = true;
    el.btnAudio.textContent = '⏳ …';
    el.btnAudio.classList.remove('is-success');
    try {
      const tab = await getActiveTab();
      if (!tab?.id) throw new Error('onglet introuvable');
      // Active le flag audio dans le storage (déclenche SETTINGS_UPDATED côté content)
      await saveSync({ audio: true });
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'CTX_START_AUDIO' });
      } catch {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
        await chrome.scripting.insertCSS   ({ target: { tabId: tab.id }, files: ['content/content.css'] });
        await chrome.tabs.sendMessage(tab.id, { type: 'CTX_START_AUDIO' });
      }
      el.btnAudio.classList.add('is-success');
      el.btnAudio.textContent = '✅ Lancé';
      setTimeout(() => window.close(), 400);
    } catch (err) {
      el.btnAudio.textContent = '⚠️ Erreur';
      setTimeout(() => {
        el.btnAudio.textContent = original;
        el.btnAudio.disabled = false;
        el.btnAudio.classList.remove('is-success');
      }, 1600);
    }
  });

  /* Bouton QCM (action à la demande) */
  el.btnQcm.addEventListener('click', async () => {
    const original = el.btnQcm.textContent;
    el.btnQcm.disabled = true;
    el.btnQcm.textContent = '⏳ …';
    el.btnQcm.classList.remove('is-success');
    try {
      const tab = await getActiveTab();
      if (!tab?.id) throw new Error('onglet introuvable');
      let res;
      try {
        res = await chrome.tabs.sendMessage(tab.id, { type: 'RUN_QCM' });
      } catch {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
        await chrome.scripting.insertCSS   ({ target: { tabId: tab.id }, files: ['content/content.css'] });
        res = await chrome.tabs.sendMessage(tab.id, { type: 'RUN_QCM' });
      }
      const n = res?.count || 0;
      el.btnQcm.classList.add('is-success');
      el.btnQcm.textContent = n > 0 ? '✅ ' + n : 'Aucun QCM';
      setTimeout(() => {
        el.btnQcm.textContent = original;
        el.btnQcm.classList.remove('is-success');
        el.btnQcm.disabled = false;
      }, 1800);
    } catch {
      el.btnQcm.textContent = '⚠️ Erreur';
      setTimeout(() => { el.btnQcm.textContent = original; el.btnQcm.disabled = false; }, 1600);
    }
  });

  /* --- Traduction rapide --- */
  let translateSeq = 0;
  let lastTranslation = null; // { text, translated, from, to }

  async function doTranslate() {
    const text = el.src.value.trim();
    if (!text) {
      el.result.textContent = '—';
      el.result.classList.add('muted');
      lastTranslation = null;
      updateFavButton();
      return;
    }
    const seq = ++translateSeq;
    el.result.textContent = '…';
    el.result.classList.add('muted');

    try {
      const { translated, detected } = await apiTranslate(text, el.langFrom.value, el.langTo.value);
      if (seq !== translateSeq) return;
      el.result.classList.remove('muted');
      el.result.textContent = translated || '—';

      if (el.langFrom.value === 'auto' && detected) {
        el.langFrom.title = 'Langue détectée : ' + (LANG_LABEL[detected] || detected.toUpperCase());
      }

      lastTranslation = {
        text,
        translated: translated || '',
        from: detected || el.langFrom.value,
        to: el.langTo.value,
      };
      updateFavButton();
      await recordHistory(lastTranslation);
    } catch (err) {
      if (seq !== translateSeq) return;
      el.result.classList.remove('muted');
      el.result.textContent = '⚠️ ' + (err.message || 'Traduction impossible');
      lastTranslation = null;
      updateFavButton();
    }
  }

  el.btnT.addEventListener('click', doTranslate);
  el.src.addEventListener('input', () => {
    clearTimeout(el.src._t);
    el.src._t = setTimeout(doTranslate, 450);
  });

  el.btnCopy.addEventListener('click', async () => {
    const txt = el.result.textContent || '';
    if (!txt || txt === '—') return;
    try { await navigator.clipboard.writeText(txt); flash(el.btnCopy, '✅ Copié'); }
    catch { flash(el.btnCopy, '❌ Erreur'); }
  });

  el.btnListen.addEventListener('click', async () => {
    const txt = el.result.textContent || '';
    if (!txt || txt === '—' || txt.startsWith('⚠️')) return;
    const lang = TTS_LANG[el.langTo.value] || 'fr-FR';
    const { ttsRate = 1.0 } = await chrome.storage.sync.get(['ttsRate']);
    try { chrome.tts.stop(); chrome.tts.speak(txt, { lang, rate: ttsRate }); flash(el.btnListen, '🔊 Lecture…'); }
    catch {
      try {
        const u = new SpeechSynthesisUtterance(txt);
        u.lang = lang;
        u.rate = ttsRate;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } catch {}
    }
  });

  el.btnFav.addEventListener('click', async () => {
    if (!lastTranslation || !lastTranslation.translated) return;
    await toggleFavorite(lastTranslation);
    updateFavButton();
    flash(el.btnFav, el.btnFav.classList.contains('is-active') ? '★' : '☆');
  });

  async function updateFavButton() {
    if (!lastTranslation) {
      el.btnFav.textContent = '☆';
      el.btnFav.classList.remove('is-active');
      return;
    }
    const { favorites = [] } = await chrome.storage.local.get(['favorites']);
    const isFav = favorites.some(f => f.text === lastTranslation.text && f.to === lastTranslation.to);
    el.btnFav.textContent = isFav ? '★' : '☆';
    el.btnFav.classList.toggle('is-active', isFav);
  }

  function flash(btn, label) {
    const original = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1100);
  }

  /* =========================================================
     SETTINGS
     ========================================================= */
  async function syncSettingsUI() {
    const s = await loadSync();
    el.settLangFrom  .value   = s.langFrom;
    el.settLangTo    .value   = s.langTo;
    el.settSelection .checked = !!s.selection;
    el.settHoverDelay.value   = s.hoverDelay;
    el.settHoverVal  .textContent = s.hoverDelay + ' ms';
    el.settTtsRate   .value   = s.ttsRate;
    el.settTtsVal    .textContent = (+s.ttsRate).toFixed(1) + '×';
    el.settHistory   .checked = s.history !== false;
  }

  el.settLangFrom.addEventListener('change', () => {
    el.langFrom.value = el.settLangFrom.value;
    saveSync({ langFrom: el.settLangFrom.value });
  });
  el.settLangTo.addEventListener('change', () => {
    el.langTo.value = el.settLangTo.value;
    saveSync({ langTo: el.settLangTo.value });
  });
  el.settSelection.addEventListener('change', () => {
    el.tgSelection.checked = el.settSelection.checked;
    saveSync({ selection: el.settSelection.checked });
  });
  el.settHoverDelay.addEventListener('input', () => {
    const v = parseInt(el.settHoverDelay.value, 10);
    el.settHoverVal.textContent = v + ' ms';
    saveSync({ hoverDelay: v });
  });
  el.settTtsRate.addEventListener('input', () => {
    const v = parseFloat(el.settTtsRate.value);
    el.settTtsVal.textContent = v.toFixed(1) + '×';
    saveSync({ ttsRate: v });
  });
  el.settHistory.addEventListener('change', () => {
    saveSync({ history: el.settHistory.checked });
  });

  el.btnClearHistory.addEventListener('click', async () => {
    await chrome.storage.local.set({ history: [], favorites: [], langStats: {}, totalTranslations: 0 });
    flash(el.btnClearHistory, '✅ Effacé');
    renderHistory(); renderStats();
  });
  el.btnClearCache.addEventListener('click', async () => {
    try {
      const tab = await getActiveTab();
      if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_CACHE' });
    } catch {}
    flash(el.btnClearCache, '✅ Effacé');
  });
  el.btnResetAll.addEventListener('click', async () => {
    if (!confirm('Réinitialiser tous les paramètres et l\u2019historique ?')) return;
    await chrome.storage.sync.clear();
    await chrome.storage.local.clear();
    await chrome.storage.sync.set(SYNC_DEFAULTS);
    await chrome.storage.local.set({ ...LOCAL_DEFAULTS, installedAt: Date.now() });
    flash(el.btnResetAll, '✅ Réinit');
    setTimeout(() => window.close(), 800);
  });

  /* =========================================================
     PROFILE
     ========================================================= */
  async function renderProfile() {
    const s = await loadSync();
    el.profileAvatar.textContent = s.avatar || '👤';
    el.profileName.value = s.displayName || '';
    // Sélection dans le picker
    el.avatarPicker.querySelectorAll('.avatar-btn').forEach(b => {
      b.classList.toggle('is-selected', b.dataset.avatar === s.avatar);
    });
  }

  el.avatarPicker.addEventListener('click', (e) => {
    const btn = e.target.closest('.avatar-btn');
    if (!btn) return;
    const avatar = btn.dataset.avatar;
    el.profileAvatar.textContent = avatar;
    el.avatarPicker.querySelectorAll('.avatar-btn').forEach(b => b.classList.toggle('is-selected', b === btn));
    saveSync({ avatar });
  });

  el.profileName.addEventListener('input', () => {
    const v = (el.profileName.value || '').slice(0, 40);
    clearTimeout(el.profileName._t);
    el.profileName._t = setTimeout(() => saveSync({ displayName: v }), 250);
  });

  async function renderStats() {
    const L = await loadLocal();
    el.statTotal.textContent = L.totalTranslations || 0;
    const topLang = Object.entries(L.langStats || {}).sort((a, b) => b[1] - a[1])[0];
    el.statLang.textContent = topLang ? (topLang[0] === 'auto' ? '🌍' : topLang[0].toUpperCase()) : '—';
    const installedAt = L.installedAt || Date.now();
    const days = Math.max(0, Math.floor((Date.now() - installedAt) / 86400000));
    el.statDays.textContent = days || 1;
  }

  /* --- History & Favorites --- */
  async function recordHistory(entry) {
    const s = await loadSync();
    if (s.history === false) return;
    const L = await loadLocal();
    const list = L.history || [];
    // Déduplication : si la dernière entrée est identique, on ne duplique pas
    const head = list[0];
    if (!head || head.text !== entry.text || head.to !== entry.to) {
      list.unshift({ ...entry, timestamp: Date.now() });
    }
    const trimmed = list.slice(0, 100);
    const langStats = L.langStats || {};
    const k = entry.from || 'auto';
    langStats[k] = (langStats[k] || 0) + 1;
    await chrome.storage.local.set({
      history: trimmed,
      totalTranslations: (L.totalTranslations || 0) + 1,
      langStats,
    });
  }

  async function toggleFavorite(entry) {
    const L = await loadLocal();
    const favs = L.favorites || [];
    const idx = favs.findIndex(f => f.text === entry.text && f.to === entry.to);
    if (idx >= 0) favs.splice(idx, 1);
    else favs.unshift({ ...entry, favoritedAt: Date.now() });
    await chrome.storage.local.set({ favorites: favs.slice(0, 50) });
    if (el.profileView.classList.contains('is-visible')) renderHistory();
  }

  async function renderHistory() {
    const L = await loadLocal();
    const hist = L.history || [];
    const favs = L.favorites || [];

    el.historyCount.textContent = hist.length;
    el.favoritesCount.textContent = favs.length;

    // Historique
    if (!hist.length) {
      el.historyList.innerHTML = '<p class="muted small empty-hint">Vos traductions apparaîtront ici.</p>';
    } else {
      el.historyList.innerHTML = '';
      hist.slice(0, 15).forEach(h => el.historyList.appendChild(renderItem(h, favs, true)));
    }

    // Favoris
    if (!favs.length) {
      el.favoritesList.innerHTML = '<p class="muted small empty-hint">Cliquez sur ☆ pour ajouter un favori.</p>';
    } else {
      el.favoritesList.innerHTML = '';
      favs.forEach(f => el.favoritesList.appendChild(renderItem(f, favs, true)));
    }
  }

  function renderItem(entry, favs, starrable) {
    const isFav = favs.some(f => f.text === entry.text && f.to === entry.to);
    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerHTML = `
      <div class="history-src"></div>
      <div class="history-tgt"></div>
      <div class="history-meta">
        <span class="history-lang"></span>
        ${starrable ? `<button class="history-star ${isFav ? 'is-active' : ''}" title="${isFav ? 'Retirer' : 'Ajouter aux favoris'}">${isFav ? '★' : '☆'}</button>` : ''}
      </div>
    `;
    div.querySelector('.history-src').textContent = entry.text;
    div.querySelector('.history-tgt').textContent = entry.translated;
    div.querySelector('.history-lang').textContent =
      (entry.from || 'auto').toUpperCase() + ' → ' + (entry.to || 'fr').toUpperCase();

    div.addEventListener('click', async (e) => {
      if (e.target.closest('.history-star')) {
        e.stopPropagation();
        await toggleFavorite(entry);
        renderHistory();
        updateFavButton();
        return;
      }
      // Recharge la traduction dans la vue principale
      el.src.value = entry.text;
      if (entry.from && entry.from !== 'auto' && el.langFrom.querySelector(`option[value="${entry.from}"]`)) {
        el.langFrom.value = entry.from;
      }
      if (entry.to && el.langTo.querySelector(`option[value="${entry.to}"]`)) {
        el.langTo.value = entry.to;
      }
      showView('mainView');
      doTranslate();
    });
    return div;
  }

  /* =========================================================
     Init
     ========================================================= */
  (async function init() {
    // First-run : s'assurer que les defaults et installedAt sont posés
    const stored = await chrome.storage.sync.get(null);
    const missingSync = {};
    for (const k of Object.keys(SYNC_DEFAULTS)) {
      if (stored[k] === undefined) missingSync[k] = SYNC_DEFAULTS[k];
    }
    if (Object.keys(missingSync).length) await chrome.storage.sync.set(missingSync);

    const local = await chrome.storage.local.get(null);
    if (!local.installedAt) await chrome.storage.local.set({ installedAt: Date.now() });

    // Charge les langues / toggles dans la vue principale
    const s = await loadSync();
    el.tgSelection.checked = !!s.selection;
    el.tgQcm      .checked = !!s.qcm;
    el.tgAudio    .checked = !!s.audio;
    if (s.langFrom) el.langFrom.value = s.langFrom;
    if (s.langTo)   el.langTo  .value = s.langTo;

    await updateDomainPill();

    // Pré-remplissage depuis la sélection de l'onglet actif
    try {
      const tab = await getActiveTab();
      if (tab?.id) {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => (window.getSelection()?.toString() || '').trim(),
        });
        const sel = r?.result || '';
        if (sel && sel.length < 500) {
          el.src.value = sel;
          doTranslate();
        }
      }
    } catch {}

    updateFavButton();
  })();
})();
