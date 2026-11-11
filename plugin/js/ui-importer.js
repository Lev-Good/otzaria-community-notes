(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  var UPLOADED_LOG_KEY = 'import:uploaded:v1';
  var INITIAL_RENDER_LIMIT = 40;

  var importerState = {
    loading: false,
    loaded: false,
    permissionMissing: false,
    error: '',
    books: [],
    items: [],
    bookFilter: 'all',
    statusFilter: 'all',
    renderLimit: INITIAL_RENDER_LIMIT,
    attachQuoteAll: false,
    uploading: false,
    stopRequested: false,
    progressDone: 0,
    progressTotal: 0,
    lastSummary: '',
  };

  var bookInfoCache = {};
  var enrichEpoch = 0;

  function makePersonalKey(bookId, personalId) {
    return String(bookId || '') + '::' + String(personalId || '');
  }

  function makeBodyFingerprint(bookUidOrId, body) {
    return String(bookUidOrId || '').trim().toLowerCase() + '|' + CN.filter.normalizeText(body || '').trim();
  }

  async function resolveBookMeta(bookId) {
    if (!bookId) return { bookUid: '', titleHint: '' };
    if (bookInfoCache[bookId]) return bookInfoCache[bookId];

    var fallback = { bookUid: bookId, titleHint: bookId };
    try {
      var res = await global.Otzaria.call('library.findBooks', { query: bookId, limit: 10 });
      var list = (res && res.success && Array.isArray(res.data)) ? res.data : [];
      var match = null;
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (b && (b.bookId === bookId || b.title === bookId)) {
          match = b;
          break;
        }
      }
      if (!match && list.length > 0) match = list[0];
      if (match) {
        var uid = match.bookUid
          || (match.id != null ? ('id:' + match.id) : (match.bookId || bookId));
        var resolved = {
          bookUid: String(uid || bookId),
          titleHint: String(match.title || match.bookId || bookId),
        };
        bookInfoCache[bookId] = resolved;
        return resolved;
      }
    } catch (_) {
      // ignore if library lookup unavailable
    }
    bookInfoCache[bookId] = fallback;
    return fallback;
  }

  async function enrichItemContext(item) {
    if (!item || item._enriched) return item;
    item._enriched = true;
    try {
      var res = await global.Otzaria.call('reader.getSectionTextMap', {
        bookId: item.bookId,
        bookUid: (item.bookUid && item.bookUid !== item.bookId) ? item.bookUid : undefined,
        sectionIndex: Math.max(0, Number(item.lineNumber) || 0),
        layer: 'source',
        includeSourceMap: false,
        includeWords: false,
        includeChars: false,
      });
      if (res && res.success && res.data) {
        if (res.data.currentRef) item.ref = String(res.data.currentRef);
        if (res.data.sourceText) {
          item.sourceText = String(res.data.sourceText).replace(/\u2060/g, '').replace(/\s+/g, ' ').trim();
        }
      }
    } catch (_) {
      // book may not be indexed or line out of range; keep lineNumber hint
    }
    return item;
  }

  async function fetchUploadedServerFingerprints() {
    var set = {};
    if (!CN.state.identity || !CN.state.identity.userId || CN.state.isOnline === false) return set;
    try {
      var res = await CN.api.request('GET', '/v1/me/notes', {
        auth: true,
        identity: CN.state.identity,
        settings: CN.state.settings,
      });
      var items = (res.ok && res.data && Array.isArray(res.data.items)) ? res.data.items : [];
      for (var i = 0; i < items.length; i++) {
        var n = items[i];
        if (!n || n.status === 'deleted') continue;
        if (n.bookUid) set[makeBodyFingerprint(n.bookUid, n.body)] = true;
        if (n.titleHint) set[makeBodyFingerprint(n.titleHint, n.body)] = true;
      }
    } catch (_) {
      // ignore offline or unauthenticated
    }
    return set;
  }

  function revalidateItem(item) {
    var quoteCandidate = (item.attachQuote && item.sourceText)
      ? item.sourceText.slice(0, CN.config.MAX_QUOTE_CHARS).trim()
      : '';
    item.validation = CN.filter.validateLiveBody(item.body, quoteCandidate);
    return item.validation;
  }

  async function loadPersonalNotesCatalog(opts) {
    var force = opts && opts.force;
    if (importerState.loading) return importerState;
    if (importerState.loaded && !force) return importerState;

    importerState.loading = true;
    importerState.error = '';
    importerState.permissionMissing = false;
    importerState.lastSummary = '';

    try {
      var sumRes = await global.Otzaria.call('notes.getBookNotesSummary');
      if (!sumRes || !sumRes.success) {
        var errMsg = (sumRes && sumRes.error && String(sumRes.error.message || sumRes.error.code || '')) || '';
        if (errMsg.toLowerCase().indexOf('permission') !== -1 || (sumRes && sumRes.error && sumRes.error.code === 'permission_denied')) {
          importerState.permissionMissing = true;
        }
        throw new Error(errMsg || 'לא ניתן לקרוא הערות אישיות');
      }

      var summaries = Array.isArray(sumRes.data) ? sumRes.data.slice() : [];
      var uploadedMap = (await CN.storage.get(UPLOADED_LOG_KEY, {})) || {};
      var serverFingerprints = await fetchUploadedServerFingerprints();

      var books = [];
      var allItems = [];

      // Fetch book lists & book metadata in bounded batches of 4 books
      for (var i = 0; i < summaries.length; i += 4) {
        var batch = summaries.slice(i, i + 4);
        var batchResults = await Promise.all(batch.map(async function (s) {
          var meta = await resolveBookMeta(s.bookId);
          var listRes = await global.Otzaria.call('notes.list', { bookId: s.bookId });
          var list = (listRes && listRes.success && Array.isArray(listRes.data)) ? listRes.data : [];
          return { summary: s, meta: meta, notes: list };
        }));

        for (var bIdx = 0; bIdx < batchResults.length; bIdx++) {
          var entry = batchResults[bIdx];
          if (!entry.notes.length) continue;
          books.push({
            bookId: entry.summary.bookId,
            titleHint: entry.meta.titleHint || entry.summary.bookId,
            bookUid: entry.meta.bookUid || entry.summary.bookId,
            count: entry.notes.length,
          });

          for (var nIdx = 0; nIdx < entry.notes.length; nIdx++) {
            var raw = entry.notes[nIdx];
            var body = String(raw.contentPlain || raw.content || '').replace(/\r\n/g, '\n').trim();
            var pKey = makePersonalKey(entry.summary.bookId, raw.id);
            var already = Boolean(
              uploadedMap[pKey]
              || serverFingerprints[makeBodyFingerprint(entry.meta.bookUid, body)]
              || serverFingerprints[makeBodyFingerprint(entry.summary.bookId, body)]
            );
            var item = {
              key: pKey,
              personalId: String(raw.id || nIdx),
              bookId: entry.summary.bookId,
              bookUid: entry.meta.bookUid || entry.summary.bookId,
              titleHint: entry.meta.titleHint || entry.summary.bookId,
              lineNumber: typeof raw.lineNumber === 'number' ? raw.lineNumber : 0,
              ref: '',
              sourceText: '',
              originalBody: body,
              body: body,
              kind: 'note',
              attachQuote: importerState.attachQuoteAll,
              alreadyUploaded: already,
              selected: false,
              uploadStatus: already ? 'existing' : 'idle',
              uploadMessage: '',
              _enriched: false,
            };
            revalidateItem(item);
            item.selected = Boolean(item.validation.valid && !already);
            allItems.push(item);
          }
        }
      }

      importerState.books = books;
      importerState.items = allItems;
      importerState.loaded = true;
      importerState.renderLimit = INITIAL_RENDER_LIMIT;
      if (importerState.bookFilter !== 'all' && !books.some(function (bk) { return bk.bookId === importerState.bookFilter; })) {
        importerState.bookFilter = 'all';
      }
    } catch (err) {
      if (CN.state.permissions && CN.state.permissions.indexOf('notes.read') === -1) {
        importerState.permissionMissing = true;
      }
      importerState.error = (err && err.message) || 'לא ניתן לקרוא את ההערות האישיות';
    } finally {
      importerState.loading = false;
    }

    return importerState;
  }

  function getFilteredItems() {
    return importerState.items.filter(function (item) {
      if (importerState.bookFilter !== 'all' && item.bookId !== importerState.bookFilter) return false;
      if (importerState.statusFilter === 'ready') return !item.alreadyUploaded && item.validation.valid;
      if (importerState.statusFilter === 'invalid') return !item.alreadyUploaded && !item.validation.valid;
      if (importerState.statusFilter === 'uploaded') return item.alreadyUploaded || item.uploadStatus === 'published' || item.uploadStatus === 'pending';
      return true;
    });
  }

  async function uploadSelectedNotes(itemsToUpload, callbacks) {
    var cb = callbacks || {};
    var queue = (itemsToUpload || importerState.items).filter(function (it) {
      return it.selected && !it.alreadyUploaded && revalidateItem(it).valid;
    });
    if (queue.length === 0) return { uploaded: 0, published: 0, pending: 0, failed: 0, stoppedEarly: false };

    var registered = await CN.onboarding.ensureRegistered();
    if (!registered) return { uploaded: 0, published: 0, pending: 0, failed: 0, stoppedEarly: true };

    importerState.uploading = true;
    importerState.stopRequested = false;
    importerState.progressDone = 0;
    importerState.progressTotal = queue.length;

    var uploadedLog = (await CN.storage.get(UPLOADED_LOG_KEY, {})) || {};
    var summary = { uploaded: 0, published: 0, pending: 0, rejected: 0, failed: 0, stoppedEarly: false, stopReason: '' };

    try {
      for (var i = 0; i < queue.length; i++) {
        if (importerState.stopRequested || (cb.shouldStop && cb.shouldStop())) {
          summary.stoppedEarly = true;
          summary.stopReason = 'העלאה הופסקה לפי בקשתך';
          break;
        }

        var item = queue[i];
        item.uploadStatus = 'uploading';
        item.uploadMessage = '';
        if (cb.onItemUpdate) cb.onItemUpdate(item);

        if (!item._enriched) {
          await enrichItemContext(item);
        }

        var quote = (item.attachQuote && item.sourceText)
          ? item.sourceText.slice(0, CN.config.MAX_QUOTE_CHARS).trim()
          : '';

        var payload = {
          kind: item.kind === 'question' ? 'question' : 'note',
          bookUid: item.bookUid || item.bookId,
          titleHint: item.titleHint || item.bookId,
          ref: item.ref || '',
          sectionHint: Math.max(0, Number(item.lineNumber) || 0),
          quote: quote,
          prefix: '',
          suffix: '',
          occurrence: 0,
          libVersion: '',
          body: item.body.trim(),
        };

        try {
          var pow = await CN.api.fetchSolvedChallenge(CN.state.settings);
          payload.challengeToken = pow.challengeToken;
          payload.challengeNonce = pow.challengeNonce;
        } catch (_) {
          // Optional when server disables PoW for active users
        }

        try {
          var res = await CN.api.request('POST', '/v1/notes', {
            auth: true,
            identity: CN.state.identity,
            settings: CN.state.settings,
            bodyObj: payload,
          });

          if (!res.ok) {
            var code = res.data && res.data.error && res.data.error.code;
            var msg = (res.data && res.data.error && res.data.error.message) || 'שגיאה בהעלאה';
            if (code === 'RATE_LIMIT_POSTS' || res.status === 429) {
              item.uploadStatus = 'error';
              item.uploadMessage = 'הגעת למכסת הפרסום היומית — נסה שוב מאוחר יותר';
              summary.failed++;
              summary.stoppedEarly = true;
              summary.stopReason = item.uploadMessage;
              if (cb.onItemUpdate) cb.onItemUpdate(item);
              break;
            }
            if (code === 'ACCOUNT_BANNED' || res.status === 403) {
              item.uploadStatus = 'error';
              item.uploadMessage = msg;
              summary.failed++;
              summary.stoppedEarly = true;
              summary.stopReason = msg;
              if (cb.onItemUpdate) cb.onItemUpdate(item);
              break;
            }
            item.uploadStatus = 'error';
            item.uploadMessage = msg;
            summary.failed++;
          } else {
            var noteOut = (res.data && res.data.note) || {};
            if (noteOut.status === 'rejected') {
              item.uploadStatus = 'rejected';
              item.uploadMessage = noteOut.moderationCategory || 'נדחתה בסינון השרת';
              item.selected = false;
              summary.rejected++;
            } else {
              item.alreadyUploaded = true;
              item.selected = false;
              item.uploadStatus = noteOut.status === 'pending' ? 'pending' : 'published';
              item.uploadMessage = item.uploadStatus === 'pending' ? 'נשלחה לאישור' : 'פורסמה';
              uploadedLog[item.key] = {
                noteId: noteOut.id || '',
                bookUid: payload.bookUid,
                status: item.uploadStatus,
                uploadedAt: Date.now(),
              };
              await CN.storage.set(UPLOADED_LOG_KEY, uploadedLog);
              await CN.storage.recordWorkedBook(payload.bookUid, payload.titleHint, payload.ref, payload.sectionHint);
              summary.uploaded++;
              if (item.uploadStatus === 'pending') summary.pending++;
              else summary.published++;
            }
          }
        } catch (err) {
          item.uploadStatus = 'error';
          item.uploadMessage = (err && err.message) || 'שגיאת תקשורת';
          summary.failed++;
        }

        importerState.progressDone = i + 1;
        if (cb.onItemUpdate) cb.onItemUpdate(item);
        if (cb.onProgress) cb.onProgress(importerState.progressDone, importerState.progressTotal);
      }
    } finally {
      importerState.uploading = false;
      var parts = ['הועלו ' + summary.uploaded + ' הערות'];
      if (summary.published) parts.push(summary.published + ' פורסמו');
      if (summary.pending) parts.push(summary.pending + ' ממתינות לאישור');
      if (summary.rejected) parts.push(summary.rejected + ' נדחו');
      if (summary.failed) parts.push(summary.failed + ' נכשלו');
      if (summary.stopReason) parts.push(summary.stopReason);
      importerState.lastSummary = parts.join(' · ');
    }

    return summary;
  }

  function renderImportScreen(container) {
    var el = CN.ui.el;
    var t = CN.ui.t;
    container.textContent = '';

    var wrap = el('div', { className: 'container-narrow' });

    // Top bar
    var backBtn = el('button', {
      type: 'button',
      className: 'btn-secondary',
      text: '← ' + t('חזרה'),
      onClick: function () {
        if (importerState.uploading) importerState.stopRequested = true;
        CN.app.navigate('mine');
      },
    });
    var refreshBtn = el('button', {
      type: 'button',
      className: 'btn-secondary',
      text: t('רענן רשימה'),
      disabled: importerState.loading || importerState.uploading,
      onClick: function () {
        importerState.loaded = false;
        renderImportScreen(container);
      },
    });

    wrap.appendChild(el('div', { className: 'section-header' }, [
      el('div', { className: 'section-title-group' }, [
        el('h2', { className: 'section-heading', text: t('ייבוא מהערות אישיות') }),
        el('div', {
          className: 'section-counts',
          text: importerState.loaded
            ? ('נמצאו ' + importerState.items.length + ' הערות אישיות ב־' + importerState.books.length + ' ספרים')
            : 'סורק את ההערות האישיות שלך באוצריא...',
        }),
      ]),
      el('div', { className: 'card-actions-group' }, [refreshBtn, backBtn]),
    ]));

    container.appendChild(wrap);

    if (!importerState.loaded && !importerState.loading) {
      loadPersonalNotesCatalog().then(function () {
        if (CN.state.screen === 'import') renderImportScreen(container);
      });
    }

    if (importerState.loading) {
      wrap.appendChild(el('div', { className: 'status-banner info', text: 'טוען הערות אישיות מכל הספרים...' }));
      wrap.appendChild(el('div', { className: 'skeleton-card' }));
      wrap.appendChild(el('div', { className: 'skeleton-card' }));
      return;
    }

    if (importerState.permissionMissing || (CN.state.permissions && CN.state.permissions.indexOf('notes.read') === -1)) {
      wrap.appendChild(el('div', {
        className: 'status-banner warning',
        text: 'אין הרשאת קריאת הערות אישיות (notes.read). להפעלה: הגדרות ← כלים ← תוספים מותקנים ← הערות הקהילה ← הרשאות.',
      }));
      return;
    }

    if (importerState.error) {
      wrap.appendChild(el('div', { className: 'status-banner error', text: importerState.error }));
      return;
    }

    if (importerState.items.length === 0) {
      wrap.appendChild(el('div', { className: 'empty-state' }, [
        el('p', { text: 'לא נמצאו הערות אישיות שמורות בספרי אוצריא שלך.' }),
        el('button', {
          type: 'button',
          className: 'btn-primary',
          text: t('חזרה לשלי'),
          onClick: function () { CN.app.navigate('mine'); },
        }),
      ]));
      return;
    }

    if (importerState.lastSummary) {
      wrap.appendChild(el('div', { className: 'status-banner info', text: importerState.lastSummary }));
    }

    if (CN.state.isOnline === false) {
      wrap.appendChild(el('div', {
        className: 'status-banner warning',
        text: 'אין חיבור לרשת — אפשר לעבור ולסמן הערות עכשיו, ולהעלות כשתתחבר.',
      }));
    }

    // Book & status filter controls
    var bookSelect = el('select', { className: 'select-compact', 'aria-label': 'סינון לפי ספר' });
    bookSelect.appendChild(el('option', { value: 'all', text: 'כל הספרים (' + importerState.items.length + ')' }));
    importerState.books.forEach(function (bk) {
      bookSelect.appendChild(el('option', {
        value: bk.bookId,
        text: bk.titleHint + ' (' + bk.count + ')',
      }));
    });
    bookSelect.value = importerState.bookFilter;
    bookSelect.addEventListener('change', function () {
      importerState.bookFilter = bookSelect.value;
      importerState.renderLimit = INITIAL_RENDER_LIMIT;
      renderImportScreen(container);
    });

    var statusChips = el('div', { className: 'chip-group', role: 'radiogroup', 'aria-label': 'סינון לפי מצב' });
    [
      ['all', 'הכול'],
      ['ready', 'מוכנות לפרסום'],
      ['invalid', 'דורשות תיקון'],
      ['uploaded', 'כבר בקהילה'],
    ].forEach(function (pair) {
      statusChips.appendChild(el('button', {
        type: 'button',
        className: 'chip-btn' + (importerState.statusFilter === pair[0] ? ' active' : ''),
        text: pair[1],
        onClick: function () {
          importerState.statusFilter = pair[0];
          importerState.renderLimit = INITIAL_RENDER_LIMIT;
          renderImportScreen(container);
        },
      }));
    });
    wrap.appendChild(el('div', { className: 'filter-row' }, [statusChips, bookSelect]));

    var visible = getFilteredItems();
    var selectedCount = importerState.items.filter(function (it) { return it.selected && !it.alreadyUploaded && it.validation.valid; }).length;
    var visibleReadyCount = visible.filter(function (it) { return !it.alreadyUploaded && it.validation.valid; }).length;

    // Batch toolbar
    var uploadBtn = el('button', {
      type: 'button',
      className: 'btn-primary',
      text: t('פרסם נבחרות') + ' (' + selectedCount + ')',
      disabled: importerState.uploading || selectedCount === 0 || CN.state.isOnline === false,
    });

    var selectValidBtn = el('button', {
      type: 'button',
      className: 'btn-secondary',
      text: 'בחר תקינות כאן (' + visibleReadyCount + ')',
      disabled: importerState.uploading || visibleReadyCount === 0,
      onClick: function () {
        visible.forEach(function (it) {
          if (!it.alreadyUploaded && revalidateItem(it).valid) it.selected = true;
        });
        renderImportScreen(container);
      },
    });
    var clearSelBtn = el('button', {
      type: 'button',
      className: 'btn-secondary',
      text: 'בטל בחירה',
      disabled: importerState.uploading || selectedCount === 0,
      onClick: function () {
        importerState.items.forEach(function (it) { it.selected = false; });
        renderImportScreen(container);
      },
    });
    var attachAllCheckbox = el('input', {
      type: 'checkbox',
      checked: importerState.attachQuoteAll ? true : false,
      disabled: importerState.uploading,
    });
    attachAllCheckbox.checked = importerState.attachQuoteAll;
    attachAllCheckbox.addEventListener('change', function () {
      importerState.attachQuoteAll = Boolean(attachAllCheckbox.checked);
      importerState.items.forEach(function (it) {
        if (!it.alreadyUploaded) {
          it.attachQuote = importerState.attachQuoteAll;
          revalidateItem(it);
        }
      });
      renderImportScreen(container);
    });

    wrap.appendChild(el('div', { className: 'importer-toolbar' }, [
      el('div', { className: 'card-actions-group' }, [selectValidBtn, clearSelBtn]),
      el('label', { className: 'importer-check-label' }, [
        attachAllCheckbox,
        el('span', { text: 'צרף פתיחת הקטע כציטוט (להדגשה)' }),
      ]),
      uploadBtn,
    ]));

    // Live upload progress bar
    var progressWrap = el('div', { className: 'importer-progress-wrap' + (importerState.uploading ? '' : ' hidden') });
    var progressText = el('div', { className: 'settings-row-title', text: '' });
    var progressFill = el('div', { className: 'importer-progress-fill' });
    progressFill.style.width = importerState.progressTotal > 0
      ? Math.round((importerState.progressDone / importerState.progressTotal) * 100) + '%'
      : '0%';
    progressText.textContent = 'מעלה ' + importerState.progressDone + ' מתוך ' + importerState.progressTotal + '...';
    var stopBtn = el('button', {
      type: 'button',
      className: 'btn-secondary',
      text: 'עצור',
      onClick: function () {
        importerState.stopRequested = true;
        stopBtn.disabled = true;
      },
    });
    progressWrap.appendChild(el('div', { className: 'importer-item-head' }, [progressText, stopBtn]));
    progressWrap.appendChild(el('div', { className: 'importer-progress-track' }, [progressFill]));
    wrap.appendChild(progressWrap);

    function refreshSelectedCounter() {
      var c = importerState.items.filter(function (it) { return it.selected && !it.alreadyUploaded && it.validation.valid; }).length;
      uploadBtn.textContent = t('פרסם נבחרות') + ' (' + c + ')';
      uploadBtn.disabled = importerState.uploading || c === 0 || CN.state.isOnline === false;
    }

    var itemRefsByKey = {};

    uploadBtn.addEventListener('click', async function () {
      progressWrap.classList.remove('hidden');
      await uploadSelectedNotes(importerState.items, {
        onProgress: function (done, total) {
          progressText.textContent = 'מעלה ' + done + ' מתוך ' + total + '...';
          progressFill.style.width = (total > 0 ? Math.round((done / total) * 100) : 0) + '%';
        },
        onItemUpdate: function (it) {
          var dom = itemRefsByKey[it.key];
          if (dom) dom.syncStatus();
        },
      });
      renderImportScreen(container);
    });

    if (visible.length === 0) {
      wrap.appendChild(el('div', { className: 'empty-state', text: 'אין הערות התואמות לסינון הנוכחי' }));
      return;
    }

    var slice = visible.slice(0, importerState.renderLimit);
    var epoch = ++enrichEpoch;
    var toEnrich = [];

    slice.forEach(function (item) {
      var isDone = item.alreadyUploaded || item.uploadStatus === 'published' || item.uploadStatus === 'pending';
      var card = el('article', {
        className: 'importer-item' + (isDone ? ' uploaded' : (item.selected ? ' selected' : '')),
      });

      var chk = el('input', {
        type: 'checkbox',
        disabled: isDone || !item.validation.valid || importerState.uploading,
      });
      chk.checked = Boolean(item.selected && !isDone && item.validation.valid);

      var locLabel = el('span', {
        text: item.titleHint + ' · ' + (item.ref || ('שורה ' + (item.lineNumber + 1))),
      });
      var statusBadge = el('span', { className: 'tag' });
      var sourceBox = el('div', { className: 'importer-source-preview' + (item.sourceText ? '' : ' hidden') });
      if (item.sourceText) {
        sourceBox.textContent = '״' + CN.ui.formatQuoteText(item.sourceText.slice(0, 140)) + (item.sourceText.length > 140 ? '...' : '') + '״';
      }

      var ta = el('textarea', {
        className: 'textarea importer-textarea',
        disabled: isDone || importerState.uploading,
        'aria-label': 'תוכן ההערה',
      });
      ta.value = item.body;

      var valHint = el('div', { className: 'validation-hint' });

      var kindGroup = el('div', { className: 'chip-group' });
      var noteBtn = el('button', { type: 'button', className: 'chip-btn', text: t('הערה') });
      var qBtn = el('button', { type: 'button', className: 'chip-btn', text: t('שאלה') });

      var quoteChk = el('input', {
        type: 'checkbox',
        disabled: isDone || importerState.uploading,
      });
      quoteChk.checked = Boolean(item.attachQuote);

      function syncKindButtons() {
        noteBtn.classList.toggle('active', item.kind === 'note');
        qBtn.classList.toggle('active', item.kind === 'question');
        noteBtn.disabled = isDone || importerState.uploading;
        qBtn.disabled = isDone || importerState.uploading;
      }

      function syncStatus() {
        var res = revalidateItem(item);
        var doneNow = item.alreadyUploaded || item.uploadStatus === 'published' || item.uploadStatus === 'pending';
        chk.disabled = doneNow || !res.valid || importerState.uploading;
        if (!res.valid && item.selected) item.selected = false;
        chk.checked = Boolean(item.selected && !doneNow && res.valid);
        card.className = 'importer-item' + (doneNow ? ' uploaded' : (chk.checked ? ' selected' : ''));

        if (item.uploadStatus === 'uploading') {
          statusBadge.className = 'tag primary';
          statusBadge.textContent = 'מעלה...';
        } else if (item.uploadStatus === 'published') {
          statusBadge.className = 'tag primary';
          statusBadge.textContent = 'פורסמה ✓';
        } else if (item.uploadStatus === 'pending') {
          statusBadge.className = 'tag warning';
          statusBadge.textContent = 'נשלחה לאישור';
        } else if (item.alreadyUploaded) {
          statusBadge.className = 'tag';
          statusBadge.textContent = 'כבר בקהילה';
        } else if (item.uploadStatus === 'rejected' || item.uploadStatus === 'error') {
          statusBadge.className = 'tag error';
          statusBadge.textContent = item.uploadMessage || 'שגיאה';
        } else if (!res.valid) {
          statusBadge.className = 'tag error';
          statusBadge.textContent = 'דורשת תיקון';
        } else if (res.level === 'warning') {
          statusBadge.className = 'tag warning';
          statusBadge.textContent = 'מוכנה (תועבר לבדיקה)';
        } else {
          statusBadge.className = 'tag primary';
          statusBadge.textContent = 'מוכנה לפרסום';
        }

        valHint.textContent = item.uploadMessage || res.message || '';
        valHint.className = 'validation-hint ' + ((item.uploadStatus === 'rejected' || item.uploadStatus === 'error') ? 'error' : res.level);
        syncKindButtons();
      }

      itemRefsByKey[item.key] = { syncStatus: syncStatus };

      chk.addEventListener('change', function () {
        item.selected = Boolean(chk.checked);
        syncStatus();
        refreshSelectedCounter();
      });

      ta.addEventListener('input', function () {
        var wasInvalid = !item.validation.valid;
        item.body = ta.value;
        item.uploadStatus = 'idle';
        item.uploadMessage = '';
        revalidateItem(item);
        if (wasInvalid && item.validation.valid && !item.alreadyUploaded) {
          item.selected = true;
        }
        syncStatus();
        refreshSelectedCounter();
      });

      noteBtn.addEventListener('click', function () { item.kind = 'note'; syncKindButtons(); });
      qBtn.addEventListener('click', function () { item.kind = 'question'; syncKindButtons(); });
      kindGroup.appendChild(noteBtn);
      kindGroup.appendChild(qBtn);

      quoteChk.addEventListener('change', function () {
        item.attachQuote = Boolean(quoteChk.checked);
        syncStatus();
      });

      var openBookBtn = el('button', {
        type: 'button',
        className: 'link-btn',
        text: 'פתח בספר',
        onClick: async function () {
          try {
            await global.Otzaria.call('reader.openBookAtRef', {
              bookId: item.bookId,
              bookUid: (item.bookUid && item.bookUid !== item.bookId) ? item.bookUid : undefined,
              ref: item.ref || undefined,
              index: Math.max(0, Number(item.lineNumber) || 0),
              highlight: true,
            });
          } catch (_) { /* ignore */ }
        },
      });

      card.appendChild(el('div', { className: 'importer-item-head' }, [
        el('label', { className: 'importer-check-label' }, [chk, locLabel]),
        el('div', { className: 'card-actions-group' }, [openBookBtn, statusBadge]),
      ]));
      card.appendChild(sourceBox);
      card.appendChild(ta);
      card.appendChild(el('div', { className: 'filter-row' }, [
        kindGroup,
        el('label', { className: 'importer-check-label' }, [
          quoteChk,
          el('span', { className: 'meta-time', text: 'עגן לתחילת השורה כציטוט' }),
        ]),
        valHint,
      ]));

      syncStatus();
      wrap.appendChild(card);

      if (!item._enriched) {
        toEnrich.push({
          item: item,
          onResolved: function (it) {
            if (enrichEpoch !== epoch) return;
            locLabel.textContent = it.titleHint + ' · ' + (it.ref || ('שורה ' + (it.lineNumber + 1)));
            if (it.sourceText) {
              sourceBox.textContent = '״' + CN.ui.formatQuoteText(it.sourceText.slice(0, 140)) + (it.sourceText.length > 140 ? '...' : '') + '״';
              sourceBox.classList.remove('hidden');
            }
          },
        });
      }
    });

    if (visible.length > slice.length) {
      wrap.appendChild(el('div', { className: 'floating-cta' }, [
        el('button', {
          type: 'button',
          className: 'btn-secondary',
          text: t('הצג עוד') + ' (' + (visible.length - slice.length) + ')',
          onClick: function () {
            importerState.renderLimit += INITIAL_RENDER_LIMIT;
            renderImportScreen(container);
          },
        }),
      ]));
    }

    // Lazily enrich ref + section excerpt with concurrency 3
    if (toEnrich.length > 0) {
      var cursor = 0;
      var runWorker = async function () {
        while (cursor < toEnrich.length && enrichEpoch === epoch) {
          var task = toEnrich[cursor++];
          await enrichItemContext(task.item);
          task.onResolved(task.item);
        }
      };
      for (var w = 0; w < 3; w++) runWorker();
    }
  }

  function resetStateForTests() {
    importerState.loading = false;
    importerState.loaded = false;
    importerState.permissionMissing = false;
    importerState.error = '';
    importerState.books = [];
    importerState.items = [];
    importerState.bookFilter = 'all';
    importerState.statusFilter = 'all';
    importerState.renderLimit = INITIAL_RENDER_LIMIT;
    importerState.attachQuoteAll = false;
    importerState.uploading = false;
    importerState.stopRequested = false;
    importerState.progressDone = 0;
    importerState.progressTotal = 0;
    importerState.lastSummary = '';
    bookInfoCache = {};
  }

  CN.importer = {
    state: importerState,
    loadPersonalNotesCatalog: loadPersonalNotesCatalog,
    uploadSelectedNotes: uploadSelectedNotes,
    enrichItemContext: enrichItemContext,
    renderImportScreen: renderImportScreen,
    resetStateForTests: resetStateForTests,
  };
})(typeof window !== 'undefined' ? window : globalThis);
