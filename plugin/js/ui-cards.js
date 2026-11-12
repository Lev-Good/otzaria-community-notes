(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  function isAuthorBlocked(authorId) {
    if (!authorId) return false;
    var blocked = (CN.state.settings && CN.state.settings.blockedAuthors) || [];
    for (var i = 0; i < blocked.length; i++) {
      if (blocked[i].id === authorId) return true;
    }
    return false;
  }

  function filterAndSortNotes(notes, { filterTier, sortOrder, contentTypes }) {
    var filtered = [];
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (isAuthorBlocked(n.authorId) && !n.isOwn) continue;
      if (contentTypes) {
        if (n.kind === 'note' && contentTypes.note === false) continue;
        if (n.kind === 'question' && contentTypes.question === false) continue;
      }
      if (filterTier === 'questions') {
        if (n.kind !== 'question') continue;
      } else if (filterTier === 'recommended_only') {
        if (n.tier !== 'recommended' && !n.isOwn) continue;
      } else if (filterTier === 'recommended_and_new') {
        if (n.tier === 'low' && !n.isOwn) continue;
      }
      filtered.push(n);
    }

    filtered.sort(function (a, b) {
      if (sortOrder === 'newest') return b.createdAt - a.createdAt;
      // Recommended first: tier priority -> upCount -> newest
      var rank = { recommended: 0, new: 1, normal: 2, low: 3 };
      var ra = rank[a.tier] !== undefined ? rank[a.tier] : 2;
      var rb = rank[b.tier] !== undefined ? rank[b.tier] : 2;
      if (ra !== rb) return ra - rb;
      if (b.upCount !== a.upCount) return b.upCount - a.upCount;
      return b.createdAt - a.createdAt;
    });
    return filtered;
  }

  function formatHelpfulLabel(upCount) {
    var mode = (CN.state.settings && CN.state.settings.helpfulCountMode) || 'from_3';
    if (mode === 'never') return CN.ui.t('מועיל');
    if (mode === 'always' && upCount > 0) return CN.ui.t('מועיל ל־{n}', { n: upCount });
    if (mode === 'from_3' && upCount >= 3) return CN.ui.t('מועיל ל־{n}', { n: upCount });
    return CN.ui.t('מועיל');
  }

  function buildNoteCard(note, opts) {
    var el = CN.ui.el;
    var t = CN.ui.t;
    var options = opts || {};

    var card = el('article', {
      className: 'card' + (options.isAccepted ? ' accepted-answer' : ''),
    });

    // Header: author, relative time, badges (no trust levels/stars; only staff badge for moderators)
    var authorRow = el('div', { className: 'card-author-row' }, [
      el('span', { className: 'author-name', text: note.authorName || 'לומד' }),
      note.isStaff ? el('span', { className: 'tag staff', text: t('צוות') }) : null,
      el('span', { className: 'meta-time', text: CN.ui.formatRelativeTime(note.createdAt) }),
      note.editedAt ? el('span', { className: 'tag', text: t('נערך') }) : null,
    ]);

    var tags = el('div', { className: 'card-author-row' });
    if (options.isAccepted) {
      tags.appendChild(el('span', { className: 'tag primary' }, [
        CN.ui.getSvgIcon('check'),
        el('span', { text: t('תשובה מקובלת') }),
      ]));
    }
    if (note.kind === 'question') {
      tags.appendChild(el('span', {
        className: 'tag ' + (note.questionStatus === 'answered' ? 'primary' : 'warning'),
        text: note.questionStatus === 'answered' ? t('נענתה') : t('שאלה פתוחה'),
      }));
    } else if (note.tier === 'new' && note.status === 'published') {
      tags.appendChild(el('span', { className: 'tag', text: t('חדש') }));
    }
    if (note.status === 'pending') {
      tags.appendChild(el('span', { className: 'tag warning', text: t('ממתינה לאישור') }));
    } else if (note.status === 'rejected') {
      tags.appendChild(el('span', { className: 'tag error', text: 'נדחתה' }));
    } else if (note.status === 'hidden') {
      tags.appendChild(el('span', { className: 'tag error', text: 'הוסתרה' }));
    }
    if (note.appealStatus === 'pending') {
      tags.appendChild(el('span', { className: 'tag primary', text: 'ערעור בבדיקה' }));
    }
    if (note.replyToAuthorName) {
      tags.appendChild(el('span', { className: 'tag', text: 'בתגובה ל־' + note.replyToAuthorName }));
    }

    card.appendChild(el('div', { className: 'card-header' }, [authorRow, tags]));

    // Personal hidden-words check
    var hiddenList = (CN.state.settings && CN.state.settings.hiddenWords) || [];
    var hasHiddenWord = !note.isOwn && CN.filter.containsHiddenWord(note.body, hiddenList);

    var bodyContainer = el('div', { className: 'selectable' });
    if (hasHiddenWord) {
      var hiddenNotice = el('div', { className: 'status-banner' }, [
        el('span', { text: 'הרשומה הוסתרה לפי רשימת המילים האישית שלך' }),
        el('button', {
          type: 'button',
          className: 'link-btn',
          text: 'הצג בכל זאת',
          onClick: function () {
            renderBodyContent(bodyContainer, note);
          },
        }),
      ]);
      bodyContainer.appendChild(hiddenNotice);
    } else {
      renderBodyContent(bodyContainer, note);
    }
    card.appendChild(bodyContainer);

    if (note.moderationReason && (note.status === 'rejected' || note.status === 'hidden') && note.isOwn) {
      card.appendChild(el('div', {
        className: 'status-banner error',
        text: note.moderationReason,
      }));
    }

    // Bottom action bar
    var leftActions = el('div', { className: 'card-actions-group' });
    var isHelpful = note.myVote && note.myVote.value === 1;

    if (note.status === 'published' && !note.isOwn) {
      var helpfulBtn = el('button', {
        type: 'button',
        className: 'action-btn' + (isHelpful ? ' active' : ''),
        'aria-pressed': isHelpful ? 'true' : 'false',
        text: formatHelpfulLabel(note.upCount),
        onClick: function () {
          handleOptimisticHelpful(note, helpfulBtn);
        },
      });
      leftActions.appendChild(helpfulBtn);
    } else if (note.upCount >= 3 || (CN.state.settings.helpfulCountMode === 'always' && note.upCount > 0)) {
      leftActions.appendChild(el('span', {
        className: 'meta-time',
        text: formatHelpfulLabel(note.upCount),
      }));
    }

    if (!options.inThread && note.status === 'published') {
      var replyCountTotal = Number(note.replyCount || 0) + Number(note.answerCount || 0);
      var replyLabel = replyCountTotal > 0 ? (t('השב') + ' (' + replyCountTotal + ')') : t('השב');
      leftActions.appendChild(el('button', {
        type: 'button',
        className: 'action-btn',
        text: replyLabel,
        onClick: function () {
          CN.app.openThread(note.rootId || note.id, note.rootId ? note.id : null);
        },
      }));
    }

    if (options.inThread && options.onReplyTo) {
      leftActions.appendChild(el('button', {
        type: 'button',
        className: 'action-btn',
        text: t('השב'),
        onClick: function () { options.onReplyTo(note); },
      }));
    }

    if (options.canAccept) {
      leftActions.appendChild(el('button', {
        type: 'button',
        className: 'action-btn' + (options.isAccepted ? ' active' : ''),
        text: options.isAccepted ? t('בטל סימון תשובה מקובלת') : t('סמן כתשובה מקובלת'),
        onClick: function () { options.onToggleAccept(note); },
      }));
    }

    if (note.quote && options.showReveal !== false) {
      leftActions.appendChild(el('button', {
        type: 'button',
        className: 'action-btn',
        text: t('הצג בטקסט'),
        onClick: async function () {
          var targetBookId = (CN.state.context.bookUid === note.bookUid && CN.state.context.bookId)
            ? CN.state.context.bookId
            : (note.titleHint || note.bookUid);
          var splitVisible = CN.bookPane && CN.bookPane.shouldShowBookPane();
          if (splitVisible && CN.bookPane.focusLocation) {
            await CN.bookPane.focusLocation({
              bookId: targetBookId,
              bookUid: note.bookUid,
              titleHint: note.titleHint,
              sectionIndex: note.sectionHint,
              quote: note.quote,
              isQuestion: note.kind === 'question' && note.questionStatus === 'open',
            });
          }
          CN.highlights.revealNoteInBook({
            note: note,
            bookId: targetBookId,
            bookUid: note.bookUid,
            theme: CN.state.theme,
            returnToReader: !splitVisible && CN.state.settings.returnAfterReveal !== false,
          });
        },
      }));
    }

    // Overflow popover menu
    var rightActions = el('div', { className: 'popover-anchor' });
    var menu = el('div', { className: 'popover-menu', role: 'menu' });

    if (note.status === 'published' && !note.isOwn) {
      menu.appendChild(el('button', {
        type: 'button',
        text: t('לא מועיל'),
        onClick: function () {
          menu.classList.remove('open');
          openNotHelpfulDialog(note);
        },
      }));
      menu.appendChild(el('button', {
        type: 'button',
        text: t('דיווח'),
        onClick: function () {
          menu.classList.remove('open');
          openReportDialog(note);
        },
      }));
      menu.appendChild(el('button', {
        type: 'button',
        text: t('חסימת כותב'),
        onClick: function () {
          menu.classList.remove('open');
          blockAuthor(note);
        },
      }));
    }

    menu.appendChild(el('button', {
      type: 'button',
      text: t('העתקת קישור'),
      onClick: function () {
        menu.classList.remove('open');
        copyBookDeepLink(note);
      },
    }));

    if (note.isOwn && note.status !== 'deleted') {
      menu.appendChild(el('button', {
        type: 'button',
        text: t('ערוך'),
        onClick: function () {
          menu.classList.remove('open');
          CN.app.openEditComposer(note);
        },
      }));
      menu.appendChild(el('button', {
        type: 'button',
        text: t('מחק'),
        onClick: function () {
          menu.classList.remove('open');
          confirmDeleteNote(note);
        },
      }));
      if ((note.status === 'rejected' || note.status === 'hidden') && note.appealStatus !== 'pending' && note.appealStatus !== 'reviewed') {
        menu.appendChild(el('button', {
          type: 'button',
          text: t('ערער'),
          onClick: function () {
            menu.classList.remove('open');
            openAppealDialog(note);
          },
        }));
      }
    }

    var menuTrigger = el('button', {
      type: 'button',
      className: 'action-btn',
      'aria-label': 'פעולות נוספות',
      text: '⋯',
      onClick: function (ev) {
        ev.stopPropagation();
        var wasOpen = menu.classList.contains('open');
        document.querySelectorAll('.popover-menu.open').forEach(function (m) { m.classList.remove('open'); });
        if (!wasOpen) menu.classList.add('open');
      },
    });

    rightActions.appendChild(menuTrigger);
    rightActions.appendChild(menu);

    card.appendChild(el('div', { className: 'card-actions' }, [leftActions, rightActions]));
    return card;
  }

  function renderBodyContent(container, note) {
    container.textContent = '';
    var el = CN.ui.el;
    var expandDefault = CN.state.settings && CN.state.settings.longCards === 'expanded';
    var isLong = String(note.body || '').length > 220 || String(note.body || '').split('\n').length > 4;

    var bodyP = el('div', {
      className: 'note-body' + (!expandDefault && isLong ? ' clamped' : ''),
    });
    CN.ui.renderSafeNoteBody(bodyP, note.body);
    container.appendChild(bodyP);

    if (isLong && !expandDefault) {
      var expandBtn = el('button', {
        type: 'button',
        className: 'link-btn',
        text: CN.ui.t('עוד'),
        onClick: function () {
          var collapsed = bodyP.classList.toggle('clamped');
          expandBtn.textContent = collapsed ? CN.ui.t('עוד') : CN.ui.t('פחות');
        },
      });
      container.appendChild(expandBtn);
    }
  }

  async function handleOptimisticHelpful(note, btn) {
    var ok = await CN.onboarding.ensureRegistered();
    if (!ok) return;

    var prevVote = note.myVote ? Object.assign({}, note.myVote) : null;
    var prevUp = note.upCount;
    var nextVal = (prevVote && prevVote.value === 1) ? 0 : 1;

    // Optimistic UI update
    note.myVote = nextVal === 0 ? null : { value: 1, reason: null };
    note.upCount = Math.max(0, prevUp + (nextVal === 1 ? 1 : -1));
    btn.classList.toggle('active', nextVal === 1);
    btn.setAttribute('aria-pressed', nextVal === 1 ? 'true' : 'false');
    btn.textContent = formatHelpfulLabel(note.upCount);

    try {
      var res = await CN.api.request('PUT', '/v1/notes/' + encodeURIComponent(note.id) + '/vote', {
        auth: true,
        identity: CN.state.identity,
        settings: CN.state.settings,
        bodyObj: { value: nextVal },
      });
      if (!res.ok) throw new Error((res.data && res.data.error && res.data.error.message) || 'שגיאה');
      if (res.data) {
        note.upCount = res.data.upCount;
        note.downCount = res.data.downCount;
        note.tier = res.data.tier;
        note.myVote = res.data.myVote;
        btn.textContent = formatHelpfulLabel(note.upCount);
      }
    } catch (err) {
      // Revert on server rejection
      note.myVote = prevVote;
      note.upCount = prevUp;
      var wasActive = Boolean(prevVote && prevVote.value === 1);
      btn.classList.toggle('active', wasActive);
      btn.setAttribute('aria-pressed', wasActive ? 'true' : 'false');
      btn.textContent = formatHelpfulLabel(prevUp);
      CN.ui.showToast(err.message || 'לא ניתן היה לשמור את ההצבעה');
    }
  }

  function openNotHelpfulDialog(note) {
    var reasons = [
      ['wrong', 'שגוי מבחינה עובדתית או תורנית'],
      ['off_topic', 'לא קשור לקטע'],
      ['unclear', 'לא ברור או מנוסח חלקית'],
      ['inappropriate', 'לא ראוי (ייספר גם כדיווח)'],
    ];
    CN.ui.openReasonModal('סימון "לא מועיל" (גלוי רק לכותב ולמודרטורים)', reasons, async function (reason) {
      var ok = await CN.onboarding.ensureRegistered();
      if (!ok) return;
      var res = await CN.api.request('PUT', '/v1/notes/' + encodeURIComponent(note.id) + '/vote', {
        auth: true,
        identity: CN.state.identity,
        settings: CN.state.settings,
        bodyObj: { value: -1, reason: reason },
      });
      if (res.ok) {
        CN.ui.showToast('המשוב נשמר');
        CN.app.refreshCurrentScreen();
      } else {
        CN.ui.showToast((res.data && res.data.error && res.data.error.message) || 'שגיאה בשליחת המשוב');
      }
    });
  }

  function openReportDialog(note) {
    var reasons = [
      ['inappropriate', 'תוכן לא ראוי או פוגעני'],
      ['spam', 'פרסומת, ספאם או תוכן חוזר'],
      ['off_topic', 'פוליטיקה או נושא חוץ-תורני'],
      ['copyright', 'הדבקת קטע ארוך מספר מוגן'],
    ];
    CN.ui.openReasonModal('דיווח על הערה', reasons, async function (reason, details) {
      var ok = await CN.onboarding.ensureRegistered();
      if (!ok) return;
      var res = await CN.api.request('POST', '/v1/notes/' + encodeURIComponent(note.id) + '/report', {
        auth: true,
        identity: CN.state.identity,
        settings: CN.state.settings,
        bodyObj: { reason: reason, details: details || '' },
      });
      if (res.ok) {
        CN.ui.showToast('הדיווח נשלח לבדיקת מודרטורים');
      } else {
        CN.ui.showToast((res.data && res.data.error && res.data.error.message) || 'שגיאה בשליחת הדיווח');
      }
    }, { withDetails: true });
  }

  function openAppealDialog(note) {
    CN.ui.openReasonModal('ערעור על החלטת סינון', [], async function (_reason, details) {
      var res = await CN.api.request('POST', '/v1/notes/' + encodeURIComponent(note.id) + '/appeal', {
        auth: true,
        identity: CN.state.identity,
        settings: CN.state.settings,
        bodyObj: { reason: details || '' },
      });
      if (res.ok) {
        CN.ui.showToast('הערעור נשלח לתור המודרטורים');
        CN.app.refreshCurrentScreen();
      } else {
        CN.ui.showToast((res.data && res.data.error && res.data.error.message) || 'שגיאה בשליחת הערעור');
      }
    }, { withDetails: true, detailsPlaceholder: 'הסבר בקצרה מדוע לדעתך ההערה תקינה ורלוונטית לקטע' });
  }

  async function blockAuthor(note) {
    if (!note.authorId) return;
    var list = CN.state.settings.blockedAuthors || [];
    if (!list.some(function (x) { return x.id === note.authorId; })) {
      list.push({ id: note.authorId, name: note.authorName || 'כותב' });
      CN.state.settings.blockedAuthors = list;
      await CN.storage.saveSettings(CN.state.settings);
      CN.app.refreshCurrentScreen();
      CN.ui.showToast('הכותב הוסתר מהתצוגה שלך', {
        actionLabel: 'ביטול',
        onAction: async function () {
          CN.state.settings.blockedAuthors = CN.state.settings.blockedAuthors.filter(function (x) { return x.id !== note.authorId; });
          await CN.storage.saveSettings(CN.state.settings);
          CN.app.refreshCurrentScreen();
        },
      });
    }
  }

  async function copyBookDeepLink(note) {
    var bookPart = encodeURIComponent(note.titleHint || note.bookUid || '');
    var uri = 'otzaria://open/book/' + bookPart + (note.ref ? ('?ref=' + encodeURIComponent(note.ref)) : '');
    try {
      await navigator.clipboard.writeText(uri);
      CN.ui.showToast('הקישור הועתק');
    } catch (_) {
      CN.ui.showToast(uri);
    }
  }

  async function confirmDeleteNote(note) {
    var confirmed = false;
    try {
      var res = await global.Otzaria.call('ui.showConfirm', {
        title: 'מחיקת הערה',
        message: 'האם למחוק את ההערה? פעולה זו אינה הפיכה.',
        confirmText: 'מחק',
        cancelText: 'בטל',
      });
      confirmed = Boolean(res && res.success && res.data === true);
    } catch (_) {
      confirmed = global.confirm ? global.confirm('למחוק את ההערה?') : true;
    }
    if (!confirmed) return;

    var resDel = await CN.api.request('DELETE', '/v1/notes/' + encodeURIComponent(note.id), {
      auth: true,
      identity: CN.state.identity,
      settings: CN.state.settings,
    });
    if (resDel.ok) {
      CN.ui.showToast(CN.ui.t('ההערה נמחקה'));
      CN.app.refreshCurrentScreen();
    } else {
      CN.ui.showToast((resDel.data && resDel.data.error && resDel.data.error.message) || 'לא ניתן למחוק');
    }
  }

  CN.cards = {
    filterAndSortNotes: filterAndSortNotes,
    buildNoteCard: buildNoteCard,
    openAppealDialog: openAppealDialog,
    confirmDeleteNote: confirmDeleteNote,
  };
})(typeof window !== 'undefined' ? window : globalThis);
