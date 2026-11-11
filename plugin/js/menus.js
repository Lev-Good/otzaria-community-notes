(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  var MAX_MENU_NOTES = 12;
  var MAX_LABEL_CHARS = 78;

  function normalizeSimple(str) {
    return String(str || '')
      .replace(/[\u0591-\u05C7\u2060]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function noteMatchesSelection(note, selectedText) {
    if (!note || !note.quote || !selectedText) return false;
    var qNorm = normalizeSimple(note.quote);
    var sNorm = normalizeSimple(selectedText);
    if (!qNorm || !sNorm) return false;
    return qNorm.indexOf(sNorm) !== -1 || sNorm.indexOf(qNorm) !== -1;
  }

  function formatMenuPreviewLine(note, isMatched) {
    var iconPrefix = note.kind === 'question' ? '❓ ' : (note.tier === 'recommended' || isMatched ? '★ ' : '💬 ');
    var author = String(note.authorName || 'לומד').replace(/\s+/g, ' ').trim();
    if (author.length > 14) author = author.slice(0, 13) + '…';
    var body = String(note.body || '').replace(/\s+/g, ' ').trim();
    var line = iconPrefix + author + ': ' + body;
    if (line.length > MAX_LABEL_CHARS) {
      line = line.slice(0, MAX_LABEL_CHARS - 3) + '...';
    }
    return line;
  }

  function buildPreviewItems(notes, selectedText) {
    var list = Array.isArray(notes) ? notes.slice() : [];
    var publicNotes = list.filter(function (n) {
      return n && n.status === 'published' && n.tier !== 'low';
    });

    var matched = [];
    var rest = [];
    for (var i = 0; i < publicNotes.length; i++) {
      var n = publicNotes[i];
      if (selectedText && noteMatchesSelection(n, selectedText)) {
        matched.push({ note: n, matched: true });
      } else {
        rest.push({ note: n, matched: false });
      }
    }

    var tierRank = { recommended: 0, new: 1, normal: 2, low: 3 };
    function sortWrap(a, b) {
      var ra = tierRank[a.note.tier] !== undefined ? tierRank[a.note.tier] : 2;
      var rb = tierRank[b.note.tier] !== undefined ? tierRank[b.note.tier] : 2;
      if (ra !== rb) return ra - rb;
      return (Number(b.note.upCount) || 0) - (Number(a.note.upCount) || 0);
    }
    matched.sort(sortWrap);
    rest.sort(sortWrap);

    var combined = matched.concat(rest).slice(0, MAX_MENU_NOTES);
    return {
      totalCount: publicNotes.length,
      matchedCount: matched.length,
      items: combined.map(function (entry) {
        return {
          note: entry.note,
          matched: entry.matched,
          label: formatMenuPreviewLine(entry.note, entry.matched),
        };
      }),
    };
  }

  async function registerContextMenuSafe(itemPayload) {
    try {
      await global.Otzaria.call('reader.addContextMenuItem', itemPayload);
      return true;
    } catch (_) {
      // Fallback for Otzaria < 0.9.98.1 where 'reader-book' context is unsupported
      try {
        var fallbackPayload = Object.assign({}, itemPayload, {
          contexts: ['reader-selection', 'reader-highlight'],
        });
        await global.Otzaria.call('reader.addContextMenuItem', fallbackPayload);
        return true;
      } catch (_e) {
        return false;
      }
    }
  }

  async function syncMenusForSection({ notes, selectedText, permissions } = {}) {
    var perms = Array.isArray(permissions) ? permissions : (CN.state && CN.state.permissions) || [];
    var hasCtx = perms.indexOf('reader.context_menu') !== -1;
    var hasToolbar = perms.indexOf('reader.toolbar') !== -1;
    if (!hasCtx && !hasToolbar) return;

    var built = buildPreviewItems(notes, selectedText || '');

    if (hasCtx) {
      if (built.items.length > 0) {
        var submenuTitle = built.matchedCount > 0
          ? ('הצג הערות קהילה (' + built.matchedCount + ' על הבחירה / ' + built.totalCount + ' בקטע)')
          : ('הצג הערות קהילה (' + built.totalCount + ')');

        var ctxChildren = [
          {
            id: 'show-notes-open-all',
            type: 'item',
            title: 'פתח את כל ההערות והספר בצד (' + built.totalCount + ')',
            icon: 'comment_note_24_regular',
            openPlugin: true,
            param: { action: 'open-all' },
          },
          { id: 'cn-ctx-sep', type: 'separator' },
        ];

        for (var i = 0; i < built.items.length; i++) {
          var entry = built.items[i];
          ctxChildren.push({
            id: 'cn-note-' + entry.note.id,
            type: 'item',
            title: entry.label,
            icon: entry.note.kind === 'question' ? 'comment_24_regular' : 'comment_note_24_regular',
            openPlugin: true,
            param: {
              action: 'open-thread',
              rootId: entry.note.id,
              noteId: entry.note.id,
              quote: entry.note.quote || '',
            },
          });
        }

        await registerContextMenuSafe({
          id: 'show-notes',
          type: 'submenu',
          title: submenuTitle,
          icon: 'comment_note_24_regular',
          contexts: ['reader-selection', 'reader-highlight', 'reader-book'],
          children: ctxChildren,
        });
      } else {
        await registerContextMenuSafe({
          id: 'show-notes',
          type: 'item',
          title: 'הצג הערות קהילה',
          icon: 'comment_note_24_regular',
          contexts: ['reader-selection', 'reader-highlight', 'reader-book'],
          openPlugin: true,
          param: { action: 'open-all' },
        });
      }
    }

    if (hasToolbar) {
      try {
        if (built.items.length > 0) {
          var tbChildren = [
            {
              id: 'open-notes-all',
              title: 'פתח את כל ההערות והספר בצד (' + built.totalCount + ')',
              icon: 'comment_note_24_regular',
              openPlugin: true,
              param: { action: 'open-all' },
            },
          ];
          for (var j = 0; j < built.items.length; j++) {
            var tbEntry = built.items[j];
            tbChildren.push({
              id: 'cn-tb-note-' + tbEntry.note.id,
              title: tbEntry.label,
              icon: tbEntry.note.kind === 'question' ? 'comment_24_regular' : 'comment_note_24_regular',
              openPlugin: true,
              param: {
                action: 'open-thread',
                rootId: tbEntry.note.id,
                noteId: tbEntry.note.id,
              },
            });
          }

          await global.Otzaria.call('reader.addToolbarItem', {
            id: 'open-notes',
            type: 'split',
            title: 'הערות קהילה (' + built.totalCount + ')',
            icon: 'comment_24_regular',
            contexts: ['reader-text'],
            openPlugin: true,
            children: tbChildren,
          });
        } else {
          await global.Otzaria.call('reader.addToolbarItem', {
            id: 'open-notes',
            type: 'button',
            title: 'הערות קהילה',
            icon: 'comment_24_regular',
            contexts: ['reader-text'],
            openPlugin: true,
          });
        }
      } catch (_) {
        // ignore if unsupported by older host
      }
    }
  }

  CN.menus = {
    buildPreviewItems: buildPreviewItems,
    formatMenuPreviewLine: formatMenuPreviewLine,
    syncMenusForSection: syncMenusForSection,
  };
})(typeof window !== 'undefined' ? window : globalThis);
