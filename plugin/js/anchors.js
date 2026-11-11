(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  var NIKUD_TEAMIM_RE = /[\u0591-\u05C7]/g;

  function stripNikudAndTeamim(str, mode) {
    if (!str) return '';
    if (mode === 'never') {
      return String(str).replace(NIKUD_TEAMIM_RE, '');
    }
    return String(str);
  }

  function normalizeCompare(str) {
    return String(str || '')
      .replace(NIKUD_TEAMIM_RE, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Build anchor object from Otzaria selection payload (or fallback current position).
   */
  function buildAnchorFromSelection(sel, libVersion) {
    if (!sel) {
      return {
        bookUid: '',
        titleHint: '',
        ref: '',
        sectionHint: 0,
        quote: '',
        prefix: '',
        suffix: '',
        occurrence: 0,
        libVersion: libVersion || '',
        multiParagraph: false,
        tooLongTruncated: false,
        sourceRange: null,
      };
    }

    var multiParagraph = Array.isArray(sel.sections) && sel.sections.length > 1;
    var primary = multiParagraph ? sel.sections[0] : sel;
    var srcRange = primary.sourceRange || primary.renderedRange || null;
    var rawText = (srcRange && srcRange.exactText)
      || primary.sourceSelectedText
      || primary.renderedSelectedText
      || primary.text
      || sel.text
      || '';

    var cleaned = String(rawText).replace(/\u2060/g, '').trim();
    var tooLong = cleaned.length > CN.config.MAX_SELECTION_CHARS;
    var quote = cleaned.slice(0, CN.config.MAX_QUOTE_CHARS);

    var prefix = '';
    var suffix = '';
    var occurrence = 0;

    if (srcRange) {
      if (srcRange.beforeText && srcRange.beforeText.raw) {
        prefix = String(srcRange.beforeText.raw).slice(-CN.config.CONTEXT_CHARS);
      }
      if (srcRange.afterText && srcRange.afterText.raw) {
        suffix = String(srcRange.afterText.raw).slice(0, CN.config.CONTEXT_CHARS);
      }
      if (typeof srcRange.occurrenceIndexInSection === 'number') {
        occurrence = srcRange.occurrenceIndexInSection;
      }
    }

    return {
      bookUid: sel.bookUid || primary.bookUid || '',
      titleHint: sel.bookTitle || sel.currentBook || primary.bookTitle || sel.bookId || '',
      ref: primary.currentRef || sel.currentRef || '',
      sectionHint: typeof primary.sectionIndex === 'number'
        ? primary.sectionIndex
        : (typeof sel.sectionIndex === 'number' ? sel.sectionIndex : (sel.currentIndex || 0)),
      quote: quote,
      prefix: prefix,
      suffix: suffix,
      occurrence: occurrence,
      libVersion: libVersion || '',
      multiParagraph: multiParagraph,
      tooLongTruncated: tooLong,
      sourceRange: srcRange,
    };
  }

  function scoreOccurrence(occ, note) {
    var score = 0;
    var range = occ && occ.range ? occ.range : null;
    if (!range) return score;

    var before = normalizeCompare((range.beforeText && range.beforeText.raw) || '');
    var after = normalizeCompare((range.afterText && range.afterText.raw) || '');
    var wantPrefix = normalizeCompare(note.prefix || '');
    var wantSuffix = normalizeCompare(note.suffix || '');

    if (wantPrefix && before && before.endsWith(wantPrefix)) score += 50;
    else if (wantPrefix && before && before.indexOf(wantPrefix.slice(-10)) !== -1) score += 20;

    if (wantSuffix && after && after.startsWith(wantSuffix)) score += 50;
    else if (wantSuffix && after && after.indexOf(wantSuffix.slice(0, 10)) !== -1) score += 20;

    if (typeof range.occurrenceIndexInSection === 'number' && range.occurrenceIndexInSection === Number(note.occurrence || 0)) {
      score += 10;
    }
    return score;
  }

  async function findInSection(bookId, sectionIndex, quote) {
    try {
      var res = await global.Otzaria.call('reader.findTextOccurrences', {
        bookId: bookId,
        sectionIndex: sectionIndex,
        query: quote,
        layer: 'source',
        normalize: { profile: 'search' },
        limit: 50,
      });
      if (res && res.success && res.data && Array.isArray(res.data.results)) {
        return res.data.results;
      }
    } catch (_) {
      // ignore invalid section index out of range
    }
    return [];
  }

  /**
   * Two-stage client-side anchor locator:
   * 1) Try section_hint
   * 2) Search neighboring sections +-1..3
   * 3) Return null range when not found (displays under "מיקום מדויק לא נמצא")
   */
  async function locateNoteAnchor(note, fallbackBookId) {
    if (!note || !note.quote) {
      return { found: false, isSectionNote: true, sectionIndex: Number(note && note.sectionHint) || 0, range: null, startOffset: -1 };
    }
    var bookId = fallbackBookId || note.titleHint || note.bookUid;
    var hint = Number(note.sectionHint || 0);
    var offsetsToTry = [0, -1, 1, -2, 2, -3, 3];

    for (var i = 0; i < offsetsToTry.length; i++) {
      var sec = hint + offsetsToTry[i];
      if (sec < 0) continue;
      var matches = await findInSection(bookId, sec, note.quote);
      if (matches.length > 0) {
        var best = matches[0];
        var bestScore = scoreOccurrence(best, note);
        for (var j = 1; j < matches.length; j++) {
          var s = scoreOccurrence(matches[j], note);
          if (s > bestScore) {
            best = matches[j];
            bestScore = s;
          }
        }
        var startGrapheme = (best.range && best.range.start && typeof best.range.start.grapheme === 'number')
          ? best.range.start.grapheme
          : 0;
        return {
          found: true,
          isSectionNote: false,
          sectionIndex: best.sectionIndex,
          range: best.range,
          startOffset: startGrapheme,
          text: best.text || note.quote,
        };
      }
    }

    return {
      found: false,
      isSectionNote: false,
      sectionIndex: hint,
      range: null,
      startOffset: Number.MAX_SAFE_INTEGER,
    };
  }

  /**
   * Group notes into:
   * - Top: "הערות על הקטע כולו" (empty quote)
   * - Middle: Quote groups ordered by appearance in text (sectionIndex, startOffset)
   * - Bottom: "מיקום מדויק לא נמצא"
   */
  async function groupAndLocateNotes(notes, bookId) {
    var sectionWide = [];
    var unlocated = [];
    var locatedMap = {};
    var locatedOrder = [];

    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (!n.quote) {
        sectionWide.push(n);
        continue;
      }
      var loc = await locateNoteAnchor(n, bookId);
      n._anchor = loc;
      if (!loc.found) {
        unlocated.push(n);
        continue;
      }
      var gKey = loc.sectionIndex + ':' + normalizeCompare(n.quote);
      if (!locatedMap[gKey]) {
        locatedMap[gKey] = {
          key: gKey,
          type: 'quote',
          quote: n.quote,
          displayQuote: loc.text || n.quote,
          sectionIndex: loc.sectionIndex,
          startOffset: loc.startOffset,
          range: loc.range,
          notes: [],
        };
        locatedOrder.push(locatedMap[gKey]);
      }
      locatedMap[gKey].notes.push(n);
    }

    locatedOrder.sort(function (a, b) {
      if (a.sectionIndex !== b.sectionIndex) return a.sectionIndex - b.sectionIndex;
      return a.startOffset - b.startOffset;
    });

    var groups = [];
    if (sectionWide.length > 0) {
      groups.push({
        key: '__section__',
        type: 'section',
        quote: '',
        displayQuote: '',
        notes: sectionWide,
      });
    }
    for (var j = 0; j < locatedOrder.length; j++) {
      groups.push(locatedOrder[j]);
    }
    if (unlocated.length > 0) {
      groups.push({
        key: '__unlocated__',
        type: 'unlocated',
        quote: '',
        displayQuote: '',
        notes: unlocated,
      });
    }
    return groups;
  }

  function rangesOverlap(a, b) {
    if (!a || !b || !a.start || !a.end || !b.start || !b.end) return false;
    return a.start.grapheme <= b.end.grapheme && b.start.grapheme <= a.end.grapheme;
  }

  CN.anchors = {
    stripNikudAndTeamim: stripNikudAndTeamim,
    normalizeCompare: normalizeCompare,
    buildAnchorFromSelection: buildAnchorFromSelection,
    locateNoteAnchor: locateNoteAnchor,
    groupAndLocateNotes: groupAndLocateNotes,
    rangesOverlap: rangesOverlap,
  };
})(typeof window !== 'undefined' ? window : globalThis);
