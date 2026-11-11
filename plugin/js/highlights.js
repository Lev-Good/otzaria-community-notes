(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  var activeHighlightIds = [];

  function hexWithAlpha(hex, alphaFloat) {
    var clean = String(hex || '#6750A4').replace('#', '');
    if (clean.length === 3) {
      clean = clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2];
    }
    clean = clean.slice(0, 6);
    var a = Math.max(0, Math.min(255, Math.round(alphaFloat * 255))).toString(16).padStart(2, '0');
    return '#' + clean + a;
  }

  async function canHighlightHere() {
    try {
      var res = await global.Otzaria.call('reader.getHighlightCapabilities');
      return Boolean(res && res.success && res.data && res.data.highlights === true);
    } catch (_) {
      return false;
    }
  }

  async function clearPluginHighlights() {
    try {
      await global.Otzaria.call('reader.clearAllHighlights');
      activeHighlightIds = [];
    } catch (_) {
      for (var i = 0; i < activeHighlightIds.length; i++) {
        try {
          await global.Otzaria.call('reader.clearHighlight', { highlightId: activeHighlightIds[i] });
        } catch (_e) { /* ignore */ }
      }
      activeHighlightIds = [];
    }
  }

  /**
   * Render highlights onto the main reader column for a section's notes.
   */
  async function syncSectionHighlights({ notes, bookId, bookUid, theme, settings }) {
    if (!settings || !settings.highlightEnabled) {
      await clearPluginHighlights();
      return [];
    }
    var supported = await canHighlightHere();
    if (!supported) return [];

    await clearPluginHighlights();
    var primaryHex = (theme && theme.colorScheme && theme.colorScheme.primary) || '#6750A4';
    var tertiaryHex = (theme && theme.colorScheme && theme.colorScheme.tertiary) || '#7D5260';
    var opacity = settings.highlightIntensity === 'normal' ? 0.28 : 0.16;

    var applied = [];
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (!n.quote) continue;
      if (settings.highlightRecommendedOnly && n.tier !== 'recommended') continue;
      var loc = n._anchor || (await CN.anchors.locateNoteAnchor(n, bookId));
      if (!loc || !loc.found || !loc.range) continue;

      var isOpenQuestion = n.kind === 'question' && n.questionStatus === 'open';
      var baseColor = (isOpenQuestion && settings.highlightSeparateQuestions) ? tertiaryHex : primaryHex;
      var bg = hexWithAlpha(baseColor, opacity);
      var hlId = 'cn:' + n.id;

      try {
        await global.Otzaria.call('reader.setHighlight', {
          highlightId: hlId,
          bookId: bookId,
          bookUid: bookUid || undefined,
          sectionIndex: loc.sectionIndex,
          range: loc.range,
          style: {
            backgroundColor: bg,
            underline: true,
            underlineColor: baseColor,
            borderRadius: 3,
            priority: isOpenQuestion ? 20 : 10,
          },
          metadata: {
            source: 'sync',
            tags: [n.kind === 'question' ? 'question' : 'note'],
            note: n.body.slice(0, 80),
          },
        });
        activeHighlightIds.push(hlId);
        applied.push({ noteId: n.id, highlightId: hlId, sectionIndex: loc.sectionIndex });
      } catch (_) {
        // Ignore individual highlight failure
      }
    }
    return applied;
  }

  /**
   * Temporary highlight + reveal when user clicks "הצג בטקסט".
   */
  async function revealNoteInBook({ note, bookId, bookUid, theme, returnToReader }) {
    var loc = await CN.anchors.locateNoteAnchor(note, bookId);
    if (loc && loc.found && loc.range) {
      var primaryHex = (theme && theme.colorScheme && theme.colorScheme.primary) || '#6750A4';
      var hlId = 'cn:reveal:' + note.id;
      try {
        await global.Otzaria.call('reader.setHighlight', {
          highlightId: hlId,
          bookId: bookId,
          bookUid: bookUid || undefined,
          sectionIndex: loc.sectionIndex,
          range: loc.range,
          style: {
            backgroundColor: hexWithAlpha(primaryHex, 0.34),
            underline: true,
            underlineColor: primaryHex,
            borderRadius: 3,
            priority: 40,
          },
          metadata: { source: 'manual', tags: ['reveal'] },
        });
        await global.Otzaria.call('reader.revealHighlight', { highlightId: hlId });
      } catch (_) {
        await global.Otzaria.call('reader.openBookAtRef', {
          bookId: bookId,
          bookUid: bookUid || undefined,
          ref: note.ref,
          index: note.sectionHint,
          highlight: true,
        });
      }
    } else {
      await global.Otzaria.call('reader.openBookAtRef', {
        bookId: bookId,
        bookUid: bookUid || undefined,
        ref: note.ref,
        index: note.sectionHint,
        highlight: true,
      });
    }

    if (returnToReader) {
      await returnToBookTab(bookUid, bookId);
    }
  }

  async function returnToBookTab(bookUid, bookId) {
    try {
      var stateRes = await global.Otzaria.call('reader.getCurrentState');
      var tabs = (stateRes && stateRes.success && stateRes.data && stateRes.data.openTabs) || [];
      for (var i = 0; i < tabs.length; i++) {
        var tab = tabs[i];
        if (tab.isSelf) continue;
        if ((bookUid && tab.bookUid === bookUid) || (bookId && tab.bookId === bookId)) {
          await global.Otzaria.call('reader.activateTab', { index: i });
          return true;
        }
      }
    } catch (_) {
      // ignore
    }
    return false;
  }

  CN.highlights = {
    canHighlightHere: canHighlightHere,
    clearPluginHighlights: clearPluginHighlights,
    syncSectionHighlights: syncSectionHighlights,
    revealNoteInBook: revealNoteInBook,
    returnToBookTab: returnToBookTab,
  };
})(typeof window !== 'undefined' ? window : globalThis);
