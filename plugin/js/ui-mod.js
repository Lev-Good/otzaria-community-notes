(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  var REJECT_TEMPLATES = [
    ['אינו תורני או אינו רלוונטי לקטע', 'לא רלוונטי לקטע'],
    ['לשון שאינה מכבדת או פוגענית', 'לשון לא ראויה'],
    ['נושא פוליטי או אישי', 'פוליטי/אישי'],
    ['תוכן פרסומי או מסחרי', 'פרסום/מסחרי'],
    ['העתקת קטע ארוך מספר', 'זכויות יוצרים'],
  ];

  async function renderModPanel(container) {
    var el = CN.ui.el;
    container.textContent = '';

    var wrap = el('div', { className: 'container-narrow' });
    wrap.appendChild(el('div', { className: 'section-header' }, [
      el('h2', { className: 'section-heading', text: 'לוח מודרטורים' }),
      el('div', { className: 'card-actions-group' }, [
        el('button', {
          type: 'button',
          className: 'btn-secondary',
          text: 'הפק קוד הזמנה',
          onClick: createInviteCode,
        }),
        el('button', {
          type: 'button',
          className: 'btn-secondary',
          text: 'רענן',
          onClick: function () { renderModPanel(container); },
        }),
      ]),
    ]));

    try {
      var res = await CN.api.request('GET', '/v1/mod/queue', {
        auth: true,
        identity: CN.state.identity,
        settings: CN.state.settings,
      });
      if (!res.ok) throw new Error('אין גישה');
      CN.state.modQueue = res.data.items || [];
    } catch (err) {
      wrap.appendChild(el('div', { className: 'status-banner error', text: err.message || 'שגיאה בטעינת תור המודרציה' }));
      container.appendChild(wrap);
      return;
    }

    if (CN.state.modQueue.length === 0) {
      wrap.appendChild(el('div', { className: 'empty-state' }, [
        el('span', { className: 'empty-state-icon' }, CN.ui.getSvgIcon('checkCircle')),
        el('span', { text: 'תור המודרציה ריק' }),
      ]));
    } else {
      for (var i = 0; i < CN.state.modQueue.length; i++) {
        wrap.appendChild(buildModItemCard(CN.state.modQueue[i], container));
      }
    }

    // Decision log
    try {
      var logRes = await CN.api.request('GET', '/v1/mod/log', {
        auth: true,
        identity: CN.state.identity,
        settings: CN.state.settings,
      });
      if (logRes.ok && logRes.data && Array.isArray(logRes.data.items)) {
        var logCard = el('section', { className: 'settings-card' }, [
          el('h3', { className: 'settings-card-title', text: 'יומן החלטות אחרונות' }),
        ]);
        var logBody = el('div', { className: 'settings-card-body' });
        logRes.data.items.slice(0, 15).forEach(function (entry) {
          logBody.appendChild(el('div', { className: 'settings-row' }, [
            el('div', {}, [
              el('div', { className: 'settings-row-title', text: (entry.actor_name || 'מודרטור') + ': ' + entry.action }),
              el('div', { className: 'settings-row-subtitle', text: (entry.reason || '') + ' · ' + CN.ui.formatRelativeTime(entry.at) }),
            ]),
          ]));
        });
        logCard.appendChild(logBody);
        wrap.appendChild(logCard);
      }
    } catch (_) { /* ignore log error */ }

    container.appendChild(wrap);
  }

  function buildModItemCard(item, container) {
    var el = CN.ui.el;
    var card = el('article', { className: 'card' });

    card.appendChild(el('div', { className: 'card-header' }, [
      el('div', { className: 'card-author-row' }, [
        el('span', { className: 'author-name', text: item.author.displayName || 'לומד' }),
        el('span', { className: 'tag', text: 'רמה: ' + item.author.level }),
        el('span', { className: 'meta-time', text: 'מאושרות: ' + item.author.publishedCount + ' | נדחו: ' + item.author.rejectedCount }),
      ]),
      el('div', { className: 'card-author-row' }, [
        el('span', { className: 'tag warning', text: 'סיכון: ' + item.riskScore }),
        item.appealStatus === 'pending' ? el('span', { className: 'tag primary', text: 'ערעור' }) : null,
        item.moderationCategory ? el('span', { className: 'tag error', text: item.moderationCategory }) : null,
      ]),
    ]));

    card.appendChild(el('div', {
      className: 'meta-time',
      text: (item.titleHint || item.bookUid) + ' · ' + item.ref + ' (מקטע ' + item.sectionHint + ')',
    }));

    if (item.quote) {
      card.appendChild(el('div', { className: 'quote-box' }, [
        el('div', { className: 'quote-text', text: item.quote }),
      ]));
    }

    var bodyEl = el('div', { className: 'note-body selectable' });
    CN.ui.renderSafeNoteBody(bodyEl, item.body);
    card.appendChild(bodyEl);

    if (item.appealNote) {
      card.appendChild(el('div', { className: 'status-banner info', text: 'נימוק ערעור: ' + item.appealNote }));
    }
    if (item.reports && item.reports.length > 0) {
      card.appendChild(el('div', {
        className: 'status-banner warning',
        text: 'דיווחים פתוחים (' + item.reports.length + '): ' + item.reports.map(function (r) { return r.reason + (r.details ? ' — ' + r.details : ''); }).join(' | '),
      }));
    }

    async function decide(action, reason) {
      var res = await CN.api.request('POST', '/v1/mod/decide', {
        auth: true,
        identity: CN.state.identity,
        settings: CN.state.settings,
        bodyObj: { noteId: item.id, action: action, reason: reason || '' },
      });
      if (res.ok) {
        CN.ui.showToast('החלטת מודרציה נשמרה');
        renderModPanel(container);
      } else {
        CN.ui.showToast('שגיאה בביצוע הפעולה');
      }
    }

    var actions = el('div', { className: 'card-actions-group' }, [
      el('button', { type: 'button', className: 'btn-primary', text: 'אשר', onClick: function () { decide('approve', ''); } }),
      el('button', {
        type: 'button',
        className: 'btn-secondary',
        text: 'דחה עם סיבה',
        onClick: function () {
          CN.ui.openReasonModal('בחר סיבת דחייה', REJECT_TEMPLATES, function (reason, details) {
            decide('reject', details || reason);
          }, { withDetails: true });
        },
      }),
      el('button', {
        type: 'button',
        className: 'btn-secondary',
        text: 'הסתר',
        onClick: function () {
          CN.ui.openReasonModal('סיבת הסתרה', REJECT_TEMPLATES, function (reason, details) {
            decide('hide', details || reason);
          }, { withDetails: true });
        },
      }),
      el('button', {
        type: 'button',
        className: 'btn-secondary',
        text: 'עגן מחדש',
        onClick: function () { openReanchorModal(item, container); },
      }),
      el('button', {
        type: 'button',
        className: 'action-btn danger',
        text: 'חסום 7 ימים',
        onClick: function () { decide('ban_temp', 'חסימה זמנית עקב הפרת נוהל'); },
      }),
    ]);
    card.appendChild(actions);
    return card;
  }

  function openReanchorModal(item, container) {
    var el = CN.ui.el;
    var modal = document.getElementById('modal-backdrop');
    var box = document.getElementById('modal-dialog');
    box.textContent = '';

    var refInput = el('input', { className: 'input', type: 'text', value: item.ref || '' });
    var secInput = el('input', { className: 'input', type: 'number', value: String(item.sectionHint || 0) });
    var quoteInput = el('input', { className: 'input', type: 'text', value: item.quote || '' });

    box.appendChild(el('h3', { text: 'כלי עיגון מחדש (עדכון ספרייה)' }));
    box.appendChild(el('label', { text: 'מראה מקום (ref)' }));
    box.appendChild(refInput);
    box.appendChild(el('label', { text: 'אינדקס מקטע (sectionHint)' }));
    box.appendChild(secInput);
    box.appendChild(el('label', { text: 'ציטוט (עד 200 תווים)' }));
    box.appendChild(quoteInput);
    box.appendChild(el('div', { className: 'card-actions-group' }, [
      el('button', {
        type: 'button',
        className: 'btn-primary',
        text: 'שמור עוגן חדש',
        onClick: async function () {
          var res = await CN.api.request('POST', '/v1/mod/reanchor', {
            auth: true,
            identity: CN.state.identity,
            settings: CN.state.settings,
            bodyObj: {
              noteId: item.id,
              ref: refInput.value.trim(),
              sectionHint: Number(secInput.value || 0),
              quote: quoteInput.value.trim(),
            },
          });
          modal.classList.remove('open');
          if (res.ok) {
            CN.ui.showToast('העוגן עודכן');
            renderModPanel(container);
          } else {
            CN.ui.showToast('שגיאה בעדכון העוגן');
          }
        },
      }),
      el('button', {
        type: 'button',
        className: 'btn-secondary',
        text: CN.ui.t('בטל'),
        onClick: function () { modal.classList.remove('open'); },
      }),
    ]));
    modal.classList.add('open');
  }

  async function createInviteCode() {
    var res = await CN.api.request('POST', '/v1/mod/invites', {
      auth: true,
      identity: CN.state.identity,
      settings: CN.state.settings,
      bodyObj: { count: 1, level: 'active' },
    });
    if (res.ok && res.data && res.data.codes) {
      CN.ui.openReasonModal('קוד הזמנה חדש לבטא: ' + res.data.codes[0], [], function () {});
    } else {
      CN.ui.showToast('שגיאה ביצירת הזמנה');
    }
  }

  CN.modUi = {
    renderModPanel: renderModPanel,
  };
})(typeof window !== 'undefined' ? window : globalThis);
