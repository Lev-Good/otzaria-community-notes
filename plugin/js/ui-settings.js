(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  function openSettingsPanel() {
    renderSettingsPanel();
    document.getElementById('settings-scrim').classList.add('open');
    document.getElementById('settings-panel').classList.add('open');
  }

  function closeSettingsPanel() {
    document.getElementById('settings-scrim').classList.remove('open');
    document.getElementById('settings-panel').classList.remove('open');
  }

  function renderSettingsPanel() {
    var el = CN.ui.el;
    var body = document.getElementById('settings-body');
    if (!body) return;
    body.textContent = '';

    var s = CN.state.settings;
    var perms = CN.state.permissions || [];
    var hasBgPerm = perms.indexOf('app.run_on_startup') !== -1;
    var hasHlPerm = perms.indexOf('reader.highlight') !== -1;
    var hasSysNotifPerm = perms.indexOf('notifications.system') !== -1;

    function addSegmentedRow(cardBody, title, subtitle, value, options, onChange) {
      var seg = el('div', { className: 'segmented' });
      options.forEach(function (opt) {
        seg.appendChild(el('button', {
          type: 'button',
          className: value === opt[0] ? 'active' : '',
          text: opt[1],
          onClick: async function () {
            await onChange(opt[0]);
            renderSettingsPanel();
          },
        }));
      });
      cardBody.appendChild(el('div', { className: 'settings-row stacked' }, [
        el('div', {}, [
          el('div', { className: 'settings-row-title', text: title }),
          subtitle ? el('div', { className: 'settings-row-subtitle', text: subtitle }) : null,
        ]),
        seg,
      ]));
    }

    function addSwitchRow(cardBody, title, subtitle, checked, disabled, onToggle) {
      var sw = el('button', {
        type: 'button',
        className: 'switch',
        role: 'switch',
        'aria-label': title,
        'aria-checked': checked ? 'true' : 'false',
        disabled: disabled,
        onClick: async function () {
          if (disabled) return;
          await onToggle(!checked);
          renderSettingsPanel();
        },
      });
      cardBody.appendChild(el('div', { className: 'settings-row' }, [
        el('div', {}, [
          el('div', { className: 'settings-row-title', text: title }),
          subtitle ? el('div', { className: 'settings-row-subtitle', text: subtitle }) : null,
        ]),
        sw,
      ]));
    }

    async function saveAndRefresh(mutateDisplay) {
      await CN.storage.saveSettings(CN.state.settings);
      if (mutateDisplay) CN.ui.applyUserDisplaySettings();
      CN.app.refreshCurrentScreen();
    }

    // 1. Display card
    var displayCard = el('section', { className: 'settings-card' }, [
      el('h3', { className: 'settings-card-title', text: 'תצוגה' }),
    ]);
    var displayBody = el('div', { className: 'settings-card-body' });

    addSegmentedRow(displayBody, 'רמת סינון', 'דרגת הסינון נקבעת לפי דירוג הקהילה בשרת', s.filterTier, [
      ['recommended_and_new', 'מומלצות וחדשות'],
      ['recommended_only', 'מומלצות בלבד'],
      ['all', 'הכל'],
    ], async function (v) { s.filterTier = v; CN.state.sectionFilter = v; await saveAndRefresh(false); });

    addSegmentedRow(displayBody, 'מיון בתוך קבוצה', '', s.sortOrder, [
      ['recommended', 'מומלצות קודם'],
      ['newest', 'חדשות קודם'],
    ], async function (v) { s.sortOrder = v; CN.state.sectionSort = v; await saveAndRefresh(false); });

    // Content types multi-select
    var ctGroup = el('div', { className: 'chip-group' });
    [['note', 'הערות'], ['question', 'שאלות'], ['answer', 'תשובות']].forEach(function (pair) {
      var active = s.contentTypes[pair[0]] !== false;
      ctGroup.appendChild(el('button', {
        type: 'button',
        className: 'chip-btn' + (active ? ' active' : ''),
        text: pair[1],
        onClick: async function () {
          s.contentTypes[pair[0]] = !active;
          await saveAndRefresh(false);
          renderSettingsPanel();
        },
      }));
    });
    displayBody.appendChild(el('div', { className: 'settings-row stacked' }, [
      el('div', { className: 'settings-row-title', text: 'סוגי תוכן' }),
      el('div', { className: 'settings-row-subtitle', text: 'תשובות מוצגות בתוך שרשור גם כשהן מסוננות' }),
      ctGroup,
    ]));

    addSegmentedRow(displayBody, 'גודל טקסט בכרטיסים', '', s.cardTextSize, [
      ['otzaria', 'לפי אוצריא'], ['small', 'קטן'], ['medium', 'בינוני'], ['large', 'גדול'],
    ], async function (v) { s.cardTextSize = v; await saveAndRefresh(true); });

    addSegmentedRow(displayBody, 'ניקוד וטעמים בציטוט', '', s.nikudMode, [
      ['otzaria', 'לפי אוצריא'], ['always', 'תמיד'], ['never', 'אף פעם'],
    ], async function (v) { s.nikudMode = v; await saveAndRefresh(false); });

    addSegmentedRow(displayBody, 'צפיפות', '', s.density, [
      ['comfortable', 'נוחה'], ['compact', 'קומפקטית'],
    ], async function (v) { s.density = v; await saveAndRefresh(true); });

    addSegmentedRow(displayBody, 'כרטיסים ארוכים', 'מעל ארבע שורות', s.longCards, [
      ['collapsed', 'מקופלים'], ['expanded', 'פתוחים'],
    ], async function (v) { s.longCards = v; await saveAndRefresh(false); });

    addSegmentedRow(displayBody, 'ציטוט בקבוצה', '', s.groupQuoteMode, [
      ['single_line', 'שורה אחת'], ['full', 'מלא'],
    ], async function (v) { s.groupQuoteMode = v; await saveAndRefresh(false); });

    addSegmentedRow(displayBody, 'מספר "מועיל"', '', s.helpfulCountMode, [
      ['from_3', 'מ־3'], ['always', 'תמיד'], ['never', 'אף פעם'],
    ], async function (v) { s.helpfulCountMode = v; await saveAndRefresh(false); });

    displayBody.appendChild(el('div', { className: 'settings-row' }, [
      el('div', {}, [
        el('div', { className: 'settings-row-title', text: 'ערכת צבעים' }),
        el('div', { className: 'settings-row-subtitle', text: 'מותאמת אוטומטית לערכת הצבעים של אוצריא' }),
      ]),
      el('span', { className: 'tag', text: 'לפי אוצריא' }),
    ]));

    displayCard.appendChild(displayBody);
    body.appendChild(displayCard);

    // 2. Behavior card
    var behCard = el('section', { className: 'settings-card' }, [
      el('h3', { className: 'settings-card-title', text: 'התנהגות' }),
    ]);
    var behBody = el('div', { className: 'settings-card-body' });

    addSegmentedRow(behBody, 'מסך פתיחה', '', s.startScreen, [
      ['section', 'בקטע'], ['questions', 'שאלות'], ['home', 'בית'],
    ], async function (v) { s.startScreen = v; await saveAndRefresh(false); });

    addSwitchRow(behBody, 'חזרה לספר אחרי שליחה', '', s.returnAfterSubmit !== false, false, async function (v) {
      s.returnAfterSubmit = v; await saveAndRefresh(false);
    });
    addSwitchRow(behBody, 'חזרה לספר אחרי "הצג בטקסט"', '', s.returnAfterReveal !== false, false, async function (v) {
      s.returnAfterReveal = v; await saveAndRefresh(false);
    });
    addSegmentedRow(behBody, 'סוג ברירת מחדל בטופס', '', s.defaultComposerKind, [
      ['note', 'הערה'], ['question', 'שאלה'], ['last', 'האחרון שבחרתי'],
    ], async function (v) { s.defaultComposerKind = v; await saveAndRefresh(false); });

    addSwitchRow(behBody, 'שמירת טיוטות אוטומטית', '', s.autosaveDrafts !== false, false, async function (v) {
      s.autosaveDrafts = v; await saveAndRefresh(false);
    });

    behBody.appendChild(el('div', { className: 'settings-row' }, [
      el('div', {}, [
        el('div', { className: 'settings-row-title', text: 'קיצור מקלדת להוספת הערה' }),
        el('div', { className: 'settings-row-subtitle', text: 'ברירת מחדל: Ctrl+Alt+N. לשינוי: הגדרות ← קיצורי מקשים ← קיצורי תוספים באוצריא' }),
      ]),
    ]));

    // Hidden words personal list
    var hwInput = el('input', { className: 'input', type: 'text', placeholder: 'הוסף מילה להסתרה מקומית...' });
    var hwChips = el('div', { className: 'chip-group' });
    (s.hiddenWords || []).forEach(function (word) {
      hwChips.appendChild(el('button', {
        type: 'button',
        className: 'chip-btn',
        text: word + ' ×',
        onClick: async function () {
          s.hiddenWords = s.hiddenWords.filter(function (w) { return w !== word; });
          await saveAndRefresh(false);
          renderSettingsPanel();
        },
      }));
    });
    behBody.appendChild(el('div', { className: 'settings-row stacked' }, [
      el('div', { className: 'settings-row-title', text: 'מילים להסתרה (מקומי)' }),
      el('div', { className: 'card-actions-group' }, [
        hwInput,
        el('button', {
          type: 'button',
          className: 'btn-secondary',
          text: 'הוסף',
          onClick: async function () {
            var w = hwInput.value.trim();
            if (w && s.hiddenWords.indexOf(w) === -1) {
              s.hiddenWords.push(w);
              await saveAndRefresh(false);
              renderSettingsPanel();
            }
          },
        }),
      ]),
      hwChips,
    ]));

    // Blocked authors list
    var blkChips = el('div', { className: 'chip-group' });
    (s.blockedAuthors || []).forEach(function (author) {
      blkChips.appendChild(el('button', {
        type: 'button',
        className: 'chip-btn',
        text: author.name + ' (בטל חסימה)',
        onClick: async function () {
          s.blockedAuthors = s.blockedAuthors.filter(function (x) { return x.id !== author.id; });
          await saveAndRefresh(false);
          renderSettingsPanel();
        },
      }));
    });
    behBody.appendChild(el('div', { className: 'settings-row stacked' }, [
      el('div', { className: 'settings-row-title', text: 'כותבים חסומים (מקומי)' }),
      (s.blockedAuthors && s.blockedAuthors.length > 0)
        ? blkChips
        : el('div', { className: 'settings-row-subtitle', text: 'אין כותבים חסומים' }),
    ]));

    behCard.appendChild(behBody);
    body.appendChild(behCard);

    // 3. Text Highlights (Extended Layer)
    var hlCard = el('section', { className: 'settings-card' }, [
      el('h3', { className: 'settings-card-title', text: 'סימון בטקסט (טור ראשי)' }),
    ]);
    var hlBody = el('div', { className: 'settings-card-body' });
    var hlDisabled = !hasBgPerm || !hasHlPerm;
    if (hlDisabled) {
      hlBody.appendChild(el('div', {
        className: 'settings-row',
        text: 'כבוי כי חסרה הרשאת ריצת רקע או הדגשה בהגדרות התוסף באוצריא.',
      }));
    }
    addSwitchRow(hlBody, 'סימון הערות בטקסט', '', Boolean(s.highlightEnabled && !hlDisabled), hlDisabled, async function (v) {
      s.highlightEnabled = v; await saveAndRefresh(false);
    });
    addSegmentedRow(hlBody, 'עוצמה', '', s.highlightIntensity, [
      ['subtle', 'עדין'], ['normal', 'רגיל'],
    ], async function (v) { s.highlightIntensity = v; await saveAndRefresh(false); });
    addSwitchRow(hlBody, 'צבע נפרד לשאלות פתוחות', '', s.highlightSeparateQuestions !== false, hlDisabled, async function (v) {
      s.highlightSeparateQuestions = v; await saveAndRefresh(false);
    });
    addSwitchRow(hlBody, 'סמן מומלצות בלבד', '', Boolean(s.highlightRecommendedOnly), hlDisabled, async function (v) {
      s.highlightRecommendedOnly = v; await saveAndRefresh(false);
    });
    hlCard.appendChild(hlBody);
    body.appendChild(hlCard);

    // 4. Notifications
    var notifCard = el('section', { className: 'settings-card' }, [
      el('h3', { className: 'settings-card-title', text: 'התראות' }),
    ]);
    var notifBody = el('div', { className: 'settings-card-body' });
    addSwitchRow(notifBody, 'התראות בתוך אוצריא', '', s.inAppNotifications !== false, false, async function (v) {
      s.inAppNotifications = v; await saveAndRefresh(false);
    });

    var ntGroup = el('div', { className: 'chip-group' });
    [
      ['reply', 'תגובה להערתי'],
      ['answer', 'תשובה לשאלתי'],
      ['accepted', 'תשובה מקובלת'],
      ['moderation', 'החלטת מודרציה'],
    ].forEach(function (pair) {
      var active = s.notifyTypes[pair[0]] !== false;
      ntGroup.appendChild(el('button', {
        type: 'button',
        className: 'chip-btn' + (active ? ' active' : ''),
        text: pair[1],
        onClick: async function () {
          s.notifyTypes[pair[0]] = !active;
          await saveAndRefresh(false);
          renderSettingsPanel();
        },
      }));
    });
    notifBody.appendChild(el('div', { className: 'settings-row stacked' }, [
      el('div', { className: 'settings-row-title', text: 'סוגי התראות' }),
      ntGroup,
    ]));

    addSwitchRow(
      notifBody,
      'התראת מערכת',
      hasSysNotifPerm ? 'פועל כשאוצריא פתוחה' : 'כבוי כי הרשאת התראות מערכת אינה מאושרת',
      Boolean(s.systemNotifications && hasSysNotifPerm),
      !hasSysNotifPerm,
      async function (v) { s.systemNotifications = v; await saveAndRefresh(false); }
    );

    addSegmentedRow(
      notifBody,
      'תדירות בדיקה ברקע',
      hasBgPerm ? '' : 'דורש הרשאת ריצת רקע (app.run_on_startup)',
      String(s.bgCheckFrequencyMin),
      [['30', 'כל 30 דקות'], ['60', 'כל שעה'], ['0', 'רק בעליית אוצריא']],
      async function (v) {
        if (!hasBgPerm) return;
        s.bgCheckFrequencyMin = Number(v);
        await saveAndRefresh(false);
      }
    );

    addSwitchRow(notifBody, 'שבת וחג', 'לא להציג התראות בשבת וביום טוב', s.shabbatQuietMode !== false, false, async function (v) {
      s.shabbatQuietMode = v; await saveAndRefresh(false);
    });

    notifCard.appendChild(notifBody);
    body.appendChild(notifCard);

    // 5. Account & Privacy
    var accCard = el('section', { className: 'settings-card' }, [
      el('h3', { className: 'settings-card-title', text: 'חשבון ופרטיות' }),
    ]);
    var accBody = el('div', { className: 'settings-card-body' });

    if (CN.state.identity && CN.state.identity.userId) {
      var renameInput = el('input', { className: 'input', type: 'text', value: CN.state.identity.displayName });
      accBody.appendChild(el('div', { className: 'settings-row stacked' }, [
        el('div', { className: 'settings-row-title', text: 'שם תצוגה (שינוי עד פעם בחודש)' }),
        el('div', { className: 'card-actions-group' }, [
          renameInput,
          el('button', {
            type: 'button',
            className: 'btn-secondary',
            text: CN.ui.t('שמור'),
            onClick: async function () {
              var res = await CN.api.request('PATCH', '/v1/me', {
                auth: true,
                identity: CN.state.identity,
                settings: s,
                bodyObj: { displayName: renameInput.value.trim() },
              });
              if (res.ok && res.data) {
                CN.state.identity.displayName = res.data.displayName;
                await CN.storage.set(CN.storage.KEYS.IDENTITY, CN.state.identity);
                CN.ui.showToast('שם התצוגה עודכן');
              } else {
                CN.ui.showToast((res.data && res.data.error && res.data.error.message) || 'לא ניתן לעדכן שם');
              }
            },
          }),
        ]),
      ]));

      accBody.appendChild(el('div', { className: 'settings-row' }, [
        el('div', {}, [
          el('div', { className: 'settings-row-title', text: 'קוד שחזור' }),
          el('div', { className: 'settings-row-subtitle', text: 'הצגה והעתקה אחרי אישור, או ייבוא ממכשיר אחר' }),
        ]),
        el('button', {
          type: 'button',
          className: 'btn-secondary',
          text: 'הצג',
          onClick: async function () {
            var ok = true;
            try {
              var c = await global.Otzaria.call('ui.showConfirm', {
                title: 'הצגת קוד שחזור',
                message: 'קוד זה מאפשר להעביר את החשבון שלך למכשיר אחר. להציג כעת?',
                confirmText: 'הצג',
                cancelText: 'בטל',
              });
              ok = Boolean(c && c.success && c.data === true);
            } catch (_) { /* ok */ }
            if (ok) {
              openRecoveryDisplayModal(CN.state.identity.recoveryCode || 'לא זמין במכשיר זה');
            }
          },
        }),
      ]));

      accBody.appendChild(el('div', { className: 'settings-row' }, [
        el('div', { className: 'settings-row-title', text: 'ייצוא הנתונים שלי (JSON)' }),
        el('button', {
          type: 'button',
          className: 'btn-secondary',
          text: 'ייצא',
          onClick: exportMyData,
        }),
      ]));

      accBody.appendChild(el('div', { className: 'settings-row' }, [
        el('div', { className: 'settings-row-title', text: 'ניתוק המכשיר' }),
        el('button', {
          type: 'button',
          className: 'btn-secondary',
          text: 'נתק',
          onClick: async function () {
            await CN.storage.remove(CN.storage.KEYS.IDENTITY);
            CN.state.identity = null;
            CN.ui.showToast('המכשיר נותק. חזרה דורשת קוד שחזור');
            CN.app.renderChrome();
            renderSettingsPanel();
          },
        }),
      ]));

      accBody.appendChild(el('div', { className: 'settings-row' }, [
        el('div', { className: 'settings-row-title', text: 'מחיקת חשבון' }),
        el('button', {
          type: 'button',
          className: 'action-btn danger',
          text: 'מחק חשבון',
          onClick: confirmDeleteAccount,
        }),
      ]));
    } else {
      accBody.appendChild(el('div', { className: 'settings-row' }, [
        el('div', { className: 'settings-row-title', text: 'ייבוא זהות ממכשיר אחר' }),
        el('button', {
          type: 'button',
          className: 'btn-secondary',
          text: 'הזן קוד שחזור',
          onClick: function () {
            closeSettingsPanel();
            CN.onboarding.openRecoveryImportModal();
          },
        }),
      ]));
    }

    accBody.appendChild(el('div', { className: 'settings-row' }, [
      el('div', {}, [
        el('div', { className: 'settings-row-title', text: 'ייבוא מהערות אישיות' }),
        el('div', { className: 'settings-row-subtitle', text: 'מעבר מהיר על כל ההערות שלך באוצריא ובחירת אילו להעלות לקהילה' }),
      ]),
      el('button', {
        type: 'button',
        className: 'btn-secondary',
        text: 'פתח ייבוא',
        onClick: function () {
          closeSettingsPanel();
          CN.app.navigate('import');
        },
      }),
    ]));

    accBody.appendChild(el('div', { className: 'settings-row' }, [
      el('div', {}, [
        el('div', { className: 'settings-row-title', text: 'איפוס מטמון מקומי' }),
        el('div', { className: 'settings-row-subtitle', text: 'מנקה הערות שמורות. הטיוטות נשארות' }),
      ]),
      el('button', {
        type: 'button',
        className: 'btn-secondary',
        text: 'נקה מטמון',
        onClick: async function () {
          await CN.storage.clearSectionCache();
          CN.ui.showToast('המטמון המקומי נוקה');
        },
      }),
    ]));

    // Optional server URL setting for staging/self-hosting
    var srvInput = el('input', {
      className: 'input',
      type: 'url',
      dir: 'ltr',
      value: s.apiBaseUrl || '',
      placeholder: CN.config.DEFAULT_API_BASE,
    });
    accBody.appendChild(el('div', { className: 'settings-row stacked' }, [
      el('div', { className: 'settings-row-title', text: 'כתובת שרת הקהילה (מתקדם)' }),
      el('div', { className: 'card-actions-group' }, [
        srvInput,
        el('button', {
          type: 'button',
          className: 'btn-secondary',
          text: CN.ui.t('שמור'),
          onClick: async function () {
            s.apiBaseUrl = srvInput.value.trim();
            await saveAndRefresh(false);
            CN.ui.showToast('כתובת השרת נשמרה');
          },
        }),
      ]),
    ]));

    accCard.appendChild(accBody);
    body.appendChild(accCard);

    // 6. Read-only Permissions Status
    var permCard = el('section', { className: 'settings-card' }, [
      el('h3', { className: 'settings-card-title', text: 'מצב הרשאות (לקריאה בלבד)' }),
    ]);
    var permBody = el('div', { className: 'settings-card-body' });
    [
      ['app.run_on_startup', 'ריצת רקע', 'מאפשרת בדיקת התראות תקופתית וסימון בטקסט בפתיחת ספרים'],
      ['notifications.system', 'התראות מערכת', 'מאפשרת התראות של מערכת ההפעלה כשאוצריא פתוחה'],
      ['reader.highlight', 'סימון בטקסט', 'מאפשרת הדגשת ציטוטים בטור הטקסט הראשי וכפתור "הצג בטקסט"'],
    ].forEach(function (item) {
      var granted = perms.indexOf(item[0]) !== -1;
      permBody.appendChild(el('div', { className: 'settings-row' }, [
        el('div', {}, [
          el('div', { className: 'settings-row-title', text: item[1] }),
          el('div', { className: 'settings-row-subtitle', text: item[2] }),
        ]),
        el('span', { className: 'tag ' + (granted ? 'primary' : ''), text: granted ? 'מופעל' : 'כבוי' }),
      ]));
    });
    permBody.appendChild(el('div', { className: 'settings-row' }, [
      el('div', {
        className: 'settings-row-subtitle',
        text: 'לשינוי הרשאות: הגדרות ← כלים ← תוספים מותקנים באוצריא.',
      }),
    ]));
    permCard.appendChild(permBody);
    body.appendChild(permCard);
  }

  async function exportMyData() {
    try {
      var res = await CN.api.request('GET', '/v1/me/export', {
        auth: true,
        identity: CN.state.identity,
        settings: CN.state.settings,
      });
      if (!res.ok || !res.data) throw new Error('שגיאה בקבלת הנתונים מהשרת');
      var jsonStr = JSON.stringify(res.data, null, 2);
      var blob = new Blob([jsonStr], { type: 'application/json' });

      if (global.Otzaria && global.Otzaria.__isStub !== true) {
        var begin = await global.Otzaria.call('fs.beginBinaryWrite', {
          purpose: 'user-file',
          expectedSize: blob.size,
        });
        if (!begin.success || !begin.data) throw new Error('לא ניתן להתחיל שמירת קובץ');
        var ticket = begin.data;
        try {
          var putRes = await global.fetch(ticket.uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: blob,
          });
          if (!putRes.ok) throw new Error('העלאת הקובץ נכשלה');
          var commit = await global.Otzaria.call('fs.commitUserFileWrite', {
            writeToken: ticket.writeToken,
            suggestedName: 'community-notes-export',
            extension: 'json',
            title: 'ייצוא הנתונים שלי מהערות הקהילה',
          });
          if (commit.success && commit.data && !commit.data.cancelled) {
            CN.ui.showToast('הנתונים יוצאו בהצלחה');
          }
        } catch (innerErr) {
          try { await global.Otzaria.call('fs.abortBinaryWrite', { writeToken: ticket.writeToken }); } catch (_) {}
          throw innerErr;
        }
      } else {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'community-notes-export.json';
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      CN.ui.showToast(err.message || 'שגיאה בייצוא הנתונים');
    }
  }

  async function confirmDeleteAccount() {
    var warnOk = true;
    try {
      var w = await global.Otzaria.call('ui.showWarning', {
        title: 'מחיקת חשבון',
        message: 'מחיקת החשבון אינה הפיכה. ההערות שלך יוסרו או יהפכו לאנונימיות לפי בחירתך.',
      });
      if (w && w.success && w.data === false) warnOk = false;
    } catch (_) { /* continue */ }
    if (!warnOk) return;

    CN.ui.openReasonModal('איך לטפל בתוכן שפרסמת בעת מחיקת החשבון?', [
      ['anonymize', 'הפוך לאנונימי (שמור הערות מועילות בלי שמי)'],
      ['delete', 'מחק את כל התוכן שלי'],
    ], async function (mode) {
      var res = await CN.api.request('DELETE', '/v1/me', {
        auth: true,
        identity: CN.state.identity,
        settings: CN.state.settings,
        bodyObj: { mode: mode },
      });
      if (res.ok) {
        await CN.storage.remove(CN.storage.KEYS.IDENTITY);
        CN.state.identity = null;
        closeSettingsPanel();
        CN.ui.showToast('החשבון נמחק');
        CN.app.renderChrome();
        CN.app.navigate('home');
      } else {
        CN.ui.showToast('שגיאה במחיקת החשבון');
      }
    });
  }

  function openRecoveryDisplayModal(code) {
    var el = CN.ui.el;
    var modal = document.getElementById('modal-backdrop');
    var box = document.getElementById('modal-dialog');
    if (!modal || !box) return;
    box.textContent = '';
    box.appendChild(el('h3', { text: 'קוד השחזור שלך' }));
    box.appendChild(el('div', { className: 'recovery-code-box', text: code }));
    box.appendChild(el('div', { className: 'card-actions-group' }, [
      el('button', {
        type: 'button',
        className: 'btn-primary',
        text: 'העתק קוד',
        onClick: async function () {
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(code);
              CN.ui.showToast('קוד השחזור הועתק');
            }
          } catch (_) { /* ignore */ }
        },
      }),
      el('button', {
        type: 'button',
        className: 'btn-secondary',
        text: CN.ui.t('סגור'),
        onClick: function () { modal.classList.remove('open'); },
      }),
    ]));
    modal.classList.add('open');
  }

  CN.settingsUi = {
    openSettingsPanel: openSettingsPanel,
    closeSettingsPanel: closeSettingsPanel,
    renderSettingsPanel: renderSettingsPanel,
  };
})(typeof window !== 'undefined' ? window : globalThis);
