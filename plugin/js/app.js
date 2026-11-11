(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  var foregroundPollTimer = null;

  async function init() {
    bindStaticChrome();

    global.Otzaria.on('plugin.boot', onBoot);
    global.Otzaria.on('theme.changed', function (theme) {
      CN.ui.applyTheme(theme);
    });
    global.Otzaria.on('plugin.permissions_changed', function (payload) {
      if (payload && Array.isArray(payload.permissions)) {
        CN.state.permissions = payload.permissions;
        renderChrome();
      }
    });
    global.Otzaria.on('settings.changed', async function (ev) {
      if (!ev) return;
      if (ev.key === 'key-settings-language') {
        CN.i18n.setLanguage(String(ev.newValue || 'he'), ev.newValue === 'en' ? 'ltr' : 'rtl');
        renderChrome();
        renderScreen();
      } else if (ev.key === 'key-font-size' || ev.key === 'key-default-nikud' || ev.key === 'key-show-teamim') {
        await refreshOtzariaDisplayPrefs();
        CN.ui.applyUserDisplaySettings();
        renderScreen();
      }
    });

    // Entry point listeners
    global.Otzaria.on('reader.toolbar_item_clicked', onToolbarClicked);
    global.Otzaria.on('reader.context_menu_item_clicked', onContextMenuClicked);
    global.Otzaria.on('contextMenu.itemClicked', onContextMenuClicked);
    global.Otzaria.on('ui.messageClicked', onMessageClicked);
    global.Otzaria.on('reader.sectionContentChanged', function (ev) {
      if (ev && ev.changeType === 'source-content' && CN.state.screen === 'section') {
        loadSectionNotes({ forceRefresh: false });
      }
    });
    global.Otzaria.on('plugin.resumed', function () {
      refreshInboxBadge();
    });
  }

  function bindStaticChrome() {
    var settingsScrim = document.getElementById('settings-scrim');
    if (settingsScrim) settingsScrim.addEventListener('click', CN.settingsUi.closeSettingsPanel);
    var closeSettingsBtn = document.getElementById('close-settings-btn');
    if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', CN.settingsUi.closeSettingsPanel);

    // Close open popovers on outside click
    document.addEventListener('click', function () {
      document.querySelectorAll('.popover-menu.open').forEach(function (m) {
        m.classList.remove('open');
      });
    });

    // Escape closes active modal or settings overlay drawer
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      var modal = document.getElementById('modal-backdrop');
      if (modal && modal.classList.contains('open')) {
        modal.classList.remove('open');
        return;
      }
      var panel = document.getElementById('settings-panel');
      if (panel && panel.classList.contains('open')) {
        CN.settingsUi.closeSettingsPanel();
      }
    });
  }

  async function onBoot(payload) {
    if (payload && payload.app && payload.app.runMode === 'background') return;

    if (payload && payload.app) {
      CN.i18n.setLanguage(payload.app.language, payload.app.textDirection);
    }
    if (payload && payload.theme) {
      CN.ui.applyTheme(payload.theme);
    }
    if (payload && Array.isArray(payload.permissions)) {
      CN.state.permissions = payload.permissions;
    }

    CN.state.settings = await CN.storage.loadSettings();
    CN.state.identity = await CN.storage.get(CN.storage.KEYS.IDENTITY, null);
    CN.state.sectionFilter = CN.state.settings.filterTier || 'recommended_and_new';
    CN.state.sectionSort = CN.state.settings.sortOrder || 'recommended';

    var visits = Number(await CN.storage.get(CN.storage.KEYS.VISIT_COUNT, 0)) + 1;
    await CN.storage.set(CN.storage.KEYS.VISIT_COUNT, visits);

    await refreshOtzariaDisplayPrefs();
    CN.ui.applyUserDisplaySettings();

    // Check connectivity without blocking initial UI
    refreshConnectivityAndConfig();

    // Restore currently active open book tab or last known book context
    if (!CN.state.cameFromReader) {
      try {
        var curSt = await global.Otzaria.call('reader.getCurrentState');
        if (curSt && curSt.success && curSt.data && (curSt.data.bookUid || curSt.data.currentBook || curSt.data.currentId != null)) {
          var d = curSt.data;
          CN.state.context.bookUid = d.bookUid || (d.currentId != null ? 'id:' + d.currentId : (d.currentBook || d.currentBookId || ''));
          CN.state.context.titleHint = d.currentBook || d.bookUid || '';
          CN.state.context.bookId = d.currentBookId || d.currentBook || CN.state.context.bookUid;
          CN.state.context.ref = d.currentRef || '';
          CN.state.context.sectionIndex = typeof d.currentIndex === 'number' ? d.currentIndex : 0;
          CN.state.isPdf = d.currentType === 'pdf';
        }
      } catch (_) { /* ignore */ }
    }

    if (!CN.state.context.bookUid) {
      var lastLoc = await CN.storage.get(CN.storage.KEYS.LAST_LOCATION, null);
      if (lastLoc && lastLoc.bookUid) {
        CN.state.context.bookUid = lastLoc.bookUid;
        CN.state.context.titleHint = lastLoc.titleHint || lastLoc.bookUid;
        CN.state.context.bookId = lastLoc.titleHint || lastLoc.bookUid;
        CN.state.context.ref = lastLoc.ref || '';
        CN.state.context.sectionIndex = lastLoc.sectionIndex || 0;
      }
    }

    // Decide initial screen if not already directed by an entry click event
    var start = CN.state.settings.startScreen || 'section';
    if (!CN.state.cameFromReader) {
      CN.state.screen = (start === 'section' && !CN.state.context.bookUid) ? 'home' : start;
    }

    renderChrome();
    renderScreen();
    refreshInboxBadge();

    if (foregroundPollTimer) clearInterval(foregroundPollTimer);
    foregroundPollTimer = setInterval(refreshInboxBadge, CN.config.INBOX_FOREGROUND_POLL_MS);
  }

  async function refreshOtzariaDisplayPrefs() {
    if (CN.state.permissions.indexOf('settings.read') === -1) return;
    try {
      var res = await global.Otzaria.call('settings.getMany', {
        keys: ['key-font-size', 'key-default-nikud', 'key-show-teamim'],
      });
      if (res && res.success && res.data) {
        CN.state.otzariaSettings.fontSize = res.data['key-font-size'] || null;
        if (res.data['key-default-nikud'] !== undefined) {
          CN.state.otzariaSettings.defaultNikud = Boolean(res.data['key-default-nikud']);
        }
        if (res.data['key-show-teamim'] !== undefined) {
          CN.state.otzariaSettings.showTeamim = Boolean(res.data['key-show-teamim']);
        }
      }
    } catch (_) { /* ignore */ }
  }

  async function refreshConnectivityAndConfig() {
    try {
      var connRes = await global.Otzaria.call('app.getConnectivity');
      if (connRes && connRes.success && connRes.data) {
        CN.state.isOnline = connRes.data.isOnline !== false;
      } else {
        CN.state.isOnline = true;
      }
    } catch (_) {
      CN.state.isOnline = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    }

    if (CN.state.isOnline !== false) {
      try {
        var cfgRes = await CN.api.fetchConfig(CN.state.settings);
        if (cfgRes.ok && cfgRes.data) {
          CN.state.config = cfgRes.data;
        }
      } catch (_) { /* keep default */ }
    }
    renderChrome();
  }

  async function onToolbarClicked(ev) {
    CN.state.cameFromReader = true;
    CN.state.isPdf = (ev && ev.context === 'reader-pdf') || (ev && ev.currentType === 'pdf');
    var bookTitle = (ev && (ev.currentBook || ev.currentBookId)) || '';
    var bookUid = (ev && ev.bookUid) || (ev && ev.currentId != null ? 'id:' + ev.currentId : bookTitle);

    // Fetch authoritative state for bookUid if missing
    try {
      var st = await global.Otzaria.call('reader.getCurrentState');
      if (st && st.success && st.data) {
        if (st.data.bookUid) bookUid = st.data.bookUid;
        if (st.data.currentBook) bookTitle = st.data.currentBook;
        if (st.data.currentType === 'pdf') CN.state.isPdf = true;
      }
      var hlCap = await global.Otzaria.call('reader.getHighlightCapabilities');
      if (hlCap && hlCap.success && hlCap.data) CN.state.highlightCapabilities = hlCap.data;
    } catch (_) { /* ignore */ }

    CN.state.context = {
      bookUid: bookUid || bookTitle,
      bookId: (ev && ev.currentBookId) || bookTitle,
      titleHint: bookTitle,
      ref: (ev && ev.currentRef) || '',
      sectionIndex: (ev && typeof ev.currentIndex === 'number') ? ev.currentIndex : 0,
      selection: null,
      anchor: null,
      clickedHighlightIds: [],
    };
    CN.state.sectionFocusOnly = false;
    await CN.storage.recordWorkedBook(CN.state.context.bookUid, bookTitle, CN.state.context.ref, CN.state.context.sectionIndex);
    navigate('section');
  }

  async function onContextMenuClicked(ev) {
    CN.state.cameFromReader = true;
    var sel = (ev && ev.selection) || {};
    var isPdf = sel.type === 'pdf';
    CN.state.isPdf = isPdf;

    var anchor = CN.anchors.buildAnchorFromSelection(sel, '');
    if (!anchor.bookUid && sel.id != null) anchor.bookUid = 'id:' + sel.id;
    if (!anchor.bookUid) anchor.bookUid = anchor.titleHint || (ev && ev.currentBookId) || '';

    try {
      var hlCap = await global.Otzaria.call('reader.getHighlightCapabilities');
      if (hlCap && hlCap.success && hlCap.data) CN.state.highlightCapabilities = hlCap.data;
    } catch (_) { /* ignore */ }

    var clickedIds = Array.isArray(sel.clickedHighlights)
      ? sel.clickedHighlights.map(function (h) { return String(h.highlightId || '').replace(/^cn:/, ''); })
      : [];

    CN.state.context = {
      bookUid: anchor.bookUid,
      bookId: sel.bookId || (ev && ev.currentBookId) || anchor.titleHint,
      titleHint: anchor.titleHint || (ev && ev.currentBook) || '',
      ref: anchor.ref || (ev && ev.currentRef) || '',
      sectionIndex: anchor.sectionHint,
      selection: sel,
      anchor: anchor,
      clickedHighlightIds: clickedIds,
    };

    await CN.storage.recordWorkedBook(CN.state.context.bookUid, CN.state.context.titleHint, CN.state.context.ref, CN.state.context.sectionIndex);

    if (ev && ev.itemId === 'add-note') {
      openCreateComposer(anchor);
    } else {
      CN.state.sectionFocusOnly = Boolean(anchor.quote || clickedIds.length > 0);
      navigate('section');
    }
  }

  function onMessageClicked(ev) {
    var p = ev && ev.payload;
    if (p && p.rootId) {
      openThread(p.rootId, p.noteId);
    } else {
      navigate('messages');
    }
  }

  function openCreateComposer(customAnchor) {
    var anchor = customAnchor || {
      bookUid: CN.state.context.bookUid,
      titleHint: CN.state.context.titleHint,
      ref: CN.state.context.ref,
      sectionHint: CN.state.context.sectionIndex,
      quote: '',
      prefix: '',
      suffix: '',
      occurrence: 0,
    };
    var defaultKind = CN.state.settings.defaultComposerKind === 'last'
      ? (CN.state.settings.lastUsedComposerKind || 'note')
      : (CN.state.settings.defaultComposerKind || 'note');

    CN.state.previousScreen = CN.state.screen === 'compose' ? 'section' : CN.state.screen;
    CN.state.compose = {
      mode: 'create',
      editingNote: null,
      kind: defaultKind,
      body: '',
      anchor: anchor,
      dirty: false,
    };

    // Load saved draft for same anchor if present
    var draftKey = CN.storage.makeDraftKey(anchor.bookUid || anchor.titleHint, anchor.ref, anchor.quote);
    CN.storage.get(draftKey, null).then(function (draft) {
      if (draft && draft.body && CN.state.screen === 'compose') {
        CN.state.compose.body = draft.body;
        if (draft.kind) CN.state.compose.kind = draft.kind;
        CN.state.compose.dirty = true;
        renderScreen();
      }
    });

    navigate('compose');
  }

  function openEditComposer(note) {
    CN.state.previousScreen = CN.state.screen;
    CN.state.compose = {
      mode: 'edit',
      editingNote: note,
      kind: note.kind,
      body: note.body || '',
      anchor: null,
      dirty: false,
    };
    navigate('compose');
  }

  function openThread(rootId, focusNoteId) {
    CN.state.previousScreen = CN.state.screen === 'thread' ? CN.state.previousScreen : CN.state.screen;
    CN.state.activeThreadId = rootId;
    CN.state.activeFocusNoteId = focusNoteId || null;
    navigate('thread');
  }

  function navigate(screen) {
    CN.state.screen = screen;
    renderChrome();
    renderScreen();
  }

  function refreshCurrentScreen() {
    renderChrome();
    renderScreen();
  }

  function renderChrome() {
    var el = CN.ui.el;
    var t = CN.ui.t;
    var ctx = CN.state.context;

    // Top bar subtitle
    var subEl = document.getElementById('topbar-subtitle');
    if (subEl) {
      subEl.textContent = ctx.bookUid
        ? ((ctx.titleHint || ctx.bookUid) + (ctx.ref ? (' · ' + ctx.ref) : ''))
        : (CN.state.identity ? CN.state.identity.displayName : '');
    }

    // Back to book button (only when entered from reader)
    var backBtn = document.getElementById('back-to-book-btn');
    if (backBtn) {
      backBtn.classList.toggle('hidden', !CN.state.cameFromReader);
      backBtn.onclick = function () {
        CN.highlights.returnToBookTab(ctx.bookUid, ctx.bookId);
      };
    }

    // Inbox badge on topbar
    var topBadge = document.getElementById('topbar-inbox-badge');
    if (topBadge) {
      var cnt = Number(CN.state.unreadCount || 0);
      topBadge.textContent = cnt > 99 ? '99+' : String(cnt);
      topBadge.classList.toggle('hidden', cnt <= 0);
    }

    // Context strip
    var strip = document.getElementById('context-strip');
    if (strip) {
      strip.textContent = '';
      if (!ctx.bookUid || CN.state.screen === 'home' || CN.state.screen === 'questions' || CN.state.screen === 'mine' || CN.state.screen === 'messages' || CN.state.screen === 'import') {
        strip.classList.add('hidden');
      } else {
        strip.classList.remove('hidden');
        strip.appendChild(el('button', {
          type: 'button',
          className: 'context-ref-btn',
          text: (ctx.titleHint || ctx.bookUid) + (ctx.ref ? (' · ' + ctx.ref) : ''),
          onClick: async function () {
            try {
              await global.Otzaria.call('reader.openBookAtRef', {
                bookId: ctx.bookId || ctx.titleHint || ctx.bookUid,
                bookUid: ctx.bookUid,
                ref: ctx.ref || undefined,
                index: ctx.sectionIndex || 0,
                highlight: true,
              });
            } catch (_) { /* ignore */ }
          },
        }));
        if (ctx.anchor && ctx.anchor.quote) {
          strip.appendChild(el('span', {
            className: 'context-quote-pill',
            text: '״' + CN.ui.formatQuoteText(ctx.anchor.quote) + '״',
          }));
        }
      }
    }

    // Navigation bar
    var nav = document.getElementById('nav-bar');
    if (nav) {
      nav.textContent = '';
      var isMod = CN.state.identity && (CN.state.identity.role === 'moderator' || CN.state.identity.role === 'admin');
      var tabs = [];
      if (ctx.bookUid) tabs.push(['section', t('בקטע')]);
      else tabs.push(['home', t('בית')]);
      tabs.push(['questions', t('שאלות')]);
      tabs.push(['mine', t('שלי')]);
      tabs.push(['messages', t('הודעות')]);
      if (isMod) tabs.push(['mod', t('מודרציה')]);

      tabs.forEach(function (pair) {
        var isActive = CN.state.screen === pair[0] || (CN.state.screen === 'import' && pair[0] === 'mine');
        var btn = el('button', {
          type: 'button',
          className: 'nav-tab' + (isActive ? ' active' : ''),
          text: pair[1],
          onClick: function () { navigate(pair[0]); },
        });
        if (pair[0] === 'messages' && CN.state.unreadCount > 0) {
          btn.appendChild(el('span', { className: 'badge-count', text: String(CN.state.unreadCount) }));
        }
        nav.appendChild(btn);
      });
    }
  }

  function renderScreen() {
    var main = document.getElementById('app-content');
    if (!main) return;

    // System notice / update warning banner
    var noticeBanner = document.getElementById('global-notice-banner');
    if (noticeBanner) {
      noticeBanner.textContent = '';
      noticeBanner.classList.add('hidden');
      if (CN.state.config && CN.state.config.systemNotice) {
        noticeBanner.textContent = CN.state.config.systemNotice;
        noticeBanner.classList.remove('hidden');
      }
    }

    var scr = CN.state.screen;
    if (scr === 'section') renderSectionScreen(main);
    else if (scr === 'questions') renderQuestionsScreen(main);
    else if (scr === 'mine') renderMineScreen(main);
    else if (scr === 'messages') renderMessagesScreen(main);
    else if (scr === 'home') renderHomeScreen(main);
    else if (scr === 'thread') renderThreadScreen(main);
    else if (scr === 'compose') CN.composer.renderComposer(main);
    else if (scr === 'import') CN.importer.renderImportScreen(main);
    else if (scr === 'mod') CN.modUi.renderModPanel(main);
  }

  async function loadSectionNotes({ forceRefresh = true } = {}) {
    var ctx = CN.state.context;
    if (!ctx.bookUid || CN.state.isPdf) return;

    // 1. Instant local cache load (< 200ms)
    var cached = await CN.storage.getCachedSectionNotes(ctx.bookUid, ctx.ref);
    if (cached && Array.isArray(cached.items)) {
      CN.state.sectionNotes = cached.items;
      CN.state.sectionCacheDate = cached.savedAt;
      CN.state.sectionGroups = await CN.anchors.groupAndLocateNotes(cached.items, ctx.bookId || ctx.titleHint || ctx.bookUid);
      CN.state.sectionLoading = false;
      CN.state.sectionRefreshing = CN.state.isOnline !== false;
      renderSectionScreen(document.getElementById('app-content'), { skipFetch: true });
    } else {
      CN.state.sectionLoading = true;
      CN.state.sectionError = null;
      renderSectionScreen(document.getElementById('app-content'), { skipFetch: true });
    }

    if (CN.state.isOnline === false) {
      CN.state.sectionLoading = false;
      CN.state.sectionRefreshing = false;
      renderSectionScreen(document.getElementById('app-content'), { skipFetch: true });
      return;
    }

    if (!forceRefresh && cached) return;

    try {
      var urlPath = '/v1/books/' + encodeURIComponent(ctx.bookUid) + '/notes?ref=' + encodeURIComponent(ctx.ref || '');
      var res = await CN.api.request('GET', urlPath, {
        auth: Boolean(CN.state.identity && CN.state.identity.userId),
        identity: CN.state.identity,
        settings: CN.state.settings,
      });
      if (!res.ok) throw new Error('LOAD_FAILED');
      var items = (res.data && res.data.items) || [];
      CN.state.sectionNotes = items;
      CN.state.sectionError = null;
      CN.state.sectionCacheDate = Date.now();
      await CN.storage.putCachedSectionNotes(ctx.bookUid, ctx.ref, items);
      CN.state.sectionGroups = await CN.anchors.groupAndLocateNotes(items, ctx.bookId || ctx.titleHint || ctx.bookUid);
    } catch (_) {
      if (!cached) {
        CN.state.sectionError = 'לא הצלחנו לטעון';
      }
    } finally {
      CN.state.sectionLoading = false;
      CN.state.sectionRefreshing = false;
      if (CN.state.screen === 'section') {
        renderSectionScreen(document.getElementById('app-content'), { skipFetch: true });
      }
    }
  }

  function renderSectionScreen(container, opts) {
    var el = CN.ui.el;
    var t = CN.ui.t;
    var ctx = CN.state.context;

    if (!opts || !opts.skipFetch) {
      loadSectionNotes({ forceRefresh: true });
      return;
    }

    container.textContent = '';
    var wrap = el('div', { className: 'container-narrow' });

    if (CN.state.isPdf) {
      wrap.appendChild(el('div', { className: 'empty-state' }, [
        el('p', { text: t('הערות קהילה זמינות בספרי טקסט') }),
      ]));
      container.appendChild(wrap);
      return;
    }

    // One-time background permission nudge if eligible
    CN.onboarding.maybeTriggerBackgroundPrompt(false).then(function (show) {
      if (show && wrap.parentNode) {
        wrap.insertBefore(CN.onboarding.buildBackgroundPromptCard(function () {
          renderScreen();
        }), wrap.firstChild);
      }
    });

    if (CN.state.isOnline === false) {
      var dateText = CN.state.sectionCacheDate
        ? new Date(CN.state.sectionCacheDate).toLocaleString('he-IL')
        : '—';
      wrap.appendChild(el('div', {
        className: 'status-banner warning',
        text: 'אין חיבור, מוצגות הערות שמורות מ־' + dateText,
      }));
    }

    // Header & Counts
    var notesOnlyCount = CN.state.sectionNotes.filter(function (n) { return n.kind === 'note'; }).length;
    var openQuestionsCount = CN.state.sectionNotes.filter(function (n) { return n.kind === 'question' && n.questionStatus === 'open'; }).length;

    wrap.appendChild(el('div', { className: 'section-header' }, [
      el('div', { className: 'section-title-group' }, [
        el('h2', { className: 'section-heading', text: ctx.ref || ctx.titleHint || t('בקטע') }),
        el('div', {
          className: 'section-counts',
          text: t('{n} הערות, {q} שאלות פתוחות', { n: notesOnlyCount, q: openQuestionsCount }) +
            (CN.state.sectionRefreshing ? (' · ' + t('מרענן') + '...') : ''),
        }),
      ]),
      el('button', {
        type: 'button',
        className: 'btn-primary',
        text: t('הוסף הערה'),
        onClick: function () { openCreateComposer(); },
      }),
    ]));

    // Filter + Sort controls
    var filterGroup = el('div', { className: 'chip-group', role: 'radiogroup', 'aria-label': 'סינון הערות' });
    [
      ['recommended_and_new', t('מומלצות וחדשות')],
      ['all', t('הכל')],
      ['questions', t('שאלות')],
    ].forEach(function (pair) {
      filterGroup.appendChild(el('button', {
        type: 'button',
        className: 'chip-btn' + (CN.state.sectionFilter === pair[0] ? ' active' : ''),
        text: pair[1],
        onClick: function () {
          CN.state.sectionFilter = pair[0];
          renderSectionScreen(container, { skipFetch: true });
        },
      }));
    });

    var sortSelect = el('select', { className: 'select-compact', 'aria-label': 'מיון' }, [
      el('option', { value: 'recommended', text: t('מומלצות קודם') }),
      el('option', { value: 'newest', text: t('חדשות קודם') }),
    ]);
    sortSelect.value = CN.state.sectionSort;
    sortSelect.addEventListener('change', function () {
      CN.state.sectionSort = sortSelect.value;
      renderSectionScreen(container, { skipFetch: true });
    });

    wrap.appendChild(el('div', { className: 'filter-row' }, [filterGroup, sortSelect]));

    if (CN.state.sectionFocusOnly) {
      wrap.appendChild(el('div', { className: 'status-banner info' }, [
        el('span', { text: 'מוצגות תחילה הערות החופפות לבחירה שלך' }),
        el('button', {
          type: 'button',
          className: 'link-btn',
          text: t('הצג את כל הקטע'),
          onClick: function () {
            CN.state.sectionFocusOnly = false;
            renderSectionScreen(container, { skipFetch: true });
          },
        }),
      ]));
    }

    if (CN.state.sectionLoading) {
      wrap.appendChild(el('div', { className: 'skeleton-card' }));
      wrap.appendChild(el('div', { className: 'skeleton-card' }));
      container.appendChild(wrap);
      return;
    }

    if (CN.state.sectionError && CN.state.sectionNotes.length === 0) {
      wrap.appendChild(el('div', { className: 'empty-state' }, [
        el('p', { text: t('לא הצלחנו לטעון') }),
        el('button', {
          type: 'button',
          className: 'btn-primary',
          text: t('נסה שוב'),
          onClick: function () { loadSectionNotes({ forceRefresh: true }); },
        }),
      ]));
      container.appendChild(wrap);
      return;
    }

    // Apply filter, sort, and selection focus prioritization
    var groups = CN.state.sectionGroups.slice();
    var focusedGroupEl = null;

    if (CN.state.sectionFocusOnly && (ctx.clickedHighlightIds.length > 0 || (ctx.anchor && ctx.anchor.quote))) {
      groups.sort(function (ga, gb) {
        var ma = isGroupMatchedByEntry(ga, ctx) ? 0 : 1;
        var mb = isGroupMatchedByEntry(gb, ctx) ? 0 : 1;
        return ma - mb;
      });
    }

    var renderedCards = 0;
    var totalVisibleCards = 0;
    var limit = CN.state.sectionVisibleLimit;

    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      var visibleNotes = CN.cards.filterAndSortNotes(grp.notes, {
        filterTier: CN.state.sectionFilter,
        sortOrder: CN.state.sectionSort,
        contentTypes: CN.state.settings.contentTypes,
      });
      if (visibleNotes.length === 0) continue;

      totalVisibleCards += visibleNotes.length;
      if (renderedCards >= limit) continue;

      var isFocused = isGroupMatchedByEntry(grp, ctx);
      var groupEl = el('section', {
        className: 'quote-group' + (isFocused ? ' highlight-focus' : ''),
      });
      if (isFocused && !focusedGroupEl) focusedGroupEl = groupEl;

      var headLabel = grp.type === 'section'
        ? t('הערות על הקטע כולו')
        : grp.type === 'unlocated'
          ? t('המיקום המדויק לא נמצא')
          : CN.ui.formatQuoteText(grp.displayQuote || grp.quote);

      var isFullQuote = CN.state.settings.groupQuoteMode === 'full';
      var labelNode = el('div', {
        className: 'quote-group-label' + (grp.type === 'quote' ? (isFullQuote ? '' : ' clamped') : ' system-label'),
        text: headLabel,
      });

      var groupHeader = el('div', { className: 'quote-group-header' }, [labelNode]);
      if (grp.type === 'quote' && !isFullQuote && headLabel.length > 55) {
        (function (lblNode) {
          var expandBtn = el('button', {
            type: 'button',
            className: 'link-btn',
            text: t('עוד'),
            onClick: function () {
              var clamped = lblNode.classList.toggle('clamped');
              expandBtn.textContent = clamped ? t('עוד') : t('פחות');
            },
          });
          lblNode.style.cursor = 'pointer';
          lblNode.addEventListener('click', function () {
            var clamped = lblNode.classList.toggle('clamped');
            expandBtn.textContent = clamped ? t('עוד') : t('פחות');
          });
          groupHeader.appendChild(expandBtn);
        })(labelNode);
      }
      groupEl.appendChild(groupHeader);

      for (var ni = 0; ni < visibleNotes.length && renderedCards < limit; ni++) {
        groupEl.appendChild(CN.cards.buildNoteCard(visibleNotes[ni]));
        renderedCards++;
      }

      wrap.appendChild(groupEl);
    }

    if (totalVisibleCards === 0) {
      wrap.appendChild(el('div', { className: 'empty-state' }, [
        el('p', { text: t('עדיין אין הערות על הקטע הזה. רוצה להיות הראשון?') }),
        el('button', {
          type: 'button',
          className: 'btn-primary',
          text: t('הוסף הערה'),
          onClick: function () { openCreateComposer(); },
        }),
      ]));
    } else if (totalVisibleCards > renderedCards) {
      wrap.appendChild(el('div', { className: 'floating-cta' }, [
        el('button', {
          type: 'button',
          className: 'btn-secondary',
          text: t('הצג עוד') + ' (' + (totalVisibleCards - renderedCards) + ')',
          onClick: function () {
            CN.state.sectionVisibleLimit += CN.config.PAGE_SIZE;
            renderSectionScreen(container, { skipFetch: true });
          },
        }),
      ]));
    }

    wrap.appendChild(el('div', { className: 'floating-cta' }, [
      el('button', {
        type: 'button',
        className: 'btn-primary',
        text: t('הוסף הערה'),
        onClick: function () { openCreateComposer(); },
      }),
    ]));

    wrap.appendChild(el('div', { className: 'disclaimer-footer', text: t('הערות הקהילה אינן פסק הלכה') }));
    container.appendChild(wrap);

    if (focusedGroupEl) {
      setTimeout(function () {
        focusedGroupEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
    }
  }

  function isGroupMatchedByEntry(grp, ctx) {
    if (!grp) return false;
    if (ctx.clickedHighlightIds && ctx.clickedHighlightIds.length > 0) {
      for (var i = 0; i < grp.notes.length; i++) {
        if (ctx.clickedHighlightIds.indexOf(grp.notes[i].id) !== -1) return true;
      }
    }
    if (ctx.anchor && ctx.anchor.quote && grp.quote) {
      if (CN.anchors.normalizeCompare(grp.quote).indexOf(CN.anchors.normalizeCompare(ctx.anchor.quote)) !== -1 ||
          CN.anchors.normalizeCompare(ctx.anchor.quote).indexOf(CN.anchors.normalizeCompare(grp.quote)) !== -1) {
        return true;
      }
      if (ctx.anchor.sourceRange && grp.range && CN.anchors.rangesOverlap(ctx.anchor.sourceRange, grp.range)) {
        return true;
      }
    }
    return false;
  }

  var qScope = 'all';
  var qOnlyUnanswered = true;
  async function renderQuestionsScreen(container) {
    var el = CN.ui.el;
    var t = CN.ui.t;
    container.textContent = '';
    var wrap = el('div', { className: 'container-narrow' });

    var tabs = el('div', { className: 'chip-group' });
    [['book', t('בספר הזה')], ['all', t('בכל הספרייה')]].forEach(function (pair) {
      if (pair[0] === 'book' && !CN.state.context.bookUid) return;
      tabs.appendChild(el('button', {
        type: 'button',
        className: 'chip-btn' + (qScope === pair[0] ? ' active' : ''),
        text: pair[1],
        onClick: function () { qScope = pair[0]; renderQuestionsScreen(container); },
      }));
    });

    var onlyToggle = el('button', {
      type: 'button',
      className: 'chip-btn' + (qOnlyUnanswered ? ' active' : ''),
      text: t('רק שאלות ללא תשובה'),
      onClick: function () { qOnlyUnanswered = !qOnlyUnanswered; renderQuestionsScreen(container); },
    });

    wrap.appendChild(el('div', { className: 'section-header' }, [
      el('h2', { className: 'section-heading', text: t('שאלות') }),
    ]));
    wrap.appendChild(el('div', { className: 'filter-row' }, [tabs, onlyToggle]));

    var listWrap = el('div', { className: 'container-narrow' });
    listWrap.appendChild(el('div', { className: 'skeleton-card' }));
    wrap.appendChild(listWrap);
    container.appendChild(wrap);

    try {
      var bookParam = CN.state.context.bookUid ? encodeURIComponent(CN.state.context.bookUid) : '';
      var url = '/v1/questions?book=' + bookParam + '&scope=' + qScope + '&status=' + (qOnlyUnanswered ? 'open' : 'all');
      var res = await CN.api.request('GET', url, { settings: CN.state.settings });
      listWrap.textContent = '';
      var items = (res.ok && res.data && res.data.items) || [];
      items.sort(function (a, b) {
        if (Number(a.answerCount || 0) === 0 && Number(b.answerCount || 0) > 0) return -1;
        if (Number(b.answerCount || 0) === 0 && Number(a.answerCount || 0) > 0) return 1;
        return b.createdAt - a.createdAt;
      });
      if (items.length === 0) {
        listWrap.appendChild(el('div', { className: 'empty-state', text: 'אין שאלות מתאימות כרגע' }));
        return;
      }
      for (var i = 0; i < items.length; i++) {
        (function (q) {
          var card = CN.cards.buildNoteCard(q, { showReveal: false });
          var metaLine = el('div', {
            className: 'meta-time',
            text: (q.titleHint || q.bookUid) + (q.ref ? (' · ' + q.ref) : '') + ' · ' + Number(q.answerCount || 0) + ' תשובות',
          });
          card.insertBefore(metaLine, card.children[1]);
          listWrap.appendChild(card);
        })(items[i]);
      }
    } catch (_) {
      listWrap.textContent = '';
      listWrap.appendChild(el('div', { className: 'status-banner error', text: t('לא הצלחנו לטעון') }));
    }
  }

  var mineFilter = 'all';
  async function renderMineScreen(container) {
    var el = CN.ui.el;
    var t = CN.ui.t;
    container.textContent = '';
    var wrap = el('div', { className: 'container-narrow' });

    wrap.appendChild(el('div', { className: 'section-header' }, [
      el('h2', { className: 'section-heading', text: t('שלי') }),
      el('button', {
        type: 'button',
        className: 'btn-secondary',
        text: t('ייבוא מהערות אישיות'),
        onClick: function () { navigate('import'); },
      }),
    ]));

    var filters = el('div', { className: 'chip-group' });
    [
      ['all', 'הכל'],
      ['pending', 'ממתינות'],
      ['published', 'פורסמו'],
      ['rejected', 'נדחו'],
      ['drafts', 'טיוטות'],
    ].forEach(function (pair) {
      filters.appendChild(el('button', {
        type: 'button',
        className: 'chip-btn' + (mineFilter === pair[0] ? ' active' : ''),
        text: pair[1],
        onClick: function () { mineFilter = pair[0]; renderMineScreen(container); },
      }));
    });
    wrap.appendChild(filters);

    var drafts = await CN.storage.listDrafts();
    var myItems = [];
    var helpedCount = 0;

    if (CN.state.identity && CN.state.identity.userId && mineFilter !== 'drafts') {
      try {
        var res = await CN.api.request('GET', '/v1/me/notes', {
          auth: true,
          identity: CN.state.identity,
          settings: CN.state.settings,
        });
        if (res.ok && res.data) {
          myItems = res.data.items || [];
          helpedCount = Number(res.data.helpedCount || 0);
        }
      } catch (_) { /* offline fallback */ }
    }

    if (helpedCount > 0) {
      wrap.appendChild(el('div', {
        className: 'status-banner info',
        text: t('הערות שלך עזרו ל־{n} אנשים', { n: helpedCount }),
      }));
    }

    if (mineFilter === 'all' || mineFilter === 'drafts') {
      drafts.forEach(function (d) {
        var dCard = el('article', { className: 'card' }, [
          el('div', { className: 'card-header' }, [
            el('span', { className: 'author-name', text: (d.titleHint || d.bookUid || 'טיוטה') + (d.ref ? (' · ' + d.ref) : '') }),
            el('span', { className: 'tag', text: 'טיוטה' }),
          ]),
          el('div', { className: 'note-body', text: d.body }),
          el('div', { className: 'card-actions-group' }, [
            el('button', {
              type: 'button',
              className: 'btn-primary',
              text: 'המשך כתיבה',
              onClick: function () { openCreateComposer(d); },
            }),
            el('button', {
              type: 'button',
              className: 'btn-secondary',
              text: t('מחק'),
              onClick: async function () {
                await CN.storage.remove(d.key);
                renderMineScreen(container);
              },
            }),
          ]),
        ]);
        wrap.appendChild(dCard);
      });
    }

    if (mineFilter !== 'drafts') {
      myItems.forEach(function (n) {
        if (mineFilter === 'pending' && n.status !== 'pending') return;
        if (mineFilter === 'published' && n.status !== 'published') return;
        if (mineFilter === 'rejected' && n.status !== 'rejected' && n.status !== 'hidden') return;
        n.isOwn = true;
        wrap.appendChild(CN.cards.buildNoteCard(n, { showReveal: false }));
      });
    }

    if (wrap.children.length <= 2) {
      wrap.appendChild(el('div', { className: 'empty-state' }, [
        el('p', { text: 'עדיין אין כאן רשומות' }),
        el('button', {
          type: 'button',
          className: 'btn-primary',
          text: t('ייבוא מהערות אישיות'),
          onClick: function () { navigate('import'); },
        }),
      ]));
    }
    container.appendChild(wrap);
  }

  function formatDayLabel(ts) {
    var d = new Date(ts);
    var today = new Date();
    var yesterday = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return 'היום';
    if (d.toDateString() === yesterday.toDateString()) return 'אתמול';
    return d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  async function renderMessagesScreen(container) {
    var el = CN.ui.el;
    var t = CN.ui.t;
    container.textContent = '';
    var wrap = el('div', { className: 'container-narrow' });

    var markAllBtn = el('button', {
      type: 'button',
      className: 'btn-secondary',
      text: t('סמן הכול כנקרא'),
      onClick: async function () {
        if (!CN.state.identity) return;
        await CN.api.request('POST', '/v1/me/inbox/read', {
          auth: true,
          identity: CN.state.identity,
          settings: CN.state.settings,
          bodyObj: { all: true },
        });
        CN.state.unreadCount = 0;
        renderChrome();
        renderMessagesScreen(container);
      },
    });

    wrap.appendChild(el('div', { className: 'section-header' }, [
      el('h2', { className: 'section-heading', text: t('הודעות') }),
      markAllBtn,
    ]));

    if (!CN.state.identity || !CN.state.identity.userId) {
      wrap.appendChild(el('div', { className: 'empty-state', text: t('אין הודעות חדשות') }));
      container.appendChild(wrap);
      return;
    }

    try {
      var res = await CN.api.request('GET', '/v1/me/inbox?after=0', {
        auth: true,
        identity: CN.state.identity,
        settings: CN.state.settings,
      });
      var items = (res.ok && res.data && res.data.items) || [];
      if (res.ok && res.data) {
        CN.state.unreadCount = Number(res.data.unreadCount || 0);
        renderChrome();
      }
      if (items.length === 0) {
        wrap.appendChild(el('div', { className: 'empty-state', text: t('אין הודעות חדשות') }));
      } else {
        var lastDay = '';
        items.forEach(function (msg) {
          var dayStr = formatDayLabel(msg.createdAt);
          if (dayStr !== lastDay) {
            lastDay = dayStr;
            wrap.appendChild(el('div', { className: 'meta-time', text: dayStr }));
          }
          var card = el('article', {
            className: 'card',
            onClick: async function () {
              if (!msg.readAt) {
                await CN.api.request('POST', '/v1/me/inbox/read', {
                  auth: true,
                  identity: CN.state.identity,
                  settings: CN.state.settings,
                  bodyObj: { seqs: [msg.seq] },
                });
              }
              if (msg.type === 'moderation_rejected' || msg.type === 'rejected' || !msg.rootId) {
                navigate('mine');
              } else {
                openThread(msg.rootId, msg.noteId);
              }
            },
          }, [
            el('div', { className: 'card-header' }, [
              el('span', { className: 'author-name', text: (!msg.readAt ? '● ' : '') + (msg.summary || msg.actorName) }),
              el('span', { className: 'meta-time', text: CN.ui.formatRelativeTime(msg.createdAt) }),
            ]),
            (msg.reason || msg.preview)
              ? el('div', { className: 'meta-time', text: msg.reason || msg.preview })
              : null,
          ]);
          wrap.appendChild(card);
        });
      }
    } catch (_) {
      wrap.appendChild(el('div', { className: 'status-banner error', text: t('לא הצלחנו לטעון') }));
    }
    container.appendChild(wrap);
  }

  async function renderHomeScreen(container) {
    var el = CN.ui.el;
    var t = CN.ui.t;
    container.textContent = '';
    var wrap = el('div', { className: 'container-narrow' });
    wrap.appendChild(el('h2', { className: 'section-heading', text: 'מה חדש בקהילה' }));

    var lastLoc = await CN.storage.get(CN.storage.KEYS.LAST_LOCATION, null);
    if (lastLoc && lastLoc.bookUid) {
      wrap.appendChild(el('article', { className: 'card' }, [
        el('div', { className: 'settings-row-title', text: 'המקום האחרון שקראת' }),
        el('div', { className: 'meta-time', text: (lastLoc.titleHint || lastLoc.bookUid) + (lastLoc.ref ? (' · ' + lastLoc.ref) : '') }),
        el('button', {
          type: 'button',
          className: 'btn-primary',
          text: 'הצג הערות בקטע זה',
          onClick: function () {
            CN.state.context.bookUid = lastLoc.bookUid;
            CN.state.context.titleHint = lastLoc.titleHint;
            CN.state.context.bookId = lastLoc.titleHint || lastLoc.bookUid;
            CN.state.context.ref = lastLoc.ref;
            CN.state.context.sectionIndex = lastLoc.sectionIndex || 0;
            navigate('section');
          },
        }),
      ]));
    }

    if (CN.state.unreadCount > 0) {
      wrap.appendChild(el('div', { className: 'status-banner info' }, [
        el('span', { text: t('יש לך {n} הודעות חדשות בהערות הקהילה', { n: CN.state.unreadCount }) }),
        el('button', { type: 'button', className: 'link-btn', text: 'פתח הודעות', onClick: function () { navigate('messages'); } }),
      ]));
    }

    var worked = await CN.storage.get(CN.storage.KEYS.WORKED_BOOKS, []);
    if (Array.isArray(worked) && worked.length > 0) {
      wrap.appendChild(el('h3', { className: 'settings-card-title', text: 'שאלות פתוחות בספרים שלך' }));
      for (var i = 0; i < Math.min(3, worked.length); i++) {
        try {
          var qRes = await CN.api.request('GET', '/v1/questions?book=' + encodeURIComponent(worked[i].bookUid) + '&scope=book&status=open&limit=3', {
            settings: CN.state.settings,
          });
          var qItems = (qRes.ok && qRes.data && qRes.data.items) || [];
          qItems.forEach(function (q) {
            wrap.appendChild(CN.cards.buildNoteCard(q, { showReveal: false }));
          });
        } catch (_) { /* ignore */ }
      }
    }

    container.appendChild(wrap);
  }

  async function renderThreadScreen(container) {
    var el = CN.ui.el;
    var t = CN.ui.t;
    container.textContent = '';
    var wrap = el('div', { className: 'container-narrow' });

    wrap.appendChild(el('div', { className: 'section-header' }, [
      el('button', {
        type: 'button',
        className: 'btn-secondary',
        text: '← חזור',
        onClick: function () { navigate(CN.state.previousScreen || 'section'); },
      }),
      el('h2', { className: 'section-heading', text: 'שרשור דיון' }),
    ]));

    try {
      var res = await CN.api.request('GET', '/v1/notes/' + encodeURIComponent(CN.state.activeThreadId) + '/thread', {
        auth: Boolean(CN.state.identity && CN.state.identity.userId),
        identity: CN.state.identity,
        settings: CN.state.settings,
      });
      if (!res.ok || !res.data) throw new Error('השרשור לא נמצא');
      var data = res.data;
      CN.state.activeThreadData = data;
      var root = data.root;
      var isQuestion = root.kind === 'question';

      if (root.quote) {
        wrap.appendChild(el('div', { className: 'quote-box' }, [
          el('div', { className: 'quote-text', text: CN.ui.formatQuoteText(root.quote) }),
        ]));
      }
      wrap.appendChild(CN.cards.buildNoteCard(root, { inThread: true }));

      var replyKind = isQuestion ? 'answer' : 'reply';
      var replyToId = null;
      var replyTargetChip = el('div', { className: 'status-banner info hidden' });

      if (isQuestion && data.answers && data.answers.length > 0) {
        wrap.appendChild(el('h3', { className: 'settings-card-title', text: 'תשובות (' + data.answers.length + ')' }));
        data.answers.forEach(function (ans) {
          var isAccepted = root.acceptedAnswerId === ans.id;
          wrap.appendChild(CN.cards.buildNoteCard(ans, {
            inThread: true,
            showReveal: false,
            isAccepted: isAccepted,
            canAccept: root.isOwn,
            onToggleAccept: async function () {
              var accRes = await CN.api.request('PUT', '/v1/notes/' + encodeURIComponent(ans.id) + '/accept', {
                auth: true,
                identity: CN.state.identity,
                settings: CN.state.settings,
                bodyObj: { accepted: !isAccepted },
              });
              if (accRes.ok) renderThreadScreen(container);
              else CN.ui.showToast('לא ניתן לעדכן תשובה מקובלת');
            },
            onReplyTo: function (target) {
              replyKind = 'reply';
              replyToId = target.id;
              updateReplyTargetUI(target);
            },
          }));
        });
      }

      if (data.replies && data.replies.length > 0) {
        wrap.appendChild(el('h3', { className: 'settings-card-title', text: 'תגובות (' + data.replies.length + ')' }));
        data.replies.forEach(function (rep) {
          wrap.appendChild(CN.cards.buildNoteCard(rep, {
            inThread: true,
            showReveal: false,
            onReplyTo: function (target) {
              replyKind = 'reply';
              replyToId = target.id;
              updateReplyTargetUI(target);
            },
          }));
        });
      }

      // Sticky bottom reply bar
      var sticky = el('div', { className: 'sticky-reply-bar' });
      if (isQuestion) {
        var modeSeg = el('div', { className: 'chip-group' });
        [['answer', t('תשובה')], ['reply', t('תגובה')]].forEach(function (pair) {
          var b = el('button', {
            type: 'button',
            className: 'chip-btn' + (replyKind === pair[0] ? ' active' : ''),
            text: pair[1],
            onClick: function () {
              replyKind = pair[0];
              if (replyKind === 'answer') replyToId = null;
              modeSeg.querySelectorAll('.chip-btn').forEach(function (x) { x.classList.remove('active'); });
              b.classList.add('active');
            },
          });
          modeSeg.appendChild(b);
        });
        sticky.appendChild(modeSeg);
      }
      sticky.appendChild(replyTargetChip);

      var rInput = el('textarea', {
        className: 'textarea',
        placeholder: isQuestion ? 'כתוב תשובה או תגובה קצרה...' : 'כתוב תגובה...',
      });
      var rHint = el('div', { className: 'validation-hint' });
      var rBtn = el('button', { type: 'button', className: 'btn-primary', text: 'שלח', disabled: true });

      function updateReplyTargetUI(target) {
        if (!target) {
          replyTargetChip.classList.add('hidden');
          return;
        }
        replyTargetChip.textContent = '';
        replyTargetChip.appendChild(el('span', { text: 'בתגובה ל־' + target.authorName }));
        replyTargetChip.appendChild(el('button', {
          type: 'button',
          className: 'link-btn',
          text: 'נקה',
          onClick: function () { replyToId = null; updateReplyTargetUI(null); },
        }));
        replyTargetChip.classList.remove('hidden');
        rInput.focus();
      }

      rInput.addEventListener('input', function () {
        var check = CN.filter.validateLiveBody(rInput.value, root.quote || '');
        rHint.textContent = check.message || '';
        rHint.className = 'validation-hint ' + check.level;
        rBtn.disabled = !check.valid || CN.state.isOnline === false;
      });

      rBtn.addEventListener('click', async function () {
        var okReg = await CN.onboarding.ensureRegistered();
        if (!okReg) return;
        rBtn.disabled = true;
        try {
          var payload = {
            kind: replyKind,
            rootId: root.id,
            replyToId: replyToId || undefined,
            body: rInput.value.trim(),
          };
          try {
            var pow = await CN.api.fetchSolvedChallenge(CN.state.settings);
            payload.challengeToken = pow.challengeToken;
            payload.challengeNonce = pow.challengeNonce;
          } catch (_) {}

          var postRes = await CN.api.request('POST', '/v1/notes', {
            auth: true,
            identity: CN.state.identity,
            settings: CN.state.settings,
            bodyObj: payload,
          });
          if (!postRes.ok) {
            throw new Error((postRes.data && postRes.data.error && postRes.data.error.message) || 'השליחה נכשלה');
          }
          var st = postRes.data && postRes.data.note && postRes.data.note.status;
          CN.ui.showToast(st === 'pending' ? t('נשלחה לאישור. תקבל הודעה כשתפורסם') : 'התגובה נשלחה');
          renderThreadScreen(container);
        } catch (err) {
          rBtn.disabled = false;
          CN.ui.showToast(err.message || 'שגיאה בשליחה');
        }
      });

      sticky.appendChild(rInput);
      sticky.appendChild(el('div', { className: 'filter-row' }, [rHint, rBtn]));
      wrap.appendChild(sticky);
    } catch (err) {
      wrap.appendChild(el('div', { className: 'status-banner error', text: err.message || 'שגיאה בטעינת השרשור' }));
    }
    container.appendChild(wrap);
  }

  async function isShabbatOrYomTov() {
    if (!CN.state.settings.shabbatQuietMode) return false;
    if (CN.state.permissions.indexOf('calendar.read') === -1) return false;
    try {
      var res = await global.Otzaria.call('calendar.getJewishDate');
      if (res && res.success && res.data) {
        if (res.data.isShabbat) return true;
        var holidays = res.data.holidays || [];
        for (var i = 0; i < holidays.length; i++) {
          if (holidays[i] && holidays[i].kind === 'yomTov') return true;
        }
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  async function refreshInboxBadge() {
    if (!CN.state.identity || !CN.state.identity.userId) return;
    if (CN.state.isOnline === false) return;
    try {
      var res = await CN.api.request('GET', '/v1/me/inbox?after=0', {
        auth: true,
        identity: CN.state.identity,
        settings: CN.state.settings,
      });
      if (res.ok && res.data) {
        CN.state.unreadCount = Number(res.data.unreadCount || 0);
        renderChrome();
      }
    } catch (_) { /* ignore */ }
  }

  CN.app = {
    init: init,
    navigate: navigate,
    refreshCurrentScreen: refreshCurrentScreen,
    renderChrome: renderChrome,
    openThread: openThread,
    openCreateComposer: openCreateComposer,
    openEditComposer: openEditComposer,
    isShabbatOrYomTov: isShabbatOrYomTov,
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
