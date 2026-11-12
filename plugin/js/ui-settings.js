(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  var activeTab = 'display';
  var prioritySyncRunning = false;

  var TABS = [
    { id: 'display', label: 'תצוגה וכתיבה', icon: 'display' },
    { id: 'menus', label: 'הדגשות ותפריטים', icon: 'menus' },
    { id: 'sync', label: 'סנכרון ולימוד יומי', icon: 'sync' },
    { id: 'notifications', label: 'התראות', icon: 'bell' },
    { id: 'account', label: 'חשבון ושרת', icon: 'account' },
  ];

  function openSettingsPanel(tabId) {
    if (tabId) activeTab = tabId;
    renderSettingsPanel();
    document.getElementById('settings-scrim').classList.add('open');
    document.getElementById('settings-panel').classList.add('open');
  }

  function closeSettingsPanel() {
    document.getElementById('settings-scrim').classList.remove('open');
    document.getElementById('settings-panel').classList.remove('open');
  }

  async function renderSettingsPanel() {
    var el = CN.ui.el;
    var tabsHost = document.getElementById('settings-tabs');
    var body = document.getElementById('settings-body');
    var subtitleEl = document.getElementById('settings-subtitle');
    if (!body) return;

    var s = CN.state.settings;
    var perms = CN.state.permissions || [];
    var hasBgPerm = perms.indexOf('app.run_on_startup') !== -1;
    var hasHlPerm = perms.indexOf('reader.highlight') !== -1;
    var hasSysNotifPerm = perms.indexOf('notifications.system') !== -1;
    var hasCalPerm = perms.indexOf('calendar.read') !== -1;

    if (subtitleEl) {
      var who = (CN.state.identity && CN.state.identity.userId)
        ? ('מחובר כ־' + CN.state.identity.displayName)
        : 'גלישה כאורח (קריאה בלבד)';
      subtitleEl.textContent = who + ' · גרסה ' + (CN.config.PLUGIN_VERSION || '');
    }

    if (tabsHost) {
      tabsHost.textContent = '';
      TABS.forEach(function (tab) {
        var isSel = activeTab === tab.id;
        tabsHost.appendChild(el('button', {
          type: 'button',
          role: 'tab',
          'aria-selected': isSel ? 'true' : 'false',
          className: 'settings-tab-btn' + (isSel ? ' active' : ''),
          onClick: function () {
            activeTab = tab.id;
            renderSettingsPanel();
          },
        }, [
          CN.ui.getSvgIcon ? CN.ui.getSvgIcon(tab.icon) : null,
          el('span', { text: tab.label }),
        ]));
      });
    }

    body.textContent = '';

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
      cardBody.appendChild(el('div', { className: 'settings-row' }, [
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

    function createCard(title) {
      var card = el('section', { className: 'settings-card' }, [
        el('h3', { className: 'settings-card-title', text: title }),
      ]);
      var cBody = el('div', { className: 'settings-card-body' });
      card.appendChild(cBody);
      return { card: card, body: cBody };
    }

    async function saveAndRefresh(mutateDisplay) {
      await CN.storage.saveSettings(CN.state.settings);
      if (mutateDisplay) CN.ui.applyUserDisplaySettings();
      CN.app.refreshCurrentScreen();
    }

    // ── TAB 1: Display & Writing ────────────────────────────────────────────
    if (activeTab === 'display') {
      var filterSec = createCard('סינון ומיון תוכן');
      addSegmentedRow(filterSec.body, 'רמת סינון', 'דרגת הסינון נקבעת לפי דירוג הקהילה בשרת', s.filterTier, [
        ['recommended_and_new', 'מומלצות וחדשות'],
        ['recommended_only', 'מומלצות בלבד'],
        ['all', 'הכל'],
      ], async function (v) { s.filterTier = v; CN.state.sectionFilter = v; await saveAndRefresh(false); });

      addSegmentedRow(filterSec.body, 'מיון בתוך קבוצה', 'סדר הופעת ההערות בכל ציטוט', s.sortOrder, [
        ['recommended', 'מומלצות קודם'],
        ['newest', 'חדשות קודם'],
      ], async function (v) { s.sortOrder = v; CN.state.sectionSort = v; await saveAndRefresh(false); });

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
      filterSec.body.appendChild(el('div', { className: 'settings-row' }, [
        el('div', {}, [
          el('div', { className: 'settings-row-title', text: 'סוגי תוכן מוצגים' }),
          el('div', { className: 'settings-row-subtitle', text: 'תשובות מוצגות בתוך שרשור גם כשהן מסוננות' }),
        ]),
        ctGroup,
      ]));

      addSegmentedRow(filterSec.body, 'הצגת מונה "מועיל"', 'מתי להציג כמה לומדים דירגו את ההערה', s.helpfulCountMode, [
        ['from_3', 'מ־3'], ['always', 'תמיד'], ['never', 'אף פעם'],
      ], async function (v) { s.helpfulCountMode = v; await saveAndRefresh(false); });
      body.appendChild(filterSec.card);

      var typoSec = createCard('טיפוגרפיה וכרטיסי הערות');
      addSegmentedRow(typoSec.body, 'גודל טקסט בכרטיסים', '', s.cardTextSize, [
        ['otzaria', 'לפי אוצריא'], ['small', 'קטן'], ['medium', 'בינוני'], ['large', 'גדול'],
      ], async function (v) { s.cardTextSize = v; await saveAndRefresh(true); });

      addSegmentedRow(typoSec.body, 'ניקוד וטעמים בציטוט', '', s.nikudMode, [
        ['otzaria', 'לפי אוצריא'], ['always', 'תמיד'], ['never', 'אף פעם'],
      ], async function (v) { s.nikudMode = v; await saveAndRefresh(false); });

      addSegmentedRow(typoSec.body, 'צפיפות תצוגה', '', s.density, [
        ['comfortable', 'נוחה'], ['compact', 'קומפקטית'],
      ], async function (v) { s.density = v; await saveAndRefresh(true); });

      addSegmentedRow(typoSec.body, 'כרטיסים ארוכים', 'מעל ארבע שורות', s.longCards, [
        ['collapsed', 'מקופלים'], ['expanded', 'פתוחים'],
      ], async function (v) { s.longCards = v; await saveAndRefresh(false); });

      addSegmentedRow(typoSec.body, 'ציטוט בקבוצה', '', s.groupQuoteMode, [
        ['single_line', 'שורה אחת'], ['full', 'מלא'],
      ], async function (v) { s.groupQuoteMode = v; await saveAndRefresh(false); });

      typoSec.body.appendChild(el('div', { className: 'settings-row' }, [
        el('div', {}, [
          el('div', { className: 'settings-row-title', text: 'ערכת צבעים' }),
          el('div', { className: 'settings-row-subtitle', text: 'מותאמת אוטומטית לערכת הצבעים של אוצריא' }),
        ]),
        el('span', { className: 'tag', text: 'לפי אוצריא' }),
      ]));
      body.appendChild(typoSec.card);

      var behSec = createCard('התנהגות, תצוגה מפוצלת וכתיבה');
      addSegmentedRow(behSec.body, 'מסך פתיחה', '', s.startScreen, [
        ['section', 'בקטע'], ['questions', 'שאלות'], ['home', 'בית'],
      ], async function (v) { s.startScreen = v; await saveAndRefresh(false); });

      addSegmentedRow(behSec.body, 'תצוגת ספר לצד התוסף', 'מציג את הספר מצד ימין ואת ההערות וכתיבתן מצד שמאל', s.splitBookPane || 'auto', [
        ['auto', 'חכם (בספר וכתיבה)'], ['always', 'תמיד כשיש ספר'], ['off', 'כבוי'],
      ], async function (v) {
        s.splitBookPane = v;
        CN.state.bookPaneOpenOverride = null;
        await saveAndRefresh(false);
      });

      addSegmentedRow(behSec.body, 'סוג ברירת מחדל בטופס', '', s.defaultComposerKind, [
        ['note', 'הערה'], ['question', 'שאלה'], ['last', 'האחרון שבחרתי'],
      ], async function (v) { s.defaultComposerKind = v; await saveAndRefresh(false); });

      addSwitchRow(behSec.body, 'חזרה לספר אחרי שליחה', 'מחזיר אוטומטית לחלון הקריאה בסיום כתיבה', s.returnAfterSubmit !== false, false, async function (v) {
        s.returnAfterSubmit = v; await saveAndRefresh(false);
      });
      addSwitchRow(behSec.body, 'חזרה לספר אחרי "הצג בטקסט"', 'כשהתצוגה המפוצלת אינה פתוחה', s.returnAfterReveal !== false, false, async function (v) {
        s.returnAfterReveal = v; await saveAndRefresh(false);
      });
      addSwitchRow(behSec.body, 'שמירת טיוטות אוטומטית', 'מונע איבוד טקסט בעת יציאה מהטופס', s.autosaveDrafts !== false, false, async function (v) {
        s.autosaveDrafts = v; await saveAndRefresh(false);
      });
      body.appendChild(behSec.card);
    }

    // ── TAB 2: Highlights, Context Menus & Personal Filters ──────────────────
    else if (activeTab === 'menus') {
      var hlSec = createCard('סימון הערות בטקסט הספר (טור ראשי)');
      var hlDisabled = !hasHlPerm;
      if (hlDisabled) {
        hlSec.body.appendChild(el('div', {
          className: 'settings-row',
          text: 'כבוי כי חסרה הרשאת הדגשה (reader.highlight) בהגדרות התוסף באוצריא.',
        }));
      } else if (!hasBgPerm) {
        hlSec.body.appendChild(el('div', {
          className: 'settings-row',
          text: 'הסימון בטקסט יפעל בעת פתיחת התוסף. לסימון אוטומטי ברקע הפעל הרשאת ריצת רקע באוצריא.',
        }));
      }
      addSwitchRow(hlSec.body, 'סימון הערות בטקסט', 'צובע ציטוטים שיש עליהם הערות קהילה בדף הספר', Boolean(s.highlightEnabled && !hlDisabled), hlDisabled, async function (v) {
        s.highlightEnabled = v;
        if (!v && CN.highlights && CN.highlights.clearPluginHighlights) {
          CN.highlights.clearPluginHighlights();
        }
        await saveAndRefresh(false);
      });
      addSegmentedRow(hlSec.body, 'עוצמת הדגשה', '', s.highlightIntensity, [
        ['subtle', 'עדין'], ['normal', 'רגיל'],
      ], async function (v) { s.highlightIntensity = v; await saveAndRefresh(false); });
      addSwitchRow(hlSec.body, 'צבע נפרד לשאלות פתוחות', 'מבחין בין ביאורים לבין שאלות המחכות לתשובה', s.highlightSeparateQuestions !== false, hlDisabled, async function (v) {
        s.highlightSeparateQuestions = v; await saveAndRefresh(false);
      });
      addSwitchRow(hlSec.body, 'סמן הערות מומלצות בלבד', '', Boolean(s.highlightRecommendedOnly), hlDisabled, async function (v) {
        s.highlightRecommendedOnly = v; await saveAndRefresh(false);
      });
      body.appendChild(hlSec.card);

      var ctxSec = createCard('תפריט מקש ימני וסרגל כלים');
      addSwitchRow(
        ctxSec.body,
        'תת־תפריט מלא לכל הערה (קריאה ישירה במקש ימני)',
        'בעת ריחוף על הערה בתפריט "הצג הערות קהילה" ייפתח תת־תפריט עם הטקסט המלא של ההערה',
        s.contextMenuFullSubmenus !== false,
        false,
        async function (v) {
          s.contextMenuFullSubmenus = v;
          await saveAndRefresh(false);
          if (CN.menus && CN.menus.syncMenusForSection) {
            CN.menus.syncMenusForSection({
              notes: CN.state.sectionNotes || [],
              selectedText: (CN.state.context && CN.state.context.anchor && CN.state.context.anchor.quote) || '',
              permissions: CN.state.permissions,
              settings: s,
            });
          }
        }
      );
      addSegmentedRow(
        ctxSec.body,
        'כמות הערות בתפריט הראשי',
        'הערות מעבר למספר זה עוברות לתת־תפריט "הערות נוספות בקטע"',
        String(s.contextMenuMaxNotes || 12),
        [['8', '8 הערות'], ['12', '12 הערות'], ['20', '20 הערות']],
        async function (v) {
          s.contextMenuMaxNotes = Number(v);
          await saveAndRefresh(false);
          if (CN.menus && CN.menus.syncMenusForSection) {
            CN.menus.syncMenusForSection({
              notes: CN.state.sectionNotes || [],
              selectedText: (CN.state.context && CN.state.context.anchor && CN.state.context.anchor.quote) || '',
              permissions: CN.state.permissions,
              settings: s,
            });
          }
        }
      );
      body.appendChild(ctxSec.card);

      var pFiltSec = createCard('סינון והסתרה מקומית');
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
      pFiltSec.body.appendChild(el('div', { className: 'settings-row stacked' }, [
        el('div', { className: 'settings-row-title', text: 'מילים להסתרה (מקומי בלבד)' }),
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
      pFiltSec.body.appendChild(el('div', { className: 'settings-row stacked' }, [
        el('div', { className: 'settings-row-title', text: 'כותבים חסומים (מקומי)' }),
        (s.blockedAuthors && s.blockedAuthors.length > 0)
          ? blkChips
          : el('div', { className: 'settings-row-subtitle', text: 'אין כותבים חסומים' }),
      ]));
      body.appendChild(pFiltSec.card);
    }

    // ── TAB 3: Sync Frequency, Daily Study & Cache ──────────────────────────
    else if (activeTab === 'sync') {
      body.appendChild(el('div', {
        className: 'settings-tab-intro',
        text: 'כל פתיחת ספר או מעבר קטע טוען מיידית מהזיכרון ומתעדכן מהשרת. כאן ניתן לקבוע כל כמה דקות הקטע הפתוח מתרענן אוטומטית מהשרת, ולהפעיל סנכרון מועדף לספרי הלימוד היומי.',
      }));

      var freqSec = createCard('תדירות התעדכנות אוטומטית מהשרת');
      addSegmentedRow(
        freqSec.body,
        'רענון אוטומטי בספר רגיל (בחזית)',
        'כל כמה דקות לבדוק הערות ותשובות חדשות מהקהילה בדף הפתוח',
        String(s.sectionRefreshMin !== undefined ? s.sectionRefreshMin : 3),
        [['1', 'כל דקה'], ['3', 'כל 3 דק׳'], ['5', 'כל 5 דק׳'], ['0', 'במעבר קטע בלבד']],
        async function (v) { s.sectionRefreshMin = Number(v); await saveAndRefresh(false); }
      );
      addSegmentedRow(
        freqSec.body,
        'רענון מואץ בספרי לימוד יומי / מועדפים',
        'תדירות גבוהה יותר בספרים עם תנועה ערה של לומדים',
        String(s.priorityRefreshMin !== undefined ? s.priorityRefreshMin : 1),
        [['1', 'כל דקה'], ['2', 'כל 2 דק׳'], ['0', 'כתדירות רגילה']],
        async function (v) { s.priorityRefreshMin = Number(v); await saveAndRefresh(false); }
      );
      body.appendChild(freqSec.card);

      var dailySec = createCard('ספרי הלימוד היומי — סנכרון וטעינה מוקדמת');
      if (!hasCalPerm) {
        dailySec.body.appendChild(el('div', {
          className: 'settings-row',
          text: 'הערה: לזיהוי אוטומטי של הדף היומי והפרשה מהלוח העברי מומלץ לאשר הרשאת לוח שנה (calendar.read) בהגדרות אוצריא.',
        }));
      }
      addSwitchRow(
        dailySec.body,
        'טעינה מוקדמת מועדפת לספרי הלימוד היומי',
        'מזהה את לימוד היום לפי הלוח העברי ומוריד מראש הערות פעילות לזיכרון המקומי',
        s.dailyStudySyncEnabled !== false,
        false,
        async function (v) { s.dailyStudySyncEnabled = v; await saveAndRefresh(false); }
      );

      var tracksGroup = el('div', { className: 'chip-group' });
      [
        ['dafYomi', 'דף יומי (בבלי)'],
        ['parasha', 'פרשת השבוע'],
        ['mishnaYomit', 'משנה יומית'],
        ['rambam', 'רמב"ם יומי'],
      ].forEach(function (pair) {
        var tracks = s.dailyStudyTracks || {};
        var isOn = pair[0] === 'rambam' ? (tracks[pair[0]] === true) : (tracks[pair[0]] !== false);
        tracksGroup.appendChild(el('button', {
          type: 'button',
          className: 'chip-btn' + (isOn ? ' active' : ''),
          text: pair[1],
          onClick: async function () {
            s.dailyStudyTracks = s.dailyStudyTracks || {};
            s.dailyStudyTracks[pair[0]] = !isOn;
            await saveAndRefresh(false);
            renderSettingsPanel();
          },
        }));
      });
      dailySec.body.appendChild(el('div', { className: 'settings-row stacked' }, [
        el('div', { className: 'settings-row-title', text: 'סדרי לימוד למעקב יומי' }),
        tracksGroup,
      ]));

      addSegmentedRow(
        dailySec.body,
        'תדירות הורדה מוקדמת ברקע לספרים מועדפים',
        '',
        String(s.prioritySyncIntervalMin || 15),
        [['15', 'כל 15 דק׳'], ['30', 'כל 30 דק׳'], ['60', 'כל שעה']],
        async function (v) { s.prioritySyncIntervalMin = Number(v); await saveAndRefresh(false); }
      );

      var syncMeta = (CN.sync && CN.sync.getCachedSyncMeta) ? await CN.sync.getCachedSyncMeta() : null;
      var statusText = (syncMeta && syncMeta.syncedAt)
        ? ('סנכרון אחרון: ' + CN.ui.formatRelativeTime(syncMeta.syncedAt) +
           ' · ' + Number(syncMeta.booksSynced || 0) + ' ספרים, ' + Number(syncMeta.sectionsCached || 0) + ' קטעים נטענו' +
           (syncMeta.targets && syncMeta.targets.length > 0 ? (' (' + syncMeta.targets.map(function (t) { return t.label; }).slice(0, 4).join(', ') + ')') : ''))
        : 'טרם בוצע סנכרון לימוד יומי ידני או אוטומטי.';

      dailySec.body.appendChild(el('div', { className: 'settings-row stacked' }, [
        el('div', { className: 'settings-sync-meta', text: statusText }),
        el('div', { className: 'card-actions-group' }, [
          el('button', {
            type: 'button',
            className: 'btn-primary',
            disabled: prioritySyncRunning,
            text: prioritySyncRunning ? 'מסנכרן...' : 'סנכרן לימוד יומי וספרים מועדפים כעת',
            onClick: async function () {
              if (!CN.sync || prioritySyncRunning) return;
              prioritySyncRunning = true;
              renderSettingsPanel();
              try {
                var metaRes = await CN.sync.syncPriorityBooksIfDue({
                  force: true,
                  settings: s,
                  identity: CN.state.identity,
                  permissions: perms,
                });
                if (metaRes && Array.isArray(metaRes.targets)) {
                  CN.state.dailyTargets = metaRes.targets;
                }
                CN.ui.showToast('הסנכרון הושלם (' + Number((metaRes && metaRes.sectionsCached) || 0) + ' קטעים עודכנו)');
              } finally {
                prioritySyncRunning = false;
                CN.app.refreshCurrentScreen();
                renderSettingsPanel();
              }
            },
          }),
        ]),
      ]));
      body.appendChild(dailySec.card);

      var favSec = createCard('ספרים מועדפים נוספים לסנכרון מהיר');
      var favInput = el('input', { className: 'input', type: 'text', placeholder: 'שם ספר מועדף (למשל: שולחן ערוך אורח חיים)...' });
      var currentBookTitle = (CN.state.context && (CN.state.context.titleHint || CN.state.context.bookId)) || '';
      var favChips = el('div', { className: 'chip-group' });
      (s.priorityBooks || []).forEach(function (bTitle) {
        favChips.appendChild(el('button', {
          type: 'button',
          className: 'chip-btn active',
          text: bTitle + ' ×',
          onClick: async function () {
            s.priorityBooks = s.priorityBooks.filter(function (x) { return x !== bTitle; });
            await saveAndRefresh(false);
            renderSettingsPanel();
          },
        }));
      });
      var favActions = [
        favInput,
        el('button', {
          type: 'button',
          className: 'btn-secondary',
          text: 'הוסף ספר',
          onClick: async function () {
            var val = favInput.value.trim();
            if (val && s.priorityBooks.indexOf(val) === -1) {
              s.priorityBooks.push(val);
              await saveAndRefresh(false);
              renderSettingsPanel();
            }
          },
        }),
      ];
      if (currentBookTitle && (s.priorityBooks || []).indexOf(currentBookTitle) === -1) {
        favActions.push(el('button', {
          type: 'button',
          className: 'btn-secondary',
          text: '+ הוסף ספר נוכחי (' + currentBookTitle.slice(0, 20) + ')',
          onClick: async function () {
            s.priorityBooks.push(currentBookTitle);
            await saveAndRefresh(false);
            renderSettingsPanel();
          },
        }));
      }
      favSec.body.appendChild(el('div', { className: 'settings-row stacked' }, [
        el('div', { className: 'settings-row-title', text: 'ספרים שיתעדכנו בקדימות גבוהה ויוחזקו במטמון המקומי' }),
        el('div', { className: 'card-actions-group' }, favActions),
        (s.priorityBooks && s.priorityBooks.length > 0)
          ? favChips
          : el('div', { className: 'settings-row-subtitle', text: 'אין ספרים מועדפים מותאמים אישית' }),
      ]));
      body.appendChild(favSec.card);

      var cacheSec = createCard('מטמון מקומי ונתונים שמורים');
      var secCacheObj = CN.storage.loadSectionCache ? await CN.storage.loadSectionCache() : { order: [] };
      var cachedCount = Array.isArray(secCacheObj.order) ? secCacheObj.order.length : 0;
      var effectiveMax = CN.storage.getEffectiveCacheLimit ? CN.storage.getEffectiveCacheLimit() : (Number(s.maxCachedLocations) || CN.config.MAX_CACHED_LOCATIONS);
      addSegmentedRow(
        cacheSec.body,
        'תקרת קטעים שמורים בזיכרון המקומי (אופליין)',
        'כל "קטע שמור" הוא רשימת ההערות של דף/פרק ספר אחד שפתחת או סונכרן מראש. התקרה מונעת מקובץ ה־JSON המקומי להתנפח ולהאט טעינה לאורך שנים',
        String(Number(s.maxCachedLocations) >= 1000 ? s.maxCachedLocations : CN.config.MAX_CACHED_LOCATIONS),
        [['1000', '1,000 קטעים'], ['2000', '2,000 (ברירת מחדל)'], ['5000', '5,000 קטעים']],
        async function (v) { s.maxCachedLocations = Number(v); await saveAndRefresh(false); }
      );
      cacheSec.body.appendChild(el('div', { className: 'settings-row' }, [
        el('div', {}, [
          el('div', { className: 'settings-row-title', text: 'איפוס מטמון מקומי (' + cachedCount + ' / ' + effectiveMax + ' קטעים שמורים כעת)' }),
          el('div', { className: 'settings-row-subtitle', text: 'מנקה את רשימות ההערות השמורות לצפייה אופליין. הטיוטות האישיות נשארות' }),
        ]),
        el('button', {
          type: 'button',
          className: 'btn-secondary',
          text: 'נקה מטמון',
          onClick: async function () {
            await CN.storage.clearSectionCache();
            CN.ui.showToast('המטמון המקומי נוקה');
            renderSettingsPanel();
          },
        }),
      ]));
      body.appendChild(cacheSec.card);
    }

    // ── TAB 4: Notifications ────────────────────────────────────────────────
    else if (activeTab === 'notifications') {
      var chSec = createCard('התראות אישיות ותדירות בדיקה');
      addSwitchRow(chSec.body, 'התראות בתוך אוצריא', 'מציג התראה בתוך התוכנה כשמתקבלת תגובה, תשובה לשאלה או הודעת מודרציה בתיבה שלך', s.inAppNotifications !== false, false, async function (v) {
        s.inAppNotifications = v; await saveAndRefresh(false);
      });
      addSwitchRow(
        chSec.body,
        'התראת מערכת (Windows / OS)',
        hasSysNotifPerm ? 'פועל כשאוצריא פתוחה' : 'כבוי כי הרשאת התראות מערכת אינה מאושרת בהגדרות אוצריא',
        Boolean(s.systemNotifications && hasSysNotifPerm),
        !hasSysNotifPerm,
        async function (v) { s.systemNotifications = v; await saveAndRefresh(false); }
      );
      addSegmentedRow(
        chSec.body,
        'בדיקת תיבת ההודעות האישית ברקע',
        hasBgPerm
          ? 'בודק מול שרת הקהילה אם יש הודעות אישיות חדשות (תגובה להערה שלך, תשובה לשאלתך או החלטת צוות) בעליית אוצריא ובמעבר בין קטעים. פעיל רק כשמחוברים לחשבון'
          : 'דורש הרשאת ריצת רקע (app.run_on_startup) · בודק הודעות ותגובות אישיות משרת הקהילה',
        String(s.bgCheckFrequencyMin),
        [['30', 'כל 30 דקות'], ['60', 'כל שעה'], ['0', 'רק בעליית אוצריא']],
        async function (v) {
          if (!hasBgPerm) return;
          s.bgCheckFrequencyMin = Number(v);
          await saveAndRefresh(false);
        }
      );
      chSec.body.appendChild(el('div', { className: 'settings-row' }, [
        el('div', {}, [
          el('div', { className: 'settings-row-title', text: 'השתקה אוטומטית בשבת וביום טוב' }),
          el('div', {
            className: 'settings-row-subtitle',
            text: 'מופעל תמיד אוטומטית ללא הגדרה: לא מוצגות התראות בשבתות ובמועדי יום טוב (בחול המועד, איסרו חג, חנוכה ופורים ההתראות פעילות כרגיל).' +
              (!hasCalPerm ? ' לזיהוי מדויק של חגי ישראל ומוצאי שבת מומלץ לאשר הרשאת לוח שנה (calendar.read).' : ''),
          }),
        ]),
        el('span', { className: 'tag primary', text: 'פעיל תמיד' }),
      ]));
      body.appendChild(chSec.card);

      var tpSec = createCard('סינון סוגי התראות');
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
      tpSec.body.appendChild(el('div', { className: 'settings-row stacked' }, [
        el('div', { className: 'settings-row-title', text: 'אילו עדכונים ישלחו התראה?' }),
        ntGroup,
      ]));
      body.appendChild(tpSec.card);
    }

    // ── TAB 5: Account, Backup, Importer, Server & Permissions ──────────────
    else if (activeTab === 'account') {
      var accSec = createCard('חשבון, זהות וגיבוי');
      if (CN.state.identity && CN.state.identity.userId) {
        var renameInput = el('input', { className: 'input', type: 'text', value: CN.state.identity.displayName });
        accSec.body.appendChild(el('div', { className: 'settings-row stacked' }, [
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
                  renderSettingsPanel();
                } else {
                  CN.ui.showToast((res.data && res.data.error && res.data.error.message) || 'לא ניתן לעדכן שם');
                }
              },
            }),
          ]),
        ]));

        accSec.body.appendChild(el('div', { className: 'settings-row' }, [
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

        accSec.body.appendChild(el('div', { className: 'settings-row' }, [
          el('div', { className: 'settings-row-title', text: 'ייצוא הנתונים שלי (JSON)' }),
          el('button', {
            type: 'button',
            className: 'btn-secondary',
            text: 'ייצא',
            onClick: exportMyData,
          }),
        ]));

        accSec.body.appendChild(el('div', { className: 'settings-row' }, [
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

        accSec.body.appendChild(el('div', { className: 'settings-row' }, [
          el('div', { className: 'settings-row-title', text: 'מחיקת חשבון' }),
          el('button', {
            type: 'button',
            className: 'action-btn danger',
            text: 'מחק חשבון',
            onClick: confirmDeleteAccount,
          }),
        ]));
      } else {
        accSec.body.appendChild(el('div', { className: 'settings-row' }, [
          el('div', {}, [
            el('div', { className: 'settings-row-title', text: 'ייבוא זהות ממכשיר אחר' }),
            el('div', { className: 'settings-row-subtitle', text: 'כבר נרשמת בעבר? הזן את קוד השחזור כדי לשחזר את חשבונך' }),
          ]),
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
      body.appendChild(accSec.card);

      var toolsSec = createCard('ייבוא, קיצורי מקשים ושרת הקהילה');
      toolsSec.body.appendChild(el('div', { className: 'settings-row' }, [
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

      toolsSec.body.appendChild(el('div', { className: 'settings-row' }, [
        el('div', {}, [
          el('div', { className: 'settings-row-title', text: 'קיצור מקלדת להוספת הערה' }),
          el('div', { className: 'settings-row-subtitle', text: 'ברירת מחדל: Ctrl+Alt+N. לשינוי: הגדרות ← קיצורי מקשים ← קיצורי תוספים באוצריא' }),
        ]),
      ]));

      var srvInput = el('input', {
        className: 'input',
        type: 'url',
        dir: 'ltr',
        value: s.apiBaseUrl || '',
        placeholder: CN.config.DEFAULT_API_BASE,
      });
      toolsSec.body.appendChild(el('div', { className: 'settings-row stacked' }, [
        el('div', {}, [
          el('div', { className: 'settings-row-title', text: 'כתובת שרת הקהילה (מתקדם)' }),
          el('div', { className: 'settings-row-subtitle', text: 'השאר ריק לעבודה מול שרת הקהילה הרשמי: ' + CN.config.DEFAULT_API_BASE }),
        ]),
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
              renderSettingsPanel();
            },
          }),
          el('button', {
            type: 'button',
            className: 'btn-secondary',
            text: 'איפוס לברירת מחדל',
            onClick: async function () {
              srvInput.value = '';
              s.apiBaseUrl = '';
              await saveAndRefresh(false);
              CN.ui.showToast('אופס לשרת הרשמי');
              renderSettingsPanel();
            },
          }),
        ]),
      ]));
      body.appendChild(toolsSec.card);

      var permSec = createCard('מצב הרשאות (לקריאה בלבד)');
      [
        ['app.run_on_startup', 'ריצת רקע', 'מאפשרת בדיקת התראות תקופתית, סנכרון לימוד יומי וסימון בטקסט בפתיחת ספרים'],
        ['notifications.system', 'התראות מערכת', 'מאפשרת התראות של מערכת ההפעלה כשאוצריא פתוחה'],
        ['reader.highlight', 'סימון בטקסט', 'מאפשרת הדגשת ציטוטים בטור הטקסט הראשי וכפתור "הצג בטקסט"'],
        ['calendar.read', 'לוח שנה עברי', 'מאפשרת זיהוי אוטומטי של הדף היומי, פרשת השבוע, שבת ומועדים'],
      ].forEach(function (item) {
        var granted = perms.indexOf(item[0]) !== -1;
        permSec.body.appendChild(el('div', { className: 'settings-row' }, [
          el('div', {}, [
            el('div', { className: 'settings-row-title', text: item[1] }),
            el('div', { className: 'settings-row-subtitle', text: item[2] }),
          ]),
          el('span', { className: 'tag ' + (granted ? 'primary' : ''), text: granted ? 'מופעל' : 'כבוי' }),
        ]));
      });
      permSec.body.appendChild(el('div', { className: 'settings-row' }, [
        el('div', {
          className: 'settings-row-subtitle',
          text: 'לשינוי הרשאות: הגדרות ← כלים ← תוספים מותקנים באוצריא.',
        }),
      ]));
      body.appendChild(permSec.card);
    }
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
