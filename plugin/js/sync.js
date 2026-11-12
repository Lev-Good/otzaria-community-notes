(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  var PARASHA_TO_CHUMASH = {
    'בראשית': 'בראשית', 'נח': 'בראשית', 'לך לך': 'בראשית', 'וירא': 'בראשית',
    'חיי שרה': 'בראשית', 'תולדות': 'בראשית', 'ויצא': 'בראשית', 'וישלח': 'בראשית',
    'וישב': 'בראשית', 'מקץ': 'בראשית', 'ויגש': 'בראשית', 'ויחי': 'בראשית',
    'שמות': 'שמות', 'וארא': 'שמות', 'בא': 'שמות', 'בשלח': 'שמות',
    'יתרו': 'שמות', 'משפטים': 'שמות', 'תרומה': 'שמות', 'תצוה': 'שמות',
    'כי תשא': 'שמות', 'ויקהל': 'שמות', 'פקודי': 'שמות', 'ויקהל פקודי': 'שמות',
    'ויקרא': 'ויקרא', 'צו': 'ויקרא', 'שמיני': 'ויקרא', 'תזריע': 'ויקרא',
    'מצורע': 'ויקרא', 'תזריע מצורע': 'ויקרא', 'אחרי מות': 'ויקרא', 'אחרי': 'ויקרא',
    'קדושים': 'ויקרא', 'אחרי מות קדושים': 'ויקרא', 'אמור': 'ויקרא',
    'בהר': 'ויקרא', 'בחוקותי': 'ויקרא', 'בחקתי': 'ויקרא', 'בהר בחוקותי': 'ויקרא',
    'במדבר': 'במדבר', 'נשא': 'במדבר', 'בהעלותך': 'במדבר', 'בהעלתך': 'במדבר',
    'שלח': 'במדבר', 'שלח לך': 'במדבר', 'קרח': 'במדבר', 'חקת': 'במדבר',
    'חוקת': 'במדבר', 'בלק': 'במדבר', 'חוקת בלק': 'במדבר', 'פינחס': 'במדבר',
    'פנחס': 'במדבר', 'מטות': 'במדבר', 'מסעי': 'במדבר', 'מטות מסעי': 'במדבר',
    'דברים': 'דברים', 'ואתחנן': 'דברים', 'עקב': 'דברים', 'ראה': 'דברים',
    'שופטים': 'דברים', 'כי תצא': 'דברים', 'כי תבוא': 'דברים', 'נצבים': 'דברים',
    'ניצבים': 'דברים', 'וילך': 'דברים', 'נצבים וילך': 'דברים', 'ניצבים וילך': 'דברים',
    'האזינו': 'דברים', 'וזאת הברכה': 'דברים',
  };

  var syncInFlight = false;
  var memDailyTargets = [];
  var memBookUids = {};

  function normalizeTitle(s) {
    return String(s || '')
      .replace(/[\u0591-\u05C7\u2060״"']/g, '')
      .replace(/^פרשת\s+/, '')
      .replace(/^מסכת\s+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function extractTractateAndDaf(raw) {
    var txt = String(raw || '')
      .replace(/^דף יומי\s*:?\s*/i, '')
      .replace(/\s+דף\s+/g, ' ')
      .trim();
    if (!txt) return null;
    var parts = txt.split(/\s+/);
    if (parts.length < 2) {
      return { bookQuery: txt, refHint: '' };
    }
    var last = parts[parts.length - 1];
    if (/^[א-ת״"']{1,4}$/.test(last)) {
      return {
        bookQuery: parts.slice(0, -1).join(' '),
        refHint: last.replace(/[״"']/g, ''),
      };
    }
    return { bookQuery: txt, refHint: '' };
  }

  function lookupChumashForParasha(parashaStr) {
    var clean = String(parashaStr || '')
      .replace(/[\u0591-\u05C7]/g, '')
      .replace(/^פרשת\s+/, '')
      .replace(/[״"'\-–—]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return '';
    if (PARASHA_TO_CHUMASH[clean]) return PARASHA_TO_CHUMASH[clean];
    var keys = Object.keys(PARASHA_TO_CHUMASH);
    for (var i = 0; i < keys.length; i++) {
      if (clean.indexOf(keys[i]) === 0) return PARASHA_TO_CHUMASH[keys[i]];
    }
    return '';
  }

  /**
   * Parses Otzaria's calendar responses + user's priority settings into concrete study targets.
   */
  function parseDailyStudyTargetsFromCalendar(jewishDateData, eventsData, settings) {
    var s = settings || {};
    var tracks = s.dailyStudyTracks || {};
    var out = [];
    var seen = {};

    function addTarget(bookQuery, refHint, source, label) {
      var bq = String(bookQuery || '').trim();
      if (!bq) return;
      var k = source + '::' + normalizeTitle(bq);
      if (seen[k]) return;
      seen[k] = true;
      out.push({
        bookQuery: bq,
        refHint: String(refHint || '').trim(),
        source: source,
        label: label || bq,
      });
    }

    if (s.dailyStudySyncEnabled !== false) {
      var jd = jewishDateData && typeof jewishDateData === 'object' ? jewishDateData : {};
      var evList = Array.isArray(eventsData) ? eventsData : [];

      // Scan structured calendar fields and fallback event titles
      var dafStr = jd.dafYomi || jd.daf_yomi || '';
      var parashaStr = jd.parasha || jd.parashatHashavua || jd.sedra || '';
      var mishnaStr = jd.mishnaYomit || jd.mishna_yomit || '';
      var rambamStr = jd.rambamYomi || jd.rambam || jd.rambam1 || jd.rambam3 || '';

      for (var i = 0; i < evList.length; i++) {
        var ev = evList[i];
        var title = String((ev && (ev.title || ev.name || ev.hebrew || ev)) || '').trim();
        if (!title) continue;
        if (!dafStr && /^דף יומי\s*:?\s*/.test(title)) dafStr = title.replace(/^דף יומי\s*:?\s*/, '');
        if (!parashaStr && /^פרשת\s+/.test(title)) parashaStr = title;
        if (!mishnaStr && /^משנה יומית\s*:?\s*/.test(title)) mishnaStr = title.replace(/^משנה יומית\s*:?\s*/, '');
        if (!rambamStr && /^רמב["״']?ם/.test(title)) rambamStr = title.replace(/^רמב["״']?ם(?:\s+יומי)?\s*:?\s*/, '');
      }

      if (tracks.dafYomi !== false && dafStr) {
        var dafParsed = extractTractateAndDaf(dafStr);
        if (dafParsed) addTarget(dafParsed.bookQuery, dafParsed.refHint, 'dafYomi', 'דף יומי: ' + dafStr);
      }

      if (tracks.parasha !== false && parashaStr) {
        var chumash = lookupChumashForParasha(parashaStr);
        var cleanParasha = parashaStr.replace(/^פרשת\s+/, '').trim();
        if (chumash) {
          addTarget(chumash, cleanParasha, 'parasha', 'פרשת השבוע: ' + cleanParasha + ' (' + chumash + ')');
        } else {
          addTarget(cleanParasha, '', 'parasha', 'פרשת השבוע: ' + cleanParasha);
        }
      }

      if (tracks.mishnaYomit !== false && mishnaStr) {
        var mBook = mishnaStr.replace(/^משנה\s+/, '').trim().split(/\s+/)[0] || '';
        if (mBook) addTarget('משנה ' + mBook, mishnaStr, 'mishnaYomit', 'משנה יומית: ' + mishnaStr);
      }

      if (tracks.rambam === true && rambamStr) {
        var rBook = rambamStr.replace(/^משנה תורה[,\s]*/, '').replace(/\s+[א-ת״"']+\s*$/, '').trim();
        if (rBook) addTarget(rBook, rambamStr, 'rambam', 'רמב"ם יומי: ' + rambamStr);
      }
    }

    var customBooks = Array.isArray(s.priorityBooks) ? s.priorityBooks : [];
    for (var j = 0; j < customBooks.length; j++) {
      var titleCustom = String(customBooks[j] || '').trim();
      if (titleCustom) {
        addTarget(titleCustom, '', 'custom', titleCustom);
      }
    }

    return out;
  }

  function isBookPriority(bookTitle, bookUid, settings, cachedTargets) {
    var normBook = normalizeTitle(bookTitle);
    var normUid = normalizeTitle(bookUid);
    if (!normBook && !normUid) return { isPriority: false, reason: '' };

    var s = settings || {};
    var customList = Array.isArray(s.priorityBooks) ? s.priorityBooks : [];
    for (var i = 0; i < customList.length; i++) {
      var nb = normalizeTitle(customList[i]);
      if (!nb) continue;
      if ((normBook && (normBook === nb || normBook.indexOf(nb) !== -1 || nb.indexOf(normBook) !== -1)) || (normUid && normUid === nb)) {
        return { isPriority: true, reason: 'ספר מועדף (' + customList[i] + ')' };
      }
    }

    var targets = Array.isArray(cachedTargets) && cachedTargets.length > 0 ? cachedTargets : memDailyTargets;
    for (var j = 0; j < targets.length; j++) {
      var t = targets[j];
      if (t.source === 'custom') continue;
      var nt = normalizeTitle(t.bookQuery);
      if (!nt) continue;
      if ((normBook && (normBook === nt || normBook.indexOf(nt) !== -1)) || (normUid && normUid === nt)) {
        return { isPriority: true, reason: t.label || 'לימוד יומי' };
      }
    }

    return { isPriority: false, reason: '' };
  }

  function getEffectiveRefreshIntervalMs(bookTitle, bookUid, settings, cachedTargets) {
    var s = settings || {};
    var priorityCheck = isBookPriority(bookTitle, bookUid, s, cachedTargets);
    if (priorityCheck.isPriority) {
      var pMin = s.priorityRefreshMin !== undefined ? Number(s.priorityRefreshMin) : (CN.config.DEFAULT_PRIORITY_REFRESH_MIN || 1);
      if (pMin > 0) return pMin * 60 * 1000;
    }
    var baseMin = s.sectionRefreshMin !== undefined ? Number(s.sectionRefreshMin) : (CN.config.DEFAULT_SECTION_REFRESH_MIN || 3);
    if (baseMin <= 0) return 0;
    return baseMin * 60 * 1000;
  }

  async function resolveBookUid(bookTitle) {
    var key = normalizeTitle(bookTitle);
    if (!key) return null;
    if (memBookUids[key]) return memBookUids[key];

    var persisted = await CN.storage.get(CN.storage.KEYS.BOOK_UID_MAP, {});
    var entry = persisted && persisted[key];
    if (entry && entry.bookUid && (Date.now() - (entry.savedAt || 0) < 24 * 60 * 60 * 1000)) {
      memBookUids[key] = entry;
      return entry;
    }

    if (!global.Otzaria || typeof global.Otzaria.call !== 'function') return null;
    try {
      var res = await global.Otzaria.call('library.findBooks', { query: bookTitle, limit: 6 });
      var list = (res && res.success && Array.isArray(res.data)) ? res.data : [];
      if (list.length === 0) return null;
      var best = list[0];
      for (var i = 0; i < list.length; i++) {
        if (normalizeTitle(list[i].title || list[i].bookId) === key) {
          best = list[i];
          break;
        }
      }
      var uid = best.bookUid || (best.id != null ? ('id:' + best.id) : (best.bookId || bookTitle));
      var resolved = {
        bookUid: String(uid),
        bookId: String(best.bookId || best.title || bookTitle),
        titleHint: String(best.title || best.bookId || bookTitle),
        savedAt: Date.now(),
      };
      memBookUids[key] = resolved;
      persisted = persisted && typeof persisted === 'object' ? persisted : {};
      persisted[key] = resolved;
      await CN.storage.set(CN.storage.KEYS.BOOK_UID_MAP, persisted);
      return resolved;
    } catch (_) {
      return null;
    }
  }

  async function fetchDailyCalendarInfo(permissions) {
    var perms = Array.isArray(permissions) ? permissions : (CN.state && CN.state.permissions) || [];
    if (perms.indexOf('calendar.read') === -1 || !global.Otzaria) {
      return { jewishDate: null, events: [] };
    }
    var jewishDate = null;
    var events = [];
    try {
      var jd = await global.Otzaria.call('calendar.getJewishDate');
      if (jd && jd.success && jd.data) jewishDate = jd.data;
    } catch (_) { /* ignore */ }
    try {
      var ev = await global.Otzaria.call('calendar.getEvents');
      if (ev && ev.success && Array.isArray(ev.data)) events = ev.data;
    } catch (_) { /* ignore */ }
    return { jewishDate: jewishDate, events: events };
  }

  async function getCachedSyncMeta() {
    var meta = await CN.storage.get(CN.storage.KEYS.PRIORITY_SYNC_META, null);
    if (meta && Array.isArray(meta.targets) && memDailyTargets.length === 0) {
      memDailyTargets = meta.targets;
    }
    return meta || { syncedAt: 0, targets: [], booksSynced: 0, sectionsCached: 0 };
  }

  /**
   * Discovers today's Daily Study + Priority Books and prefetches their active sections
   * into the local cache so opening them is instant and always up-to-date.
   */
  async function syncPriorityBooksIfDue({ force = false, settings = null, identity = null, permissions = null } = {}) {
    if (syncInFlight) return getCachedSyncMeta();
    var s = settings || (CN.state && CN.state.settings) || CN.storage.defaultSettings();
    var hasDaily = s.dailyStudySyncEnabled !== false;
    var hasCustom = Array.isArray(s.priorityBooks) && s.priorityBooks.length > 0;
    if (!hasDaily && !hasCustom && !force) return getCachedSyncMeta();

    var isOnline = CN.state ? (CN.state.isOnline !== false) : true;
    if (!isOnline) return getCachedSyncMeta();

    var prevMeta = await getCachedSyncMeta();
    var intervalMs = Math.max(5, Number(s.prioritySyncIntervalMin || 15)) * 60 * 1000;
    if (!force && prevMeta.syncedAt && (Date.now() - prevMeta.syncedAt < intervalMs)) {
      return prevMeta;
    }

    syncInFlight = true;
    try {
      var cal = await fetchDailyCalendarInfo(permissions);
      var targets = parseDailyStudyTargetsFromCalendar(cal.jewishDate, cal.events, s);
      memDailyTargets = targets;

      var booksSynced = 0;
      var sectionsCached = 0;
      var cappedTargets = targets.slice(0, 6);

      for (var i = 0; i < cappedTargets.length; i++) {
        var tgt = cappedTargets[i];
        var resolved = await resolveBookUid(tgt.bookQuery);
        if (!resolved || !resolved.bookUid) continue;
        tgt.bookUid = resolved.bookUid;
        tgt.resolvedTitle = resolved.titleHint;

        try {
          var idxRes = await CN.api.request(
            'GET',
            '/v1/books/' + encodeURIComponent(resolved.bookUid) + '/index',
            { settings: s }
          );
          if (!idxRes.ok || !idxRes.data || !idxRes.data.refs) continue;
          booksSynced++;

          var refEntries = Object.keys(idxRes.data.refs).map(function (refName) {
            var info = idxRes.data.refs[refName] || {};
            var score = Number(info.notes || 0) + Number(info.questions || 0);
            var hintMatch = tgt.refHint && refName.indexOf(tgt.refHint) !== -1 ? 1000 : 0;
            return { ref: refName, weight: hintMatch + score };
          });
          refEntries.sort(function (a, b) { return b.weight - a.weight; });
          var topRefs = refEntries.slice(0, 5);

          for (var r = 0; r < topRefs.length; r++) {
            var refName = topRefs[r].ref;
            var cachedEntry = await CN.storage.getCachedSectionNotes(resolved.bookUid, refName);
            if (!force && cachedEntry && cachedEntry.savedAt && (Date.now() - cachedEntry.savedAt < 5 * 60 * 1000)) {
              continue;
            }
            var nRes = await CN.api.request(
              'GET',
              '/v1/books/' + encodeURIComponent(resolved.bookUid) + '/notes?ref=' + encodeURIComponent(refName),
              { auth: Boolean(identity && identity.userId), identity: identity, settings: s }
            );
            if (nRes.ok && nRes.data && Array.isArray(nRes.data.items)) {
              await CN.storage.putCachedSectionNotes(resolved.bookUid, refName, nRes.data.items);
              sectionsCached++;
            }
          }
        } catch (_) { /* continue next target */ }
      }

      var newMeta = {
        syncedAt: Date.now(),
        targets: targets,
        booksSynced: booksSynced,
        sectionsCached: sectionsCached,
      };
      await CN.storage.set(CN.storage.KEYS.PRIORITY_SYNC_META, newMeta);
      return newMeta;
    } finally {
      syncInFlight = false;
    }
  }

  function isAllowedFestivalHoliday(h) {
    if (!h) return false;
    var kind = String(h.kind || h.type || h.category || '').toLowerCase();
    var text = String(h.name || h.hebrewName || h.title || h.heTitle || (typeof h === 'string' ? h : ''));
    if (/chol[_ -]?hamoed|isru[_ -]?chag|chanukah|hanukkah|purim/i.test(kind)) return true;
    if (/(?:^|[^א-ת])(חול\s*המועד|חוה"?מ|אי?סרו\s*חג|חנוכה|שושן\s*פורים|ה?פורים(?:\s*קטן)?|ראש\s*חודש|ערב\s+)/.test(text)) return true;
    return false;
  }

  function isYomTovHoliday(h) {
    if (!h || isAllowedFestivalHoliday(h)) return false;
    var kind = String(h.kind || h.type || h.category || '').toLowerCase();
    if (kind === 'yomtov' || kind === 'yom_tov' || kind === 'yom-tov') return true;
    var text = String(h.name || h.hebrewName || h.title || h.heTitle || (typeof h === 'string' ? h : ''));
    if (/^(ראש השנה|יום כיפור|יום הכיפורים|שמיני עצרת|שמחת תורה|שביעי של פסח|אחרון של פסח|שבועות)/.test(text)) {
      return true;
    }
    if ((/^סוכות\b|^פסח\b/.test(text) || /^א׳?\s*(דסוכות|דפסח)/.test(text)) && !/חול|שני|שלישי|רביעי|חמישי|שישי|ערב|אי?סרו/.test(text)) {
      return true;
    }
    return false;
  }

  /**
   * Unconditionally silences alerts on Shabbat and Yom Tov.
   * Explicitly keeps notifications active on Chol HaMoed, Isru Chag, Chanukah, and Purim.
   */
  async function isShabbatOrYomTov(permissions) {
    var perms = Array.isArray(permissions)
      ? permissions
      : ((CN.state && Array.isArray(CN.state.permissions)) ? CN.state.permissions : []);
    if (perms.indexOf('calendar.read') !== -1 && global.Otzaria) {
      try {
        var res = await global.Otzaria.call('calendar.getJewishDate');
        if (res && res.success && res.data) {
          if (res.data.isShabbat) return true;
          var holidays = Array.isArray(res.data.holidays) ? res.data.holidays : [];
          var hasAllowedOnly = false;
          for (var i = 0; i < holidays.length; i++) {
            if (isYomTovHoliday(holidays[i])) return true;
            if (isAllowedFestivalHoliday(holidays[i])) hasAllowedOnly = true;
          }
          if (res.data.isYomTov === true && !hasAllowedOnly) return true;
          return false;
        }
      } catch (_) { /* fall back to day check */ }
    }
    return new Date().getDay() === 6;
  }

  CN.sync = {
    PARASHA_TO_CHUMASH: PARASHA_TO_CHUMASH,
    parseDailyStudyTargetsFromCalendar: parseDailyStudyTargetsFromCalendar,
    isBookPriority: isBookPriority,
    getEffectiveRefreshIntervalMs: getEffectiveRefreshIntervalMs,
    resolveBookUid: resolveBookUid,
    syncPriorityBooksIfDue: syncPriorityBooksIfDue,
    getCachedSyncMeta: getCachedSyncMeta,
    isShabbatOrYomTov: isShabbatOrYomTov,
  };
})(typeof window !== 'undefined' ? window : globalThis);
