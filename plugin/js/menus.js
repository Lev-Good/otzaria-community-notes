(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  var DEFAULT_MAX_MENU_NOTES = 12;
  var MAX_LABEL_CHARS = 78;
  var MAX_LINE_CHARS = 66;
  var MAX_LINES_PER_NOTE = 28;

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

  /**
   * Wraps full note body into readable menu lines so cascaded submenus can
   * present the entire note without truncating or overflowing horizontally.
   */
  function wrapMenuLines(text, maxChars, maxLines) {
    var limitChars = maxChars || MAX_LINE_CHARS;
    var limitLines = maxLines || MAX_LINES_PER_NOTE;
    var paragraphs = String(text || '').replace(/\r\n/g, '\n').split('\n');
    var lines = [];

    for (var p = 0; p < paragraphs.length; p++) {
      var para = paragraphs[p].replace(/\s+/g, ' ').trim();
      if (!para) continue;
      var words = para.split(' ');
      var cur = '';
      for (var w = 0; w < words.length; w++) {
        var word = words[w];
        if (!cur) {
          if (word.length > limitChars) {
            while (word.length > limitChars) {
              lines.push(word.slice(0, limitChars));
              word = word.slice(limitChars);
              if (lines.length >= limitLines) break;
            }
          }
          cur = word;
        } else if (cur.length + 1 + word.length <= limitChars) {
          cur += ' ' + word;
        } else {
          lines.push(cur);
          cur = word;
        }
        if (lines.length >= limitLines) break;
      }
      if (cur && lines.length < limitLines) lines.push(cur);
      if (lines.length >= limitLines) break;
    }

    if (lines.length >= limitLines && String(text || '').length > lines.join(' ').length + 8) {
      lines[lines.length - 1] = lines[lines.length - 1].slice(0, Math.max(0, limitChars - 20)) + '… (המשך בשרשור)';
    }
    return lines;
  }

  function buildPreviewItems(notes, selectedText, maxPrimary) {
    var cap = Number(maxPrimary) || DEFAULT_MAX_MENU_NOTES;
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

    var ordered = matched.concat(rest);
    function mapEntry(entry) {
      return {
        note: entry.note,
        matched: entry.matched,
        label: formatMenuPreviewLine(entry.note, entry.matched),
      };
    }

    var primary = ordered.slice(0, cap).map(mapEntry);
    var overflow = ordered.slice(cap).map(mapEntry);

    return {
      totalCount: publicNotes.length,
      matchedCount: matched.length,
      items: primary,
      overflowItems: overflow,
    };
  }

  function buildFlatNoteItem(entry, idPrefix) {
    var n = entry.note;
    return {
      id: (idPrefix || 'cn-note-') + n.id,
      type: 'item',
      title: entry.label,
      icon: n.kind === 'question' ? 'comment_24_regular' : 'comment_note_24_regular',
      openPlugin: true,
      param: {
        action: 'open-thread',
        rootId: n.id,
        noteId: n.id,
        quote: n.quote || '',
      },
    };
  }

  function buildFullNoteSubmenu(entry) {
    var n = entry.note;
    var author = String(n.authorName || 'לומד').replace(/\s+/g, ' ').trim();
    var votes = Number(n.upCount || 0);
    var kindLabel = n.kind === 'question'
      ? (n.questionStatus === 'answered' ? '❓ שאלה (נענתה)' : '❓ שאלה פתוחה')
      : (n.tier === 'recommended' ? '★ הערה מומלצת' : '💬 הערה');
    var metaHeader = kindLabel + ' · ' + author + (votes > 0 ? (' · 👍 ' + votes) : '');
    var threadParam = {
      action: 'open-thread',
      rootId: n.id,
      noteId: n.id,
      quote: n.quote || '',
    };

    var children = [
      {
        id: 'cn-n-' + n.id + '-meta',
        type: 'item',
        title: metaHeader,
        openPlugin: true,
        param: threadParam,
      },
    ];

    if (n.quote) {
      var cleanQ = String(n.quote).replace(/\s+/g, ' ').trim();
      if (cleanQ.length > 56) cleanQ = cleanQ.slice(0, 53) + '...';
      children.push({
        id: 'cn-n-' + n.id + '-quote',
        type: 'item',
        title: '📖 על: "' + cleanQ + '"',
        openPlugin: true,
        param: threadParam,
      });
    }

    children.push({ id: 'cn-n-' + n.id + '-sep1', type: 'separator' });

    var bodyLines = wrapMenuLines(n.body, MAX_LINE_CHARS, MAX_LINES_PER_NOTE);
    for (var i = 0; i < bodyLines.length; i++) {
      children.push({
        id: 'cn-n-' + n.id + '-ln-' + i,
        type: 'item',
        title: bodyLines[i],
        openPlugin: true,
        param: threadParam,
      });
    }

    children.push({ id: 'cn-n-' + n.id + '-sep2', type: 'separator' });

    var totalReplies = Number(n.replyCount || 0) + Number(n.answerCount || 0);
    children.push({
      id: 'cn-n-' + n.id + '-open-thread',
      type: 'item',
      title: '💬 פתח שרשור והשב' + (totalReplies > 0 ? (' (' + totalReplies + ')') : ''),
      icon: 'comment_24_regular',
      openPlugin: true,
      param: threadParam,
    });
    children.push({
      id: 'cn-n-' + n.id + '-open-all',
      type: 'item',
      title: '📖 הצג בחלונית הספר והערות הקטע',
      icon: 'comment_note_24_regular',
      openPlugin: true,
      param: { action: 'open-all', quote: n.quote || '' },
    });

    return {
      id: 'cn-note-' + n.id,
      type: 'submenu',
      title: entry.label,
      icon: n.kind === 'question' ? 'comment_24_regular' : 'comment_note_24_regular',
      children: children,
      param: threadParam,
    };
  }

  function buildContextChildren(entries, useFullSubmenus, idPrefix) {
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      out.push(useFullSubmenus ? buildFullNoteSubmenu(entries[i]) : buildFlatNoteItem(entries[i], idPrefix));
    }
    return out;
  }

  async function registerContextMenuSafe(itemPayload, flatFallbackPayload) {
    try {
      await global.Otzaria.call('reader.addContextMenuItem', itemPayload);
      return true;
    } catch (_) {
      // Fallback 1: Otzaria < 0.9.98.1 where 'reader-book' context is unsupported
      try {
        var fallbackContexts = Object.assign({}, itemPayload, {
          contexts: ['reader-selection', 'reader-highlight'],
        });
        await global.Otzaria.call('reader.addContextMenuItem', fallbackContexts);
        return true;
      } catch (_e) {
        // Fallback 2: Flat item list if host rejects deeply nested submenus
        if (flatFallbackPayload) {
          try {
            await global.Otzaria.call('reader.addContextMenuItem', flatFallbackPayload);
            return true;
          } catch (_e2) {
            try {
              var flatCtxFallback = Object.assign({}, flatFallbackPayload, {
                contexts: ['reader-selection', 'reader-highlight'],
              });
              await global.Otzaria.call('reader.addContextMenuItem', flatCtxFallback);
              return true;
            } catch (_e3) {
              return false;
            }
          }
        }
        return false;
      }
    }
  }

  async function syncMenusForSection({ notes, selectedText, permissions, settings } = {}) {
    var perms = Array.isArray(permissions) ? permissions : (CN.state && CN.state.permissions) || [];
    var s = settings || (CN.state && CN.state.settings) || {};
    var hasCtx = perms.indexOf('reader.context_menu') !== -1;
    var hasToolbar = perms.indexOf('reader.toolbar') !== -1;
    if (!hasCtx && !hasToolbar) return;

    var maxNotes = Number(s.contextMenuMaxNotes) || DEFAULT_MAX_MENU_NOTES;
    var useFullSubmenus = s.contextMenuFullSubmenus !== false;
    var built = buildPreviewItems(notes, selectedText || '', maxNotes);

    if (hasCtx) {
      if (built.items.length > 0) {
        var submenuTitle = built.matchedCount > 0
          ? ('הצג הערות קהילה (' + built.matchedCount + ' על הבחירה / ' + built.totalCount + ' בקטע)')
          : ('הצג הערות קהילה (' + built.totalCount + ')');

        var headerItems = [
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

        var primaryFull = headerItems.concat(buildContextChildren(built.items, useFullSubmenus, 'cn-note-'));
        if (built.overflowItems.length > 0) {
          var extraBatch = built.overflowItems.slice(0, 15);
          primaryFull.push({ id: 'cn-ctx-sep-more', type: 'separator' });
          primaryFull.push({
            id: 'cn-note-more',
            type: 'submenu',
            title: '📚 הערות נוספות בקטע (' + built.overflowItems.length + ')',
            icon: 'comment_note_24_regular',
            children: buildContextChildren(extraBatch, useFullSubmenus, 'cn-more-note-').concat([
              { id: 'cn-more-sep', type: 'separator' },
              {
                id: 'cn-more-open-all',
                type: 'item',
                title: 'פתח את כל ' + built.totalCount + ' ההערות בחלונית המפוצלת',
                openPlugin: true,
                param: { action: 'open-all' },
              },
            ]),
          });
        }

        var flatChildren = headerItems.concat(buildContextChildren(built.items, false, 'cn-note-'));

        await registerContextMenuSafe(
          {
            id: 'show-notes',
            type: 'submenu',
            title: submenuTitle,
            icon: 'comment_note_24_regular',
            contexts: ['reader-selection', 'reader-highlight', 'reader-book'],
            children: primaryFull,
          },
          useFullSubmenus ? {
            id: 'show-notes',
            type: 'submenu',
            title: submenuTitle,
            icon: 'comment_note_24_regular',
            contexts: ['reader-selection', 'reader-highlight', 'reader-book'],
            children: flatChildren,
          } : null
        );
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
    wrapMenuLines: wrapMenuLines,
    syncMenusForSection: syncMenusForSection,
  };
})(typeof window !== 'undefined' ? window : globalThis);
