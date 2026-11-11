(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  CN.config = {
    PLUGIN_VERSION: '0.5.0',
    DEFAULT_API_BASE: 'https://community-notes.otzaria-notes.workers.dev',
    MAX_CACHED_LOCATIONS: 200,
    MAX_QUOTE_CHARS: 200,
    MAX_SELECTION_CHARS: 500,
    CONTEXT_CHARS: 30,
    MIN_BODY_CHARS: 10,
    MAX_BODY_CHARS: 2000,
    PAGE_SIZE: 20,
    INBOX_FOREGROUND_POLL_MS: 5 * 60 * 1000,
    INBOX_BACKGROUND_COOLDOWN_MS: 30 * 60 * 1000,
    DRAFT_AUTOSAVE_MS: 2000,
  };
})(typeof window !== 'undefined' ? window : globalThis);
