(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  CN.state = {
    screen: 'home', // section | questions | mine | messages | home | thread | compose | mod
    previousScreen: 'section',
    cameFromReader: false,
    isPdf: false,
    permissions: [],
    isOnline: null,
    config: {
      minPluginVersion: '0.1.0',
      writesEnabled: true,
      inviteRequired: true,
      systemNotice: '',
    },
    theme: null,
    otzariaSettings: {
      fontSize: null,
      defaultNikud: true,
      showTeamim: true,
    },
    settings: CN.storage.defaultSettings(),
    identity: null,
    unreadCount: 0,
    context: {
      bookUid: '',
      bookId: '',
      titleHint: '',
      ref: '',
      sectionIndex: 0,
      selection: null,
      anchor: null,
      clickedHighlightIds: [],
    },
    sectionNotes: [],
    sectionGroups: [],
    sectionTotalLoaded: 0,
    sectionFilter: 'recommended_and_new',
    sectionSort: 'recommended',
    sectionVisibleLimit: CN.config.PAGE_SIZE,
    sectionFocusOnly: false,
    sectionCacheDate: null,
    sectionLoading: false,
    sectionRefreshing: false,
    sectionError: null,
    activeThreadId: null,
    activeThreadData: null,
    compose: {
      mode: 'create', // create | edit
      editingNote: null,
      kind: 'note',
      body: '',
      anchor: null,
      dirty: false,
    },
    myNotesData: { helpedCount: 0, items: [] },
    questionsData: [],
    inboxData: [],
    modQueue: [],
    modLog: [],
    highlightCapabilities: { highlights: false, selection: false },
  };
})(typeof window !== 'undefined' ? window : globalThis);
