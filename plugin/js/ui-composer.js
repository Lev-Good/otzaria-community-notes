(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  var autosaveTimer = null;

  function renderComposer(container) {
    var el = CN.ui.el;
    var t = CN.ui.t;
    var comp = CN.state.compose;
    var isEdit = comp.mode === 'edit' && comp.editingNote;
    var anchor = isEdit
      ? {
          bookUid: comp.editingNote.bookUid,
          titleHint: comp.editingNote.titleHint,
          ref: comp.editingNote.ref,
          sectionHint: comp.editingNote.sectionHint,
          quote: comp.editingNote.quote,
          prefix: comp.editingNote.prefix,
          suffix: comp.editingNote.suffix,
          occurrence: comp.editingNote.occurrence,
        }
      : (comp.anchor || {});

    container.textContent = '';

    var wrap = el('div', { className: 'container-narrow' });

    wrap.appendChild(el('div', { className: 'section-header' }, [
      el('div', { className: 'section-title-group' }, [
        el('h2', { className: 'section-heading', text: isEdit ? 'עריכת רשומה' : t('הוסף הערה או שאלה') }),
        el('div', {
          className: 'section-counts',
          text: (anchor.titleHint || anchor.bookUid || '') + (anchor.ref ? (' · ' + anchor.ref) : ''),
        }),
      ]),
    ]));

    // Quote display (read-only, reading font, clamped 2 lines)
    var quoteBox = el('div', { className: 'quote-box' });
    if (anchor.quote) {
      var qText = el('div', {
        className: 'quote-text clamped-2',
        text: CN.ui.formatQuoteText(anchor.quote),
      });
      quoteBox.appendChild(qText);
      if (anchor.multiParagraph) {
        quoteBox.appendChild(el('div', {
          className: 'meta-time',
          text: 'ההערה תוצמד לפסקה הראשונה שבחרת',
        }));
      }
      if (anchor.tooLongTruncated) {
        quoteBox.appendChild(el('div', {
          className: 'meta-time',
          text: 'הבחירה קוצרה ל־200 תווי עוגן (המגבלה לבחירה היא 500 תווים)',
        }));
      }
    } else {
      quoteBox.appendChild(el('div', {
        className: 'meta-time',
        text: 'הערה על הקטע כולו',
      }));
    }
    wrap.appendChild(quoteBox);

    // Kind selector (disabled on edit)
    if (!isEdit) {
      var kindBar = el('div', { className: 'chip-group', role: 'radiogroup', 'aria-label': 'סוג רשומה' });
      ['note', 'question'].forEach(function (k) {
        var btn = el('button', {
          type: 'button',
          className: 'chip-btn' + (comp.kind === k ? ' active' : ''),
          role: 'radio',
          'aria-checked': comp.kind === k ? 'true' : 'false',
          text: k === 'note' ? t('הערה') : t('שאלה'),
          onClick: function () {
            comp.kind = k;
            CN.state.settings.lastUsedComposerKind = k;
            CN.storage.saveSettings(CN.state.settings);
            renderComposer(container);
          },
        });
        kindBar.appendChild(btn);
      });
      wrap.appendChild(kindBar);
    }

    // Textarea
    var textarea = el('textarea', {
      className: 'textarea',
      id: 'compose-body',
      placeholder: comp.kind === 'question' ? 'מה לא מובן לך כאן?' : 'מה תרצה להוסיף לקטע?',
      'aria-label': 'תוכן ההערה',
    });
    textarea.value = comp.body || '';
    wrap.appendChild(textarea);

    var liveHint = el('div', { className: 'validation-hint' });
    var charCounter = el('div', { className: 'meta-time' });
    var statusBar = el('div', { className: 'filter-row' }, [liveHint, charCounter]);
    wrap.appendChild(statusBar);

    // Optional helpers: Add link to book + import from personal notes
    var helpersRow = el('div', { className: 'card-actions-group' });
    helpersRow.appendChild(el('button', {
      type: 'button',
      className: 'btn-secondary',
      text: 'הוסף קישור לספר',
      onClick: function () {
        openInsertBookLinkModal(textarea, onInputChanged);
      },
    }));

    if (CN.state.permissions.indexOf('notes.read') !== -1 && (anchor.titleHint || anchor.bookUid)) {
      helpersRow.appendChild(el('button', {
        type: 'button',
        className: 'btn-secondary',
        text: 'ייבא מהערה אישית',
        onClick: function () {
          openImportPersonalNoteModal(anchor.titleHint || anchor.bookUid, textarea, onInputChanged);
        },
      }));
    }
    wrap.appendChild(helpersRow);

    if (CN.state.identity && CN.state.identity.isNewUserHint) {
      wrap.appendChild(el('div', {
        className: 'status-banner info',
        text: 'ההערה תישלח לאישור לפני שתפורסם',
      }));
    }

    var offline = CN.state.isOnline === false;
    var writesDisabled = CN.state.config && CN.state.config.writesEnabled === false;

    var publishBtn = el('button', {
      type: 'button',
      className: 'btn-primary',
      text: isEdit ? 'שמור שינויים' : t('פרסם'),
    });
    var draftBtn = el('button', {
      type: 'button',
      className: 'btn-secondary',
      text: t('שמור טיוטה'),
    });
    var cancelBtn = el('button', {
      type: 'button',
      className: 'btn-secondary',
      text: t('בטל'),
    });

    if (offline || writesDisabled) {
      publishBtn.classList.add('hidden');
      if (writesDisabled) {
        wrap.appendChild(el('div', { className: 'status-banner warning', text: 'הכתיבה מושבתת זמנית. הקריאה פעילה' }));
      } else {
        wrap.appendChild(el('div', { className: 'status-banner warning', text: t('אין חיבור. הטיוטה נשמרה') }));
      }
    }

    var actionsRow = el('div', { className: 'card-actions-group' }, [publishBtn, draftBtn, cancelBtn]);
    wrap.appendChild(actionsRow);

    var retryBanner = el('div', { className: 'status-banner error hidden' });
    wrap.appendChild(retryBanner);

    container.appendChild(wrap);

    function updateValidation() {
      var val = textarea.value;
      comp.body = val;
      var len = val.trim().length;
      charCounter.textContent = len >= 1500 ? (len + ' / 2,000') : '';

      var res = CN.filter.validateLiveBody(val, anchor.quote || '');
      liveHint.textContent = res.message || '';
      liveHint.className = 'validation-hint ' + res.level;
      publishBtn.disabled = !res.valid || offline || writesDisabled;
    }

    function scheduleAutosave() {
      if (CN.state.settings.autosaveDrafts === false) return;
      if (autosaveTimer) clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(function () {
        saveDraftNow(false);
      }, CN.config.DRAFT_AUTOSAVE_MS);
    }

    function onInputChanged() {
      comp.dirty = textarea.value.trim().length > 0;
      updateUnsavedFlag(comp.dirty);
      updateValidation();
      scheduleAutosave();
    }

    textarea.addEventListener('input', onInputChanged);
    textarea.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter' && !publishBtn.disabled) {
        ev.preventDefault();
        submitComposer();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        handleCancel();
      }
    });

    async function saveDraftNow(showFeedback) {
      var bodyVal = textarea.value;
      if (!bodyVal || !bodyVal.trim()) return;
      var key = CN.storage.makeDraftKey(anchor.bookUid || anchor.titleHint, anchor.ref, anchor.quote);
      await CN.storage.set(key, {
        bookUid: anchor.bookUid || '',
        titleHint: anchor.titleHint || '',
        ref: anchor.ref || '',
        sectionHint: anchor.sectionHint || 0,
        quote: anchor.quote || '',
        prefix: anchor.prefix || '',
        suffix: anchor.suffix || '',
        occurrence: anchor.occurrence || 0,
        kind: comp.kind,
        body: bodyVal,
        updatedAt: Date.now(),
      });
      if (showFeedback) CN.ui.showToast('הטיוטה נשמרה');
    }

    async function submitComposer() {
      var liveRes = CN.filter.validateLiveBody(textarea.value, anchor.quote || '');
      if (!liveRes.valid) return;

      // Save draft before potential registration wizard so draft is never lost
      await saveDraftNow(false);
      var registered = await CN.onboarding.ensureRegistered();
      if (!registered) return;

      publishBtn.disabled = true;
      draftBtn.disabled = true;
      cancelBtn.disabled = true;
      textarea.disabled = true;
      publishBtn.textContent = 'שולח...';
      retryBanner.classList.add('hidden');

      try {
        var res;
        if (isEdit) {
          res = await CN.api.request('PATCH', '/v1/notes/' + encodeURIComponent(comp.editingNote.id), {
            auth: true,
            identity: CN.state.identity,
            settings: CN.state.settings,
            bodyObj: { body: textarea.value.trim() },
          });
        } else {
          var payload = {
            kind: comp.kind,
            bookUid: anchor.bookUid || anchor.titleHint,
            titleHint: anchor.titleHint || '',
            ref: anchor.ref || '',
            sectionHint: anchor.sectionHint || 0,
            quote: anchor.quote || '',
            prefix: anchor.prefix || '',
            suffix: anchor.suffix || '',
            occurrence: anchor.occurrence || 0,
            libVersion: anchor.libVersion || '',
            body: textarea.value.trim(),
          };

          // Solve PoW challenge if server might require it (new user)
          try {
            var pow = await CN.api.fetchSolvedChallenge(CN.state.settings);
            payload.challengeToken = pow.challengeToken;
            payload.challengeNonce = pow.challengeNonce;
          } catch (_) {
            // If server doesn't require PoW for active users, continue cleanly
          }

          res = await CN.api.request('POST', '/v1/notes', {
            auth: true,
            identity: CN.state.identity,
            settings: CN.state.settings,
            bodyObj: payload,
          });
        }

        if (!res.ok) {
          var errCode = res.data && res.data.error && res.data.error.code;
          var errMsg = (res.data && res.data.error && res.data.error.message) || 'שגיאה בשליחת ההערה';
          if (errCode === 'ACCOUNT_BANNED') {
            var until = res.data.error.bannedUntil ? new Date(res.data.error.bannedUntil).toLocaleDateString('he-IL') : '';
            errMsg = 'הכתיבה חסומה עד ' + until + '. הקריאה פעילה';
          } else if (errCode === 'RATE_LIMIT_POSTS') {
            errMsg = 'שלחת הרבה הערות בזמן קצר. נסה שוב בעוד כמה דקות';
          }
          throw new Error(errMsg);
        }

        // Clear draft & unsaved flag
        var key = CN.storage.makeDraftKey(anchor.bookUid || anchor.titleHint, anchor.ref, anchor.quote);
        await CN.storage.remove(key);
        comp.body = '';
        comp.dirty = false;
        comp.editingNote = null;
        updateUnsavedFlag(false);

        var noteOut = (res.data && res.data.note) || {};
        if (noteOut.status === 'rejected') {
          CN.ui.showToast('לא ניתן לפרסם: ' + (noteOut.moderationCategory || 'ביטוי שאינו מתאים') + '. אפשר לערער ממסך "שלי"');
          CN.app.navigate('mine');
          return;
        }
        if (noteOut.status === 'pending') {
          CN.ui.showToast(t('נשלחה לאישור. תקבל הודעה כשתפורסם'));
        } else {
          CN.ui.showToast(t('ההערה פורסמה'));
          await CN.storage.recordWorkedBook(anchor.bookUid, anchor.titleHint, anchor.ref, anchor.sectionHint);
          await CN.onboarding.maybeTriggerBackgroundPrompt(true);
        }

        if (!isEdit && CN.state.settings.returnAfterSubmit !== false && CN.state.cameFromReader) {
          await CN.highlights.returnToBookTab(anchor.bookUid, CN.state.context.bookId);
        }
        CN.app.navigate(isEdit ? 'mine' : 'section');
      } catch (err) {
        publishBtn.disabled = false;
        draftBtn.disabled = false;
        cancelBtn.disabled = false;
        textarea.disabled = false;
        publishBtn.textContent = isEdit ? 'שמור שינויים' : t('פרסם');

        retryBanner.textContent = '';
        retryBanner.appendChild(el('span', { text: err.message || 'השליחה נכשלה' }));
        retryBanner.appendChild(el('button', {
          type: 'button',
          className: 'link-btn',
          text: t('נסה שוב'),
          onClick: submitComposer,
        }));
        retryBanner.classList.remove('hidden');
      }
    }

    async function handleCancel() {
      if (textarea.value.trim().length > 0 && comp.dirty) {
        var okDiscard = true;
        try {
          var res = await global.Otzaria.call('ui.showConfirm', {
            title: 'ביטול כתיבה',
            message: 'יש טקסט שלא נשלח. לשמור כטיוטה או לבטל?',
            confirmText: 'בטל וצא',
            cancelText: 'המשך לכתוב',
          });
          okDiscard = Boolean(res && res.success && res.data === true);
        } catch (_) {
          okDiscard = global.confirm ? global.confirm('יש טקסט שלא נשלח. לצאת?') : true;
        }
        if (!okDiscard) return;
      }
      comp.dirty = false;
      comp.editingNote = null;
      updateUnsavedFlag(false);
      CN.app.navigate(CN.state.previousScreen || 'section');
    }

    publishBtn.addEventListener('click', submitComposer);
    draftBtn.addEventListener('click', function () { saveDraftNow(true); });
    cancelBtn.addEventListener('click', handleCancel);

    updateValidation();
    setTimeout(function () { textarea.focus(); }, 0);
  }

  function updateUnsavedFlag(dirty) {
    try {
      global.Otzaria.call('ui.setUnsavedChanges', { hasUnsavedChanges: Boolean(dirty) });
    } catch (_) {
      // ignore if unsupported
    }
  }

  function openInsertBookLinkModal(textarea, onAfterInsert) {
    var el = CN.ui.el;
    var modal = document.getElementById('modal-backdrop');
    var box = document.getElementById('modal-dialog');
    box.textContent = '';

    var searchInput = el('input', {
      className: 'input',
      type: 'text',
      placeholder: 'הקלד שם ספר לחיפוש...',
      autofocus: true,
    });
    var refInput = el('input', {
      className: 'input',
      type: 'text',
      placeholder: 'מראה מקום אופציונלי (למשל פרק א / דף ב ע״א)',
    });
    var resultsList = el('div', { className: 'container-narrow' });

    box.appendChild(el('h3', { text: 'הוסף קישור לספר באוצריא' }));
    box.appendChild(searchInput);
    box.appendChild(refInput);
    box.appendChild(resultsList);
    box.appendChild(el('button', {
      type: 'button',
      className: 'btn-secondary',
      text: CN.ui.t('סגור'),
      onClick: function () { modal.classList.remove('open'); },
    }));
    modal.classList.add('open');

    var debounce = null;
    searchInput.addEventListener('input', function () {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async function () {
        var q = searchInput.value.trim();
        resultsList.textContent = '';
        if (q.length < 2) return;
        try {
          var res = await global.Otzaria.call('library.findBooks', { query: q, limit: 8 });
          var books = (res && res.success && Array.isArray(res.data)) ? res.data : [];
          for (var i = 0; i < books.length; i++) {
            (function (b) {
              var target = b.id != null ? String(b.id) : encodeURIComponent(b.bookId || b.title);
              resultsList.appendChild(el('button', {
                type: 'button',
                className: 'btn-secondary',
                text: b.title + (b.categoryPath ? ' · ' + b.categoryPath : ''),
                onClick: function () {
                  var params = [];
                  params.push('title=' + encodeURIComponent(b.title));
                  if (refInput.value.trim()) params.push('ref=' + encodeURIComponent(refInput.value.trim()));
                  var link = 'otzaria://open/book/' + target + '?' + params.join('&');
                  var pos = textarea.selectionStart || textarea.value.length;
                  textarea.value = textarea.value.slice(0, pos) + ' ' + link + ' ' + textarea.value.slice(pos);
                  modal.classList.remove('open');
                  onAfterInsert();
                },
              }));
            })(books[i]);
          }
        } catch (_) {
          resultsList.appendChild(el('div', { className: 'meta-time', text: 'לא ניתן היה לחפש בספרייה' }));
        }
      }, 250);
    });
    setTimeout(function () { searchInput.focus(); }, 0);
  }

  async function openImportPersonalNoteModal(bookId, textarea, onAfterInsert) {
    var el = CN.ui.el;
    var modal = document.getElementById('modal-backdrop');
    var box = document.getElementById('modal-dialog');
    box.textContent = '';
    box.appendChild(el('h3', { text: 'שיתוף מהערות אישיות ב' + bookId }));
    var list = el('div', { className: 'container-narrow' });
    box.appendChild(list);

    try {
      var res = await global.Otzaria.call('notes.list', { bookId: bookId });
      var notes = (res && res.success && Array.isArray(res.data)) ? res.data : [];
      if (notes.length === 0) {
        list.appendChild(el('div', { className: 'meta-time', text: 'לא נמצאו הערות אישיות בספר זה' }));
      }
      for (var i = 0; i < Math.min(20, notes.length); i++) {
        (function (n) {
          var plain = n.contentPlain || n.content || '';
          list.appendChild(el('button', {
            type: 'button',
            className: 'btn-secondary',
            text: plain.slice(0, 90),
            onClick: function () {
              textarea.value = plain;
              modal.classList.remove('open');
              onAfterInsert();
            },
          }));
        })(notes[i]);
      }
    } catch (_) {
      list.appendChild(el('div', { className: 'meta-time', text: 'אין הרשאת קריאת הערות אישיות (notes.read)' }));
    }

    box.appendChild(el('button', {
      type: 'button',
      className: 'btn-secondary',
      text: CN.ui.t('סגור'),
      onClick: function () { modal.classList.remove('open'); },
    }));
    modal.classList.add('open');
  }

  CN.composer = {
    renderComposer: renderComposer,
    updateUnsavedFlag: updateUnsavedFlag,
  };
})(typeof window !== 'undefined' ? window : globalThis);
