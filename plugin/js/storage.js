(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  var KEYS = {
    SETTINGS: 'settings:v1',
    IDENTITY: 'identity:v1',
    CACHE_SECTIONS: 'cache:sections:v1',
    WORKED_BOOKS: 'worked_books:v1',
    LAST_LOCATION: 'last_location:v1',
    BG_CHECK_AT: 'bg:last_inbox_check:v1',
    VISIT_COUNT: 'meta:visits:v1',
    BG_PROMPT_DISMISSED: 'meta:bg_prompt_dismissed:v1',
    INBOX_LAST_SEQ: 'inbox:last_seq:v1',
    DRAFT_PREFIX: 'draft:',
  };

  function defaultSettings() {
    return {
      schemaVersion: 1,
      // Display
      filterTier: 'recommended_and_new', // recommended_and_new | recommended_only | all
      sortOrder: 'recommended',          // recommended | newest
      contentTypes: { note: true, question: true, answer: true },
      cardTextSize: 'otzaria',           // otzaria | small | medium | large
      nikudMode: 'otzaria',              // otzaria | always | never
      density: 'comfortable',            // comfortable | compact
      longCards: 'collapsed',            // collapsed | expanded
      groupQuoteMode: 'single_line',     // single_line | full
      helpfulCountMode: 'from_3',        // from_3 | always | never
      // Behavior
      startScreen: 'section',            // section | questions | home
      splitBookPane: 'auto',             // auto | always | off
      returnAfterSubmit: true,
      returnAfterReveal: true,
      defaultComposerKind: 'note',       // note | question | last
      lastUsedComposerKind: 'note',
      autosaveDrafts: true,
      hiddenWords: [],
      blockedAuthors: [],                // [{ id, name }]
      // Highlights (requires background/highlight permission)
      highlightEnabled: true,
      highlightIntensity: 'subtle',      // subtle | normal
      highlightSeparateQuestions: true,
      highlightRecommendedOnly: false,
      // Notifications
      inAppNotifications: true,
      notifyTypes: { reply: true, answer: true, accepted: true, moderation: true },
      systemNotifications: false,
      bgCheckFrequencyMin: 30,           // 30 | 60 | 0 (startup only)
      shabbatQuietMode: true,
      // Advanced / server endpoint override (for testing/self-hosting)
      apiBaseUrl: '',
    };
  }

  function migrateSettings(raw) {
    var base = defaultSettings();
    if (!raw || typeof raw !== 'object') return base;
    var merged = Object.assign({}, base, raw);
    merged.contentTypes = Object.assign({}, base.contentTypes, raw.contentTypes || {});
    merged.notifyTypes = Object.assign({}, base.notifyTypes, raw.notifyTypes || {});
    if (!Array.isArray(merged.hiddenWords)) merged.hiddenWords = [];
    if (!Array.isArray(merged.blockedAuthors)) merged.blockedAuthors = [];
    merged.schemaVersion = 1;
    return merged;
  }

  async function get(key, fallback) {
    try {
      var res = await global.Otzaria.call('storage.get', { key: key });
      if (res && res.success && res.data !== null && res.data !== undefined) {
        return res.data;
      }
    } catch (_) {
      // ignore storage read error
    }
    return fallback === undefined ? null : fallback;
  }

  async function set(key, value) {
    if (value === null || value === undefined) {
      return remove(key);
    }
    var res = await global.Otzaria.call('storage.set', { key: key, value: value });
    return Boolean(res && res.success);
  }

  async function remove(key) {
    try {
      var res = await global.Otzaria.call('storage.remove', { key: key });
      return Boolean(res && res.success);
    } catch (_) {
      return false;
    }
  }

  async function loadSettings() {
    var raw = await get(KEYS.SETTINGS, null);
    return migrateSettings(raw);
  }

  async function saveSettings(settings) {
    return set(KEYS.SETTINGS, migrateSettings(settings));
  }

  // LRU cache of up to 200 recent section note lists
  async function loadSectionCache() {
    var data = await get(KEYS.CACHE_SECTIONS, null);
    if (!data || typeof data !== 'object') return { order: [], entries: {} };
    return {
      order: Array.isArray(data.order) ? data.order : [],
      entries: data.entries && typeof data.entries === 'object' ? data.entries : {},
    };
  }

  function makeCacheKey(bookUid, ref) {
    return String(bookUid || '') + '::' + String(ref || '');
  }

  async function getCachedSectionNotes(bookUid, ref) {
    var cache = await loadSectionCache();
    var k = makeCacheKey(bookUid, ref);
    return cache.entries[k] || null;
  }

  async function putCachedSectionNotes(bookUid, ref, items) {
    var cache = await loadSectionCache();
    var k = makeCacheKey(bookUid, ref);
    cache.order = cache.order.filter(function (x) { return x !== k; });
    cache.order.unshift(k);
    cache.entries[k] = {
      savedAt: Date.now(),
      items: Array.isArray(items) ? items : [],
    };
    var max = CN.config.MAX_CACHED_LOCATIONS;
    while (cache.order.length > max) {
      var evicted = cache.order.pop();
      delete cache.entries[evicted];
    }
    await set(KEYS.CACHE_SECTIONS, cache);
  }

  async function clearSectionCache() {
    return remove(KEYS.CACHE_SECTIONS);
  }

  function makeDraftKey(bookUid, ref, quote) {
    var q = String(quote || '').slice(0, 40);
    return KEYS.DRAFT_PREFIX + encodeURIComponent(String(bookUid || '')) + ':' + encodeURIComponent(String(ref || '')) + ':' + encodeURIComponent(q);
  }

  async function listDrafts() {
    try {
      var res = await global.Otzaria.call('storage.list');
      var keys = (res && res.success && Array.isArray(res.data)) ? res.data : [];
      var out = [];
      for (var i = 0; i < keys.length; i++) {
        if (String(keys[i]).indexOf(KEYS.DRAFT_PREFIX) === 0) {
          var d = await get(keys[i], null);
          if (d && d.body) out.push(Object.assign({ key: keys[i] }, d));
        }
      }
      out.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      return out;
    } catch (_) {
      return [];
    }
  }

  async function recordWorkedBook(bookUid, titleHint, ref, sectionIndex) {
    if (!bookUid) return;
    var books = await get(KEYS.WORKED_BOOKS, []);
    if (!Array.isArray(books)) books = [];
    books = books.filter(function (b) { return b && b.bookUid !== bookUid; });
    books.unshift({
      bookUid: bookUid,
      titleHint: titleHint || bookUid,
      lastRef: ref || '',
      lastSectionIndex: sectionIndex || 0,
      updatedAt: Date.now(),
    });
    if (books.length > 25) books = books.slice(0, 25);
    await set(KEYS.WORKED_BOOKS, books);
    await set(KEYS.LAST_LOCATION, {
      bookUid: bookUid,
      titleHint: titleHint || bookUid,
      ref: ref || '',
      sectionIndex: sectionIndex || 0,
      updatedAt: Date.now(),
    });
  }

  CN.storage = {
    KEYS: KEYS,
    defaultSettings: defaultSettings,
    migrateSettings: migrateSettings,
    get: get,
    set: set,
    remove: remove,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    getCachedSectionNotes: getCachedSectionNotes,
    putCachedSectionNotes: putCachedSectionNotes,
    clearSectionCache: clearSectionCache,
    makeDraftKey: makeDraftKey,
    listDrafts: listDrafts,
    recordWorkedBook: recordWorkedBook,
  };
})(typeof window !== 'undefined' ? window : globalThis);
