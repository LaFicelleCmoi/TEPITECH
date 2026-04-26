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
    langFrom: 'auto',
    langTo: 'fr',
    hoverDelay: 450,
    ttsRate: 1.0,
    history: true,
    ipa: true,                 // afficher phonétique IPA dans tooltip
    alts: true,                // afficher traductions alternatives
    qcmHint: true,             // suggérer la réponse probable (analyseur grammatical)
    qcmAudio: true,            // bouton TTS sur la phrase originale
    avatar: '👤',
    displayName: '',
  };

  const LOCAL_DEFAULTS = {
    installedAt: 0,
    totalTranslations: 0,
    langStats: {},
    history: [],
    favorites: [],
    dailyActivity: {}, // { 'YYYY-MM-DD': count }
  };

  function dayKey(d) {
    const dt = (d instanceof Date) ? d : new Date(d || Date.now());
    return dt.getFullYear() + '-' +
      String(dt.getMonth() + 1).padStart(2, '0') + '-' +
      String(dt.getDate()).padStart(2, '0');
  }

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
    btnOpenLiveCaption: $('btnOpenLiveCaption'),
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
    btnSidePanel: $('btnSidePanel'),
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
    settIpa:        $('settIpa'),
    settAlts:       $('settAlts'),
    settQcmHint:    $('settQcmHint'),
    settQcmAudio:   $('settQcmAudio'),
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

  // Chrome bloque l'injection sur ces schémas / origines ; on signale clairement
  // à l'utilisateur au lieu d'échouer silencieusement.
  function isRestrictedUrl(url) {
    if (!url) return true;
    return /^(chrome|edge|about|chrome-extension|moz-extension|view-source|devtools):/i.test(url)
        || /^https?:\/\/chrome\.google\.com\/webstore/i.test(url)
        || /^https?:\/\/chromewebstore\.google\.com/i.test(url);
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

  if (el.btnSidePanel) {
    el.btnSidePanel.addEventListener('click', async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.windowId) throw new Error('Pas de fenêtre courante');
        // open() exige un user-gesture — le clic dans le popup en est un.
        await chrome.sidePanel.open({ windowId: tab.windowId });
        // Le popup se ferme tout seul quand on clique à l'extérieur — mais
        // pour s'assurer qu'on voit bien le side panel, on le ferme.
        window.close();
      } catch (err) {
        console.warn('TU: cannot open side panel', err);
        // Fallback : flash d'erreur sur le bouton
        const orig = el.btnSidePanel.textContent;
        el.btnSidePanel.textContent = '⚠️';
        setTimeout(() => { el.btnSidePanel.textContent = orig; }, 1500);
      }
    });
  }
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

  /* Bouton Live Caption : détecte le navigateur (Chrome / Brave / Edge / Opera)
     et copie le bon schéma d'URL des réglages d'accessibilité.
     (chrome.tabs.create sur chrome:// est bloqué ; copier-coller reste la voie
     la plus simple côté utilisateur.) */
  async function detectBrowser() {
    try {
      if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
        const b = await navigator.brave.isBrave();
        if (b) return { name: 'Brave', scheme: 'brave', emoji: '🦁' };
      }
    } catch {}
    const ua = navigator.userAgent || '';
    if (/Edg\//.test(ua))                  return { name: 'Edge',   scheme: 'edge',   emoji: '🔵' };
    if (/OPR\/|Opera/.test(ua))            return { name: 'Opera',  scheme: 'opera',  emoji: '🔴' };
    if (/Vivaldi/.test(ua))                return { name: 'Vivaldi',scheme: 'vivaldi',emoji: '🟠' };
    return { name: 'Chrome', scheme: 'chrome', emoji: '🟢' };
  }

  if (el.btnOpenLiveCaption) {
    // Pré-affiche le navigateur détecté dans le sous-titre du bloc
    detectBrowser().then(b => {
      const sub = document.getElementById('lcSub');
      if (sub) sub.textContent = 'Utilisez la fonction native de ' + b.name + ' ' + b.emoji;
    }).catch(() => {});

    el.btnOpenLiveCaption.addEventListener('click', async () => {
      const b = await detectBrowser();
      const url = b.scheme + '://settings/accessibility';
      try {
        await navigator.clipboard.writeText(url);
        flash(el.btnOpenLiveCaption, '✅ Copié pour ' + b.name + ' — colle dans la barre d\'adresse', 2200);
      } catch {
        flash(el.btnOpenLiveCaption, '⚠️ Copie refusée — ouvrez ' + url + ' manuellement', 3000);
      }
    });
  }

  /* Bouton QCM (action à la demande) */
  el.btnQcm.addEventListener('click', async () => {
    const original = el.btnQcm.textContent;
    el.btnQcm.disabled = true;
    el.btnQcm.textContent = '⏳ …';
    el.btnQcm.classList.remove('is-success');
    const restoreLabel = (label) => {
      el.btnQcm.textContent = label;
      setTimeout(() => {
        el.btnQcm.textContent = original;
        el.btnQcm.classList.remove('is-success');
        el.btnQcm.disabled = false;
      }, 1800);
    };
    try {
      const tab = await getActiveTab();
      if (!tab?.id) throw new Error('onglet introuvable');
      if (isRestrictedUrl(tab.url)) { restoreLabel('🚫 Page système'); return; }
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
      restoreLabel('⚠️ Erreur');
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

  function flash(btn, label, dur = 1100) {
    const original = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, dur);
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
    if (el.settIpa)  el.settIpa.checked  = s.ipa  !== false;
    if (el.settAlts) el.settAlts.checked = s.alts !== false;
    if (el.settQcmHint)    el.settQcmHint.checked    = !!s.qcmHint;
    if (el.settQcmAudio)   el.settQcmAudio.checked   = s.qcmAudio !== false;
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
  if (el.settIpa)  el.settIpa.addEventListener('change',  () => saveSync({ ipa:  el.settIpa.checked }));
  if (el.settAlts) el.settAlts.addEventListener('change', () => saveSync({ alts: el.settAlts.checked }));
  if (el.settQcmHint)    el.settQcmHint.addEventListener('change',    () => saveSync({ qcmHint:    el.settQcmHint.checked }));
  if (el.settQcmAudio)   el.settQcmAudio.addEventListener('change',   () => saveSync({ qcmAudio:   el.settQcmAudio.checked }));

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

  function computeStreak(daily) {
    // Streak quotidien : nb de jours consécutifs jusqu'à aujourd'hui (ou hier)
    // qui contiennent au moins 1 traduction.
    let streak = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 0; i < 365; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      if ((daily[dayKey(d)] || 0) > 0) streak++;
      else if (i === 0) {
        // Aujourd'hui sans activité → on regarde si hier compte (streak en cours mais pas cassé)
        continue;
      } else {
        break;
      }
    }
    return streak;
  }

  function renderHeatmap(daily) {
    const root = document.getElementById('heatmap');
    if (!root) return;
    root.innerHTML = '';
    // 30 jours, du plus ancien (gauche) au plus récent (droite)
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayKey = dayKey(today);
    const counts = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today); d.setDate(today.getDate() - i);
      counts.push({ key: dayKey(d), count: daily[dayKey(d)] || 0, date: d });
    }
    const max = Math.max(1, ...counts.map(c => c.count));
    let total = 0;
    for (const c of counts) {
      total += c.count;
      const lvl = c.count === 0 ? 0 : Math.min(4, Math.ceil((c.count / max) * 4));
      const cell = document.createElement('div');
      cell.className = 'heatmap-cell lvl-' + lvl + (c.key === todayKey ? ' is-today' : '');
      cell.title = c.date.toLocaleDateString() + ' : ' + c.count + ' traduction' + (c.count > 1 ? 's' : '');
      root.appendChild(cell);
    }
    const tot = document.getElementById('heatmapTotal');
    if (tot) tot.textContent = total + ' total';
  }

  async function renderStats() {
    const L = await loadLocal();
    el.statTotal.textContent = L.totalTranslations || 0;
    const topLang = Object.entries(L.langStats || {}).sort((a, b) => b[1] - a[1])[0];
    el.statLang.textContent = topLang ? (topLang[0] === 'auto' ? '🌍' : topLang[0].toUpperCase()) : '—';
    const installedAt = L.installedAt || Date.now();
    const days = Math.max(0, Math.floor((Date.now() - installedAt) / 86400000));
    el.statDays.textContent = days || 1;

    const daily = L.dailyActivity || {};
    const streak = computeStreak(daily);
    const statStreak = document.getElementById('statStreak');
    if (statStreak) statStreak.textContent = '🔥 ' + streak;
    renderHeatmap(daily);
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

    // Activité du jour pour le heatmap + le streak
    const daily = L.dailyActivity || {};
    const today = dayKey(new Date());
    daily[today] = (daily[today] || 0) + 1;
    // Garde max 90 jours d'historique pour rester léger
    const keys = Object.keys(daily).sort();
    if (keys.length > 90) {
      for (const k2 of keys.slice(0, keys.length - 90)) delete daily[k2];
    }

    await chrome.storage.local.set({
      history: trimmed,
      totalTranslations: (L.totalTranslations || 0) + 1,
      langStats,
      dailyActivity: daily,
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
