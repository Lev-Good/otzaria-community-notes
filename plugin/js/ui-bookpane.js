(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  var WINDOW_BEFORE = 4;
  var WINDOW_AFTER = 10;
  var STEP_SIZE = 10;

  var paneState = {
    bookKey: '',
    bookId: '',
    bookUid: '',
    titleHint: '',
    activeSectionIndex: 0,
    focusQuote: '',
    focusIsQuestion: false,
    selectionDraft: null,
    toc: [],
    tocLoaded: false,
    sections: {},
    rangeStart: 0,
    rangeEnd: -1,
    eof: false,
    loading: false,
    error: '',
  };

  var bookMemoryCache = {};
  var renderEpoch = 0;

  function makeBookKey(bookUid, bookId) {
    return String(bookUid || bookId || '');
  }

  function isWideScreen() {
    return typeof window !== 'undefined' && window.innerWidth ? window.innerWidth >= 840 : true;
  }

  function shouldShowBookPane() {
    var ctx = CN.state.context;
    if (!ctx || !ctx.bookUid || CN.state.isPdf) return false;
    var screen = CN.state.screen;
    if (CN.state.bookPaneOpenOverride === true) return true;
    if (CN.state.bookPaneOpenOverride === false) return false;

    var pref = (CN.state.settings && CN.state.settings.splitBookPane) || 'auto';
    if (pref === 'off') return false;
    if (pref === 'always') {
      return ['section', 'compose', 'thread', 'import', 'questions', 'mine', 'home'].indexOf(screen) !== -1;
    }
    // 'auto': open on wide viewports when viewing section, composing, or reading thread
    return isWideScreen() && (screen === 'compose' || screen === 'section' || screen === 'thread');
  }

  function isVisible() {
    var el = document.getElementById('book-pane');
    return Boolean(el && !el.classList.contains('hidden'));
  }

  async function fetchSection(bookId, bookUid, sectionIndex) {
    if (sectionIndex < 0) return null;
    try {
      var res = await global.Otzaria.call('reader.getSectionTextMap', {
        bookId: bookId,
        bookUid: (bookUid && bookUid !== bookId) ? bookUid : undefined,
        sectionIndex: sectionIndex,
        layer: 'both',
        includeSourceMap: false,
        includeWords: false,
        includeChars: false,
      });
      if (res && res.success && res.data && (res.data.renderedText !== undefined || res.data.sourceText !== undefined)) {
        return {
          sectionIndex: typeof res.data.sectionIndex === 'number' ? res.data.sectionIndex : sectionIndex,
          ref: res.data.currentRef || '',
          renderedText: String(res.data.renderedText != null ? res.data.renderedText : (res.data.sourceText || '')).replace(/\u2060/g, ''),
          sourceText: String(res.data.sourceText != null ? res.data.sourceText : (res.data.renderedText || '')).replace(/\u2060/g, ''),
        };
      }
    } catch (_) {
      // ignore out of range or unavailable section
    }
    return null;
  }

  async function ensureTocLoaded(entry) {
    if (entry.tocLoaded) return;
    entry.tocLoaded = true;
    try {
      var res = await global.Otzaria.call('library.getBookToc', {
        bookId: entry.bookId || entry.titleHint || entry.bookUid,
        bookUid: (entry.bookUid && entry.bookUid !== entry.bookId) ? entry.bookUid : undefined,
      });
      if (res && res.success && Array.isArray(res.data)) {
        entry.toc = res.data;
      }
    } catch (_) {
      entry.toc = [];
    }
  }

  async function fetchRange(entry, startIdx, endIdx) {
    var from = Math.max(0, startIdx);
    var to = Math.max(from, endIdx);
    var indicesToLoad = [];
    for (var i = from; i <= to; i++) {
      if (!entry.sections[i]) indicesToLoad.push(i);
    }

    var hitEnd = false;
    for (var k = 0; k < indicesToLoad.length; k += 5) {
      var chunk = indicesToLoad.slice(k, k + 5);
      var results = await Promise.all(chunk.map(function (idx) {
        return fetchSection(entry.bookId || entry.titleHint || entry.bookUid, entry.bookUid, idx);
      }));
      for (var r = 0; r < results.length; r++) {
        var idx = chunk[r];
        if (results[r]) {
          entry.sections[idx] = results[r];
        } else if (idx >= from) {
          hitEnd = true;
        }
      }
    }

    // Update contiguous bounds around loaded items
    var keys = Object.keys(entry.sections).map(Number).sort(function (a, b) { return a - b; });
    if (keys.length > 0) {
      entry.rangeStart = keys[0];
      entry.rangeEnd = keys[keys.length - 1];
    } else {
      entry.rangeStart = from;
      entry.rangeEnd = -1;
    }
    if (hitEnd) entry.eof = true;
  }

  function getOrCreateCacheEntry(bookId, bookUid, titleHint) {
    var key = makeBookKey(bookUid, bookId);
    if (!bookMemoryCache[key]) {
      // Keep at most 4 books in memory
      var existingKeys = Object.keys(bookMemoryCache);
      if (existingKeys.length >= 4) delete bookMemoryCache[existingKeys[0]];
      bookMemoryCache[key] = {
        bookKey: key,
        bookId: bookId || titleHint || bookUid,
        bookUid: bookUid || bookId,
        titleHint: titleHint || bookId || bookUid,
        toc: [],
        tocLoaded: false,
        sections: {},
        rangeStart: 0,
        rangeEnd: -1,
        eof: false,
      };
    } else {
      if (bookId) bookMemoryCache[key].bookId = bookId;
      if (titleHint) bookMemoryCache[key].titleHint = titleHint;
    }
    return bookMemoryCache[key];
  }

  function syncActiveStateFromEntry(entry) {
    paneState.bookKey = entry.bookKey;
    paneState.bookId = entry.bookId;
    paneState.bookUid = entry.bookUid;
    paneState.titleHint = entry.titleHint;
    paneState.toc = entry.toc;
    paneState.tocLoaded = entry.tocLoaded;
    paneState.sections = entry.sections;
    paneState.rangeStart = entry.rangeStart;
    paneState.rangeEnd = entry.rangeEnd;
    paneState.eof = entry.eof;
  }

  async function loadWindowAt(bookId, bookUid, titleHint, targetIndex) {
    var idx = Math.max(0, Number(targetIndex) || 0);
    var entry = getOrCreateCacheEntry(bookId, bookUid, titleHint);
    paneState.loading = true;
    paneState.error = '';
    paneState.activeSectionIndex = idx;
    syncActiveStateFromEntry(entry);

    var epoch = ++renderEpoch;
    renderBookPaneDom();

    try {
      await Promise.all([
        ensureTocLoaded(entry),
        fetchRange(entry, Math.max(0, idx - WINDOW_BEFORE), idx + WINDOW_AFTER),
      ]);
    } catch (err) {
      paneState.error = (err && err.message) || 'לא הצלחנו לטעון את טקסט הספר';
    } finally {
      paneState.loading = false;
      syncActiveStateFromEntry(entry);
      if (renderEpoch === epoch && isVisible()) {
        renderBookPaneDom({ scrollToActive: true });
      }
    }
  }

  function getNoteHighlightsForSection(sectionIndex) {
    var notes = CN.state.sectionNotes || [];
    var items = [];
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (!n || !n.quote) continue;
      var locSec = (n._anchor && n._anchor.sectionIndex !== undefined)
        ? Number(n._anchor.sectionIndex)
        : Number(n.sectionHint);
      if (locSec === Number(sectionIndex)) {
        items.push({
          quote: n.quote,
          isQuestion: n.kind === 'question' && n.questionStatus === 'open',
          isFocus: Boolean(paneState.focusQuote && n.quote === paneState.focusQuote),
        });
      }
    }
    if (paneState.focusQuote && paneState.activeSectionIndex === Number(sectionIndex)) {
      var already = items.some(function (x) { return x.quote === paneState.focusQuote; });
      if (!already) {
        items.unshift({ quote: paneState.focusQuote, isQuestion: paneState.focusIsQuestion, isFocus: true });
      }
    }
    return items;
  }

  /**
   * Safe plain-text highlighter using text nodes + <mark> (never innerHTML).
   */
  /**
   * Finds the exact [start, end) character span in rawText that corresponds to query
   * after stripping Hebrew niqqud/cantillation, collapsing whitespace runs to a single space,
   * and lowercasing.
   */
  function findNormalizedSpan(rawText, query) {
    var src = String(rawText || '');
    var q = String(query || '').trim();
    if (!src || !q) return null;

    var directIdx = src.indexOf(q);
    if (directIdx !== -1) {
      var directEnd = directIdx + q.length;
      while (directEnd < src.length && /[\u0591-\u05C7]/.test(src[directEnd])) directEnd++;
      var countBefore = 0;
      var searchFrom = 0;
      while (searchFrom < directIdx) {
        var hit = src.indexOf(q, searchFrom);
        if (hit === -1 || hit >= directIdx) break;
        countBefore++;
        searchFrom = hit + 1;
      }
      return { start: directIdx, end: directEnd, occurrence: countBefore };
    }

    var normQ = CN.anchors ? CN.anchors.normalizeCompare(q) : q.replace(/[\u0591-\u05C7]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!normQ) return null;

    var normChars = [];
    var normToRawStart = [];
    var normToRawEnd = [];
    var inSpace = false;

    for (var i = 0; i < src.length; i++) {
      var ch = src[i];
      if (/[\u0591-\u05C7]/.test(ch)) {
        if (normToRawEnd.length > 0) normToRawEnd[normToRawEnd.length - 1] = i + 1;
        continue;
      }
      if (/\s/.test(ch)) {
        if (!inSpace && normChars.length > 0) {
          normChars.push(' ');
          normToRawStart.push(i);
          normToRawEnd.push(i + 1);
          inSpace = true;
        } else if (inSpace && normToRawEnd.length > 0) {
          normToRawEnd[normToRawEnd.length - 1] = i + 1;
        }
        continue;
      }
      inSpace = false;
      normChars.push(ch.toLowerCase());
      normToRawStart.push(i);
      normToRawEnd.push(i + 1);
    }

    var normStr = normChars.join('');
    var matchIdx = normStr.indexOf(normQ);
    if (matchIdx === -1) return null;

    var startRaw = normToRawStart[matchIdx];
    var endRaw = normToRawEnd[matchIdx + normQ.length - 1];
    while (endRaw < src.length && /[\u0591-\u05C7]/.test(src[endRaw])) endRaw++;

    var occ = 0;
    var sf = 0;
    while (sf < matchIdx) {
      var h = normStr.indexOf(normQ, sf);
      if (h === -1 || h >= matchIdx) break;
      occ++;
      sf = h + 1;
    }

    return { start: startRaw, end: endRaw, occurrence: occ };
  }

  function renderSafeHighlightedSectionText(container, text, highlights) {
    container.textContent = '';
    var src = String(text || '');
    if (!highlights || highlights.length === 0) {
      container.textContent = src;
      return;
    }

    // Find first non-overlapping match per highlight quote (normalized comparison fallback)
    var ranges = [];
    for (var i = 0; i < highlights.length; i++) {
      var q = String(highlights[i].quote || '').trim();
      if (!q) continue;
      var span = findNormalizedSpan(src, q);
      if (span) {
        ranges.push({
          start: span.start,
          end: span.end,
          isQuestion: highlights[i].isQuestion,
          isFocus: highlights[i].isFocus,
        });
      }
    }

    if (ranges.length === 0) {
      container.textContent = src;
      return;
    }

    ranges.sort(function (a, b) { return a.start - b.start || (b.isFocus ? 1 : 0) - (a.isFocus ? 1 : 0); });
    var cursor = 0;
    for (var r = 0; r < ranges.length; r++) {
      var rg = ranges[r];
      if (rg.start < cursor) continue;
      if (rg.start > cursor) {
        container.appendChild(document.createTextNode(src.slice(cursor, rg.start)));
      }
      var mark = CN.ui.el('mark', {
        className: 'book-inline-hl' + (rg.isQuestion ? ' question' : '') + (rg.isFocus ? ' active-focus' : ''),
        text: src.slice(rg.start, rg.end),
      });
      container.appendChild(mark);
      cursor = rg.end;
    }
    if (cursor < src.length) {
      container.appendChild(document.createTextNode(src.slice(cursor)));
    }
  }

  function buildAnchorForSectionAndSelection(sec, selectedText) {
    var cleanSel = String(selectedText || '').replace(/\u2060/g, '').trim();
    var tooLong = cleanSel.length > CN.config.MAX_SELECTION_CHARS;
    var quote = cleanSel.slice(0, CN.config.MAX_QUOTE_CHARS).trim();
    var prefix = '';
    var suffix = '';
    var occurrence = 0;

    if (quote && sec) {
      var baseText = sec.sourceText || sec.renderedText || '';
      var span = findNormalizedSpan(baseText, quote);
      if (span) {
        prefix = baseText.slice(Math.max(0, span.start - CN.config.CONTEXT_CHARS), span.start);
        suffix = baseText.slice(span.end, span.end + CN.config.CONTEXT_CHARS);
        occurrence = span.occurrence || 0;
      }
    }

    return {
      bookUid: paneState.bookUid || paneState.bookId,
      bookId: paneState.bookId || paneState.titleHint || paneState.bookUid,
      titleHint: paneState.titleHint || paneState.bookId || paneState.bookUid,
      ref: (sec && sec.ref) || '',
      sectionHint: sec ? sec.sectionIndex : paneState.activeSectionIndex,
      quote: quote,
      prefix: prefix,
      suffix: suffix,
      occurrence: occurrence,
      libVersion: '',
      multiParagraph: false,
      tooLongTruncated: tooLong,
      sourceRange: null,
    };
  }

  function applyAnchorToPlugin(anchor, { openComposer = false } = {}) {
    if (!anchor) return;
    if (CN.state.screen === 'compose' && !openComposer) {
      if (CN.composer && CN.composer.updateComposeAnchor) {
        CN.composer.updateComposeAnchor(anchor);
        CN.ui.showToast('המיקום להערה עודכן ל־' + (anchor.ref || ('מקטע ' + (anchor.sectionHint + 1))));
      }
      return;
    }

    CN.state.context = Object.assign({}, CN.state.context, {
      bookUid: anchor.bookUid,
      bookId: anchor.bookId,
      titleHint: anchor.titleHint,
      ref: anchor.ref,
      sectionIndex: anchor.sectionHint,
      anchor: anchor,
      clickedHighlightIds: [],
    });
    if (openComposer) {
      CN.app.openCreateComposer(anchor);
    } else {
      CN.state.sectionFocusOnly = false;
      CN.app.renderChrome();
      CN.app.navigate('section');
    }
  }

  function renderBookPaneDom(opts) {
    var pane = document.getElementById('book-pane');
    if (!pane) return;

    var show = shouldShowBookPane();
    pane.classList.toggle('hidden', !show);
    if (!show) return;

    var el = CN.ui.el;
    var scrollToActive = opts && opts.scrollToActive;
    var scrollContainerPrev = pane.querySelector('.book-pane-body');
    var prevScrollTop = (!scrollToActive && scrollContainerPrev) ? scrollContainerPrev.scrollTop : null;

    pane.textContent = '';

    // 1. Header with TOC dropdown, Prev/Next, Open in full reader, Close
    var header = el('div', { className: 'book-pane-head' });

    var topRow = el('div', { className: 'section-header' }, [
      el('div', { className: 'section-title-group' }, [
        el('div', { className: 'settings-row-title', text: paneState.titleHint || paneState.bookId || 'ספר' }),
        el('div', {
          className: 'meta-time',
          text: paneState.sections[paneState.activeSectionIndex] && paneState.sections[paneState.activeSectionIndex].ref
            ? paneState.sections[paneState.activeSectionIndex].ref
            : ('מקטע ' + (paneState.activeSectionIndex + 1)),
        }),
      ]),
      el('div', { className: 'card-actions-group' }, [
        el('button', {
          type: 'button',
          className: 'action-btn',
          text: 'פתח בקורא',
          onClick: async function () {
            try {
              await global.Otzaria.call('reader.openBookAtRef', {
                bookId: paneState.bookId || paneState.titleHint || paneState.bookUid,
                bookUid: (paneState.bookUid && paneState.bookUid !== paneState.bookId) ? paneState.bookUid : undefined,
                index: paneState.activeSectionIndex,
                highlight: true,
              });
            } catch (_) { /* ignore */ }
          },
        }),
        el('button', {
          type: 'button',
          className: 'action-btn',
          'aria-label': 'סגור תצוגת ספר',
          title: 'סגור תצוגת ספר',
          onClick: function () {
            CN.state.bookPaneOpenOverride = false;
            CN.app.renderChrome();
            renderBookPaneDom();
          },
        }, CN.ui.getSvgIcon('close')),
      ]),
    ]);
    header.appendChild(topRow);

    // TOC & Section nav row
    var navRow = el('div', { className: 'filter-row' });
    if (paneState.toc && paneState.toc.length > 0) {
      var tocSelect = el('select', { className: 'select-compact', 'aria-label': 'ניווט בתוכן העניינים' });
      var activeTocIdx = paneState.toc[0].index;
      for (var tIdx = 0; tIdx < paneState.toc.length; tIdx++) {
        var entry = paneState.toc[tIdx];
        if (entry.index <= paneState.activeSectionIndex) activeTocIdx = entry.index;
        var indent = entry.level > 1 ? '  '.repeat(Math.min(3, entry.level - 1)) + '· ' : '';
        tocSelect.appendChild(el('option', {
          value: String(entry.index),
          text: indent + entry.text,
        }));
      }
      tocSelect.value = String(activeTocIdx);
      tocSelect.addEventListener('change', function () {
        var nextIdx = Number(tocSelect.value) || 0;
        loadWindowAt(paneState.bookId, paneState.bookUid, paneState.titleHint, nextIdx);
      });
      navRow.appendChild(tocSelect);
    }

    var stepBtns = el('div', { className: 'card-actions-group' }, [
      el('button', {
        type: 'button',
        className: 'action-btn',
        text: '▲ הקודם',
        disabled: paneState.activeSectionIndex <= 0,
        onClick: function () {
          loadWindowAt(paneState.bookId, paneState.bookUid, paneState.titleHint, Math.max(0, paneState.activeSectionIndex - 1));
        },
      }),
      el('button', {
        type: 'button',
        className: 'action-btn',
        text: 'הבא ▼',
        onClick: function () {
          loadWindowAt(paneState.bookId, paneState.bookUid, paneState.titleHint, paneState.activeSectionIndex + 1);
        },
      }),
    ]);
    navRow.appendChild(stepBtns);
    header.appendChild(navRow);
    pane.appendChild(header);

    // 2. Selection quick-anchor bar (appears dynamically on text selection)
    var selBar = el('div', { className: 'book-pane-selection-bar hidden', id: 'book-pane-selection-bar' });
    pane.appendChild(selBar);

    function refreshSelectionBar() {
      selBar.textContent = '';
      if (!paneState.selectionDraft) {
        selBar.classList.add('hidden');
        return;
      }
      selBar.classList.remove('hidden');
      var draft = paneState.selectionDraft;
      selBar.appendChild(el('span', {
        text: 'נבחר: ״' + draft.quote.slice(0, 45) + (draft.quote.length > 45 ? '...' : '') + '״',
      }));
      selBar.appendChild(el('div', { className: 'card-actions-group' }, [
        el('button', {
          type: 'button',
          className: 'btn-primary',
          text: CN.state.screen === 'compose' ? 'עגן ציטוט להערה' : '+ הערה על סימון זה',
          onClick: function () {
            var anchor = draft;
            paneState.selectionDraft = null;
            refreshSelectionBar();
            applyAnchorToPlugin(anchor, { openComposer: CN.state.screen !== 'compose' });
          },
        }),
        el('button', {
          type: 'button',
          className: 'action-btn',
          text: 'נקה',
          onClick: function () {
            paneState.selectionDraft = null;
            refreshSelectionBar();
          },
        }),
      ]));
    }
    refreshSelectionBar();

    // 3. Body with paragraphs
    var body = el('div', { className: 'book-pane-body' });

    if (paneState.loading && Object.keys(paneState.sections).length === 0) {
      body.appendChild(el('div', { className: 'skeleton-card' }));
      body.appendChild(el('div', { className: 'skeleton-card' }));
      pane.appendChild(body);
      return;
    }

    if (paneState.error && Object.keys(paneState.sections).length === 0) {
      body.appendChild(el('div', { className: 'status-banner error', text: paneState.error }));
      pane.appendChild(body);
      return;
    }

    if (paneState.rangeStart > 0) {
      body.appendChild(el('div', { className: 'floating-cta' }, [
        el('button', {
          type: 'button',
          className: 'btn-secondary',
          text: '▲ טען מקטעים קודמים',
          onClick: async function () {
            var cacheEntry = getOrCreateCacheEntry(paneState.bookId, paneState.bookUid, paneState.titleHint);
            var targetStart = Math.max(0, cacheEntry.rangeStart - STEP_SIZE);
            await fetchRange(cacheEntry, targetStart, cacheEntry.rangeStart - 1);
            syncActiveStateFromEntry(cacheEntry);
            renderBookPaneDom();
          },
        }),
      ]));
    }

    var sortedIndices = Object.keys(paneState.sections).map(Number).sort(function (a, b) { return a - b; });
    var activeSecNode = null;

    sortedIndices.forEach(function (secIdx) {
      var sec = paneState.sections[secIdx];
      if (!sec) return;
      var isActive = secIdx === paneState.activeSectionIndex;
      var isComposing = CN.state.screen === 'compose';
      var secEl = el('div', {
        className: 'book-sec' + (isActive ? ' active' : ''),
        dataset: { sectionIndex: String(secIdx) },
      });
      if (isActive) activeSecNode = secEl;

      var headActions = el('div', { className: 'card-actions-group' });
      headActions.appendChild(el('button', {
        type: 'button',
        className: 'link-btn',
        text: isComposing ? 'עגן לכאן' : '+ הערה',
        onClick: function (ev) {
          ev.stopPropagation();
          var anchor = buildAnchorForSectionAndSelection(sec, '');
          applyAnchorToPlugin(anchor, { openComposer: !isComposing });
        },
      }));
      if (!isComposing) {
        headActions.appendChild(el('button', {
          type: 'button',
          className: 'link-btn',
          text: 'הצג הערות',
          onClick: function (ev) {
            ev.stopPropagation();
            paneState.activeSectionIndex = secIdx;
            var anchor = buildAnchorForSectionAndSelection(sec, '');
            applyAnchorToPlugin(anchor, { openComposer: false });
          },
        }));
      }

      secEl.appendChild(el('div', { className: 'book-sec-head' }, [
        el('span', { text: sec.ref || ('מקטע ' + (secIdx + 1)) }),
        headActions,
      ]));

      var pText = el('div', { className: 'book-sec-text' });
      renderSafeHighlightedSectionText(pText, sec.renderedText || sec.sourceText || '', getNoteHighlightsForSection(secIdx));

      pText.addEventListener('mouseup', function () {
        var sel = global.getSelection ? global.getSelection() : null;
        var selectedStr = sel ? String(sel.toString() || '').trim() : '';
        if (selectedStr && selectedStr.length >= 2) {
          paneState.activeSectionIndex = secIdx;
          paneState.selectionDraft = buildAnchorForSectionAndSelection(sec, selectedStr);
          refreshSelectionBar();
        }
      });

      secEl.addEventListener('click', function () {
        var sel = global.getSelection ? global.getSelection() : null;
        if (sel && String(sel.toString() || '').trim().length >= 2) return;
        paneState.activeSectionIndex = secIdx;
        pane.querySelectorAll('.book-sec.active').forEach(function (n) { n.classList.remove('active'); });
        secEl.classList.add('active');
      });

      secEl.appendChild(pText);
      body.appendChild(secEl);
    });

    if (!paneState.eof && sortedIndices.length > 0) {
      body.appendChild(el('div', { className: 'floating-cta' }, [
        el('button', {
          type: 'button',
          className: 'btn-secondary',
          text: '▼ טען מקטעים הבאים',
          onClick: async function () {
            var cacheEntry = getOrCreateCacheEntry(paneState.bookId, paneState.bookUid, paneState.titleHint);
            var startAt = cacheEntry.rangeEnd + 1;
            await fetchRange(cacheEntry, startAt, startAt + STEP_SIZE - 1);
            syncActiveStateFromEntry(cacheEntry);
            renderBookPaneDom();
          },
        }),
      ]));
    }

    pane.appendChild(body);

    if (scrollToActive && activeSecNode) {
      setTimeout(function () {
        if (typeof activeSecNode.scrollIntoView === 'function') {
          activeSecNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 30);
    } else if (prevScrollTop !== null) {
      body.scrollTop = prevScrollTop;
    }
  }

  async function syncToContext() {
    var show = shouldShowBookPane();
    var pane = document.getElementById('book-pane');
    if (pane) pane.classList.toggle('hidden', !show);
    if (!show) return;

    var ctx = CN.state.context;
    var bookKey = makeBookKey(ctx.bookUid, ctx.bookId || ctx.titleHint);
    var targetIdx = Math.max(0, Number(ctx.sectionIndex) || 0);
    if (CN.state.screen === 'compose' && CN.state.compose && CN.state.compose.anchor && typeof CN.state.compose.anchor.sectionHint === 'number') {
      targetIdx = Math.max(0, CN.state.compose.anchor.sectionHint);
    }
    if (CN.state.screen === 'compose' && CN.state.compose && CN.state.compose.anchor && CN.state.compose.anchor.quote) {
      paneState.focusQuote = CN.state.compose.anchor.quote;
    }

    var cacheEntry = getOrCreateCacheEntry(ctx.bookId || ctx.titleHint, ctx.bookUid, ctx.titleHint);
    var alreadyLoaded = paneState.bookKey === bookKey && Boolean(cacheEntry.sections[targetIdx]);
    paneState.activeSectionIndex = targetIdx;

    if (alreadyLoaded) {
      syncActiveStateFromEntry(cacheEntry);
      renderBookPaneDom({ scrollToActive: true });
    } else {
      await loadWindowAt(ctx.bookId || ctx.titleHint || ctx.bookUid, ctx.bookUid, ctx.titleHint, targetIdx);
    }
  }

  async function focusLocation({ bookId, bookUid, titleHint, sectionIndex, quote, isQuestion }) {
    var ctx = CN.state.context || {};
    var bUid = bookUid || ctx.bookUid || bookId;
    var bId = bookId || ctx.bookId || ctx.titleHint || bUid;
    var tHint = titleHint || ctx.titleHint || bId;

    paneState.focusQuote = quote || '';
    paneState.focusIsQuestion = Boolean(isQuestion);
    CN.state.bookPaneOpenOverride = true;
    CN.app.renderChrome();

    var idx = Math.max(0, Number(sectionIndex) || 0);
    var entry = getOrCreateCacheEntry(bId, bUid, tHint);
    if (paneState.bookKey === entry.bookKey && entry.sections[idx]) {
      paneState.activeSectionIndex = idx;
      syncActiveStateFromEntry(entry);
      renderBookPaneDom({ scrollToActive: true });
    } else {
      await loadWindowAt(bId, bUid, tHint, idx);
    }
  }

  CN.bookPane = {
    state: paneState,
    shouldShowBookPane: shouldShowBookPane,
    isVisible: isVisible,
    syncToContext: syncToContext,
    renderBookPaneDom: renderBookPaneDom,
    focusLocation: focusLocation,
    buildAnchorForSectionAndSelection: buildAnchorForSectionAndSelection,
    findNormalizedSpan: findNormalizedSpan,
  };
})(typeof window !== 'undefined' ? window : globalThis);
