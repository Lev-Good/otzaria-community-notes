import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(__dirname, '../plugin');

function loadPluginModules(extraEnv = {}) {
  const storageMap = new Map();
  const calls = [];
  const context = {
    window: null,
    globalThis: null,
    crypto: globalThis.crypto,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    TextEncoder,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    document: {
      readyState: 'complete',
      documentElement: { dir: 'rtl', lang: 'he', style: { setProperty() {} } },
      body: { classList: { toggle() {} } },
      getElementById() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      createTextNode: (t) => ({ nodeType: 3, textContent: t }),
      createElement: (tag) => {
        const classes = new Set();
        const node = {
          tagName: tag.toUpperCase(),
          className: '',
          textContent: '',
          attrs: {},
          dataset: {},
          style: {},
          children: [],
          classList: {
            add(c) { classes.add(c); },
            remove(c) { classes.delete(c); },
            toggle(c, force) {
              if (force === undefined) {
                if (classes.has(c)) { classes.delete(c); return false; }
                classes.add(c); return true;
              }
              if (force) classes.add(c); else classes.delete(c);
              return Boolean(force);
            },
            contains(c) { return classes.has(c); },
          },
          setAttribute(k, v) { this.attrs[k] = v; },
          addEventListener() {},
          querySelector() { return null; },
          querySelectorAll() { return []; },
          appendChild(ch) { this.children.push(ch); return ch; },
        };
        return node;
      },
    },
    Otzaria: {
      __isStub: true,
      async call(method, payload) {
        calls.push({ method, payload });
        if (method === 'storage.get') return { success: true, data: storageMap.get(payload.key) ?? null };
        if (method === 'storage.set') { storageMap.set(payload.key, payload.value); return { success: true, data: true }; }
        if (method === 'storage.remove') { storageMap.delete(payload.key); return { success: true, data: true }; }
        if (method === 'storage.list') return { success: true, data: Array.from(storageMap.keys()) };
        if (method === 'reader.findTextOccurrences') {
          if (extraEnv.findTextOccurrences) return { success: true, data: extraEnv.findTextOccurrences(payload) };
          return { success: true, data: { results: [] } };
        }
        return { success: true, data: null };
      },
      on() {},
    },
    ...extraEnv,
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);

  const files = ['i18n/en.js', 'js/i18n.js', 'js/config.js', 'js/storage.js', 'js/crypto.js', 'js/filter.js', 'js/anchors.js', 'js/state.js', 'js/ui-shared.js'];
  for (const f of files) {
    const code = fs.readFileSync(path.join(pluginDir, f), 'utf8');
    vm.runInContext(code, context, { filename: f });
  }
  return { CN: context.CN, storageMap, calls, context };
}

test('Client ECDSA P-256 key generation, signing, and PoW solver', async () => {
  const { CN } = loadPluginModules();
  const kp = await CN.crypto.generateKeyPair();
  assert.ok(kp.pubkeySpki.length > 40);
  assert.equal(kp.privateJwk.crv, 'P-256');

  const sig = await CN.crypto.signRequest(kp.privateJwk, 'POST', '/v1/notes', 1, 1700000000000, '{"a":1}');
  assert.ok(typeof sig === 'string' && sig.length > 60);

  const nonce = await CN.crypto.solveChallenge({ prefix: 'abc', difficulty: 8 });
  assert.ok(Number(nonce) >= 0);
});

test('Client live filter & safe link renderer block otzaria://plugin/install and external URLs', () => {
  const { CN, context } = loadPluginModules();
  assert.equal(CN.filter.validateLiveBody('קצר', '').valid, false);
  assert.equal(CN.filter.validateLiveBody('כנסו לאתר https://evil.com עכשיו בבקשה', '').valid, false);
  assert.equal(CN.filter.validateLiveBody('התקן otzaria://plugin/install/malware מייד', '').valid, false);
  assert.equal(CN.filter.validateLiveBody('עיין בדברי הרמב״ן בפרק זה otzaria://open/book/183?ref=א', '').valid, true);

  const container = context.document.createElement('div');
  CN.ui.renderSafeNoteBody(
    container,
    'ראה otzaria://open/book/183?title=בראשית וגם otzaria://plugin/install/bad'
  );
  const links = container.children.filter((c) => c.tagName === 'A');
  const texts = container.children.filter((c) => c.nodeType === 3).map((c) => c.textContent).join('');
  assert.equal(links.length, 1);
  assert.equal(links[0].attrs.href, 'otzaria://open/book/183?title=בראשית');
  assert.ok(texts.includes('[קישור הוסר]'));
  assert.ok(!texts.includes('plugin/install'));
});

test('Client anchors: multi-paragraph handling, neighboring section search, and group ordering', async () => {
  const { CN } = loadPluginModules({
    findTextOccurrences(payload) {
      // Simulate library shift: sectionHint was 5, text moved to section 6!
      if (payload.sectionIndex === 6 && payload.query === 'בראשית ברא') {
        return {
          results: [
            {
              sectionIndex: 6,
              text: 'בְּרֵאשִׁית בָּרָא',
              range: {
                start: { grapheme: 10 },
                end: { grapheme: 21 },
                beforeText: { raw: 'התחלה: ' },
                afterText: { raw: ' אלהים' },
                occurrenceIndexInSection: 0,
              },
            },
          ],
        };
      }
      return { results: [] };
    },
  });

  const anchor = CN.anchors.buildAnchorFromSelection({
    bookUid: 'id:183',
    bookTitle: 'בראשית',
    currentRef: 'פרק א',
    sections: [
      { sectionIndex: 1, sourceSelectedText: 'פסקה א', sourceRange: { exactText: 'פסקה א', start: { grapheme: 0 }, end: { grapheme: 6 } } },
      { sectionIndex: 2, sourceSelectedText: 'פסקה ב', sourceRange: { exactText: 'פסקה ב', start: { grapheme: 0 }, end: { grapheme: 6 } } },
    ],
  });
  assert.equal(anchor.multiParagraph, true);
  assert.equal(anchor.quote, 'פסקה א');

  const groups = await CN.anchors.groupAndLocateNotes([
    { id: 'n1', quote: 'טקסט שאבד לגמרי', sectionHint: 5, prefix: '', suffix: '' },
    { id: 'n2', quote: 'בראשית ברא', sectionHint: 5, prefix: 'התחלה: ', suffix: ' אלהים' },
    { id: 'n3', quote: '', sectionHint: 5 },
  ], 'בראשית');

  assert.equal(groups[0].type, 'section');
  assert.equal(groups[1].type, 'quote');
  assert.equal(groups[1].sectionIndex, 6);
  assert.equal(groups[2].type, 'unlocated');
});

test('Client storage LRU cache eviction at 200 entries & i18n fallback', async () => {
  const { CN } = loadPluginModules();
  CN.config.MAX_CACHED_LOCATIONS = 3; // temporarily test eviction cleanly
  await CN.storage.putCachedSectionNotes('b1', 'r1', [{ id: '1' }]);
  await CN.storage.putCachedSectionNotes('b1', 'r2', [{ id: '2' }]);
  await CN.storage.putCachedSectionNotes('b1', 'r3', [{ id: '3' }]);
  await CN.storage.putCachedSectionNotes('b1', 'r4', [{ id: '4' }]);

  assert.equal(await CN.storage.getCachedSectionNotes('b1', 'r1'), null);
  assert.ok(await CN.storage.getCachedSectionNotes('b1', 'r4'));

  CN.i18n.setLanguage('en', 'ltr');
  assert.equal(CN.i18n.t('הערות הקהילה'), 'Community Notes');
  assert.equal(CN.i18n.t('מחרוזת ללא תרגום'), 'מחרוזת ללא תרגום');
});

test('All plugin JS modules parse cleanly and register expected namespaces', () => {
  const { context } = loadPluginModules({
    navigator: { onLine: true },
    setInterval() { return 1; },
    clearInterval() {},
  });
  const extraFiles = [
    'js/api.js',
    'js/sync.js',
    'js/highlights.js',
    'js/menus.js',
    'js/ui-cards.js',
    'js/ui-composer.js',
    'js/ui-importer.js',
    'js/ui-bookpane.js',
    'js/ui-onboarding.js',
    'js/ui-settings.js',
    'js/ui-mod.js',
    'js/app.js',
  ];
  for (const f of extraFiles) {
    const code = fs.readFileSync(path.join(pluginDir, f), 'utf8');
    vm.runInContext(code, context, { filename: f });
  }
  assert.ok(context.CN.api.request);
  assert.ok(context.CN.sync.syncPriorityBooksIfDue);
  assert.ok(context.CN.highlights.syncSectionHighlights);
  assert.ok(context.CN.menus.syncMenusForSection);
  assert.ok(context.CN.cards.buildNoteCard);
  assert.ok(context.CN.composer.renderComposer);
  assert.ok(context.CN.importer.renderImportScreen);
  assert.ok(context.CN.bookPane.syncToContext);
  assert.ok(context.CN.onboarding.ensureRegistered);
  assert.ok(context.CN.settingsUi.openSettingsPanel);
  assert.ok(context.CN.modUi.renderModPanel);
  assert.ok(context.CN.app.navigate);
});

test('Client Settings panel & RTL CSS layout invariants prevent clipping and toggle cutoff', () => {
  const css = fs.readFileSync(path.join(pluginDir, 'css/style.css'), 'utf8');
  assert.match(css, /\.overlay-panel\s*\{[^}]*inset-inline-end:\s*10px/s);
  assert.match(css, /\.panel-body\s*\{[^}]*min-height:\s*0/s);
  assert.match(css, /\.settings-card\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
  assert.match(css, /\.segmented\s*\{[^}]*align-self:\s*flex-start/s);
  assert.match(css, /\.switch::after\s*\{[^}]*inset-inline-start:\s*2px/s);
});

test('Client batch personal notes importer discovers notes, resolves bookUid & ref, deduplicates, and batch-uploads', async () => {
  const { context, storageMap } = loadPluginModules({
    navigator: { onLine: true },
    setInterval() { return 1; },
    clearInterval() {},
  });
  for (const f of ['js/api.js', 'js/highlights.js', 'js/ui-importer.js', 'js/ui-onboarding.js']) {
    vm.runInContext(fs.readFileSync(path.join(pluginDir, f), 'utf8'), context, { filename: f });
  }

  const postedPayloads = [];
  context.CN.state.identity = { userId: 'u1', displayName: 'בודק', privateJwk: { kty: 'EC' } };
  context.CN.state.isOnline = true;
  context.CN.onboarding.ensureRegistered = async () => true;

  // Mock Otzaria calls for personal notes + library lookup + section text map
  const origCall = context.Otzaria.call;
  context.Otzaria.call = async (method, payload) => {
    if (method === 'notes.getBookNotesSummary') {
      return { success: true, data: [{ bookId: 'בראשית', noteCount: 3, lastModified: '2026-11-11T10:00:00Z' }] };
    }
    if (method === 'library.findBooks') {
      return { success: true, data: [{ id: 183, bookId: 'בראשית', title: 'בראשית' }] };
    }
    if (method === 'notes.list' && payload.bookId === 'בראשית') {
      return {
        success: true,
        data: [
          { id: 'pn1', lineNumber: 1, content: 'הערה מפורטת מאוד על פסוק ב בפרשת בראשית', contentPlain: 'הערה מפורטת מאוד על פסוק ב בפרשת בראשית' },
          { id: 'pn2', lineNumber: 2, content: 'קצר', contentPlain: 'קצר' },
          { id: 'pn3', lineNumber: 3, content: 'הערה שכבר קיימת בחשבון הקהילתי בשרת', contentPlain: 'הערה שכבר קיימת בחשבון הקהילתי בשרת' },
        ],
      };
    }
    if (method === 'reader.getSectionTextMap') {
      return { success: true, data: { currentRef: 'פרק א פסוק ב', sourceText: 'והארץ היתה תוהו ובוהו וחשך על פני תהום' } };
    }
    return origCall(method, payload);
  };

  context.CN.api.fetchSolvedChallenge = async () => ({ challengeToken: 'tok', challengeNonce: '1' });
  context.CN.api.request = async (method, pathWithQ, opts) => {
    if (method === 'GET' && pathWithQ === '/v1/me/notes') {
      return {
        ok: true,
        status: 200,
        data: { items: [{ id: 'srv1', bookUid: 'id:183', status: 'published', body: 'הערה שכבר קיימת בחשבון הקהילתי בשרת' }] },
      };
    }
    if (method === 'POST' && pathWithQ === '/v1/notes') {
      postedPayloads.push(opts.bodyObj);
      return {
        ok: true,
        status: 201,
        data: { note: { id: 'new_srv_' + postedPayloads.length, status: 'published' } },
      };
    }
    return { ok: false, status: 404, data: null };
  };

  const cat = await context.CN.importer.loadPersonalNotesCatalog({ force: true });
  assert.equal(cat.items.length, 3);

  const pn1 = cat.items.find((i) => i.personalId === 'pn1');
  const pn2 = cat.items.find((i) => i.personalId === 'pn2');
  const pn3 = cat.items.find((i) => i.personalId === 'pn3');

  assert.equal(pn1.bookUid, 'id:183');
  assert.equal(pn1.selected, true); // valid and not uploaded yet
  assert.equal(pn2.selected, false); // too short (<10 chars)
  assert.equal(pn3.alreadyUploaded, true);
  assert.equal(pn3.selected, false); // deduplicated against /v1/me/notes

  pn1.attachQuote = true;
  const summary = await context.CN.importer.uploadSelectedNotes(cat.items);
  assert.equal(summary.uploaded, 1);
  assert.equal(summary.published, 1);
  assert.equal(postedPayloads.length, 1);
  assert.equal(postedPayloads[0].bookUid, 'id:183');
  assert.equal(postedPayloads[0].ref, 'פרק א פסוק ב');
  assert.equal(postedPayloads[0].sectionHint, 1);
  assert.ok(postedPayloads[0].quote.includes('והארץ היתה תוהו'));

  const uploadedMap = storageMap.get('import:uploaded:v1');
  assert.ok(uploadedMap['בראשית::pn1']);
});

test('Client split book pane visibility, anchor builder, and TOC/section loading', async () => {
  const { context } = loadPluginModules({
    innerWidth: 1200,
    navigator: { onLine: true },
    setInterval() { return 1; },
    clearInterval() {},
  });
  for (const f of ['js/ui-bookpane.js', 'js/ui-composer.js', 'js/app.js']) {
    vm.runInContext(fs.readFileSync(path.join(pluginDir, f), 'utf8'), context, { filename: f });
  }

  context.CN.state.context = { bookUid: 'id:183', bookId: 'בראשית', titleHint: 'בראשית', ref: 'פרק א', sectionIndex: 2 };
  context.CN.state.screen = 'compose';
  context.CN.state.settings.splitBookPane = 'auto';
  assert.equal(context.CN.bookPane.shouldShowBookPane(), true);

  context.CN.state.settings.splitBookPane = 'off';
  assert.equal(context.CN.bookPane.shouldShowBookPane(), false);

  context.CN.state.bookPaneOpenOverride = true;
  assert.equal(context.CN.bookPane.shouldShowBookPane(), true);

  context.CN.bookPane.state.bookUid = 'id:183';
  context.CN.bookPane.state.bookId = 'בראשית';
  context.CN.bookPane.state.titleHint = 'בראשית';
  const anchor = context.CN.bookPane.buildAnchorForSectionAndSelection(
    {
      sectionIndex: 2,
      ref: 'פרק א פסוק ג',
      sourceText: 'ויאמר אלהים יהי אור ויהי אור',
      renderedText: 'ויאמר ה׳ יהי אור ויהי אור',
    },
    'יהי אור'
  );
  assert.equal(anchor.bookUid, 'id:183');
  assert.equal(anchor.sectionHint, 2);
  assert.equal(anchor.ref, 'פרק א פסוק ג');
  assert.equal(anchor.quote, 'יהי אור');
  assert.equal(anchor.occurrence, 0);
  assert.ok(anchor.prefix.includes('אלהים'));
  assert.ok(anchor.suffix.includes('ויהי'));

  const mockPane = context.document.createElement('aside');
  mockPane.classList = {
    classes: new Set(['hidden']),
    add(c) { this.classes.add(c); },
    remove(c) { this.classes.delete(c); },
    toggle(c, force) { force ? this.classes.add(c) : this.classes.delete(c); },
    contains(c) { return this.classes.has(c); },
  };
  mockPane.querySelector = () => null;
  mockPane.querySelectorAll = () => [];
  const origGetById = context.document.getElementById;
  context.document.getElementById = (id) => (id === 'book-pane' ? mockPane : origGetById(id));

  const origCall = context.Otzaria.call;
  context.Otzaria.call = async (method, payload) => {
    if (method === 'library.getBookToc') {
      return { success: true, data: [{ text: 'פרק א', index: 0, level: 1 }] };
    }
    if (method === 'reader.getSectionTextMap') {
      return {
        success: true,
        data: { sectionIndex: payload.sectionIndex, currentRef: 'פרק א פסוק ' + (payload.sectionIndex + 1), renderedText: 'טקסט ' + payload.sectionIndex, sourceText: 'טקסט ' + payload.sectionIndex },
      };
    }
    return origCall(method, payload);
  };

  await context.CN.bookPane.syncToContext();
  assert.equal(mockPane.classList.contains('hidden'), false);
  assert.equal(context.CN.bookPane.state.toc.length, 1);
  assert.ok(context.CN.bookPane.state.sections[2]);
  assert.equal(context.CN.bookPane.state.sections[2].ref, 'פרק א פסוק 3');

  // Verify findNormalizedSpan maps queries across niqqud and newlines accurately
  const rawHebrew = 'בְּרֵאשִׁית\n   בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם';
  const span = context.CN.bookPane.findNormalizedSpan(rawHebrew, 'בראשית ברא אלהים');
  assert.ok(span, 'expected span match across niqqud and newline');
  assert.equal(rawHebrew.slice(span.start, span.end), 'בְּרֵאשִׁית\n   בָּרָא אֱלֹהִים');
});

test('Client dynamic context submenu & split toolbar builder (CN.menus)', async () => {
  const { context } = loadPluginModules();
  vm.runInContext(fs.readFileSync(path.join(pluginDir, 'js/menus.js'), 'utf8'), context, { filename: 'js/menus.js' });

  const sampleNotes = [
    { id: 'n-low', status: 'published', tier: 'low', kind: 'note', authorName: 'בדיקה', quote: 'יהי אור', body: 'לא צריך להופיע', upCount: 0 },
    { id: 'n-hidden', status: 'hidden', tier: 'normal', kind: 'note', authorName: 'בדיקה', quote: 'יהי אור', body: 'מוסתר', upCount: 5 },
    { id: 'n-other', status: 'published', tier: 'recommended', kind: 'note', authorName: 'רב א', quote: 'בראשית ברא', body: 'פירוש כללי על התחלת הפרשה', upCount: 20 },
    { id: 'n-q', status: 'published', tier: 'normal', kind: 'question', authorName: 'שואל', quote: 'יהי אור', body: 'מדוע נכפל ויהי אור בפרשה זו ובמה מדובר באריכות רבה מאוד שצריכה קיצור בטקסט התפריט העמוס', upCount: 2 },
    { id: 'n-match', status: 'published', tier: 'normal', kind: 'note', authorName: 'משה', quote: 'יְהִי אוֹר', body: 'ביאור ממוקד על הבחירה', upCount: 5 },
  ];

  const built = context.CN.menus.buildPreviewItems(sampleNotes, 'יהי אור');
  assert.equal(built.totalCount, 3);
  assert.equal(built.matchedCount, 2);
  assert.equal(built.items.length, 3);
  assert.ok(built.items[0].matched);
  assert.ok(built.items[1].matched);
  assert.equal(built.items[2].note.id, 'n-other');
  assert.ok(built.items[0].label.startsWith('★ '));
  assert.ok(built.items[1].label.startsWith('❓ '));
  assert.ok(built.items[1].label.length <= 78);
  assert.ok(built.items[1].label.endsWith('...'));

  const calls = [];
  let rejectedReaderBookOnce = false;
  context.Otzaria.call = async (method, payload) => {
    if (method === 'reader.addContextMenuItem' && Array.isArray(payload.contexts) && payload.contexts.includes('reader-book') && !rejectedReaderBookOnce) {
      rejectedReaderBookOnce = true;
      throw new Error('unsupported_context');
    }
    calls.push({ method, payload });
    return { success: true };
  };

  await context.CN.menus.syncMenusForSection({
    notes: sampleNotes,
    selectedText: 'יהי אור',
    permissions: ['reader.context_menu', 'reader.toolbar'],
  });

  const ctxCall = calls.find((c) => c.method === 'reader.addContextMenuItem');
  assert.ok(ctxCall, 'expected context menu registration after fallback');
  assert.deepEqual(Array.from(ctxCall.payload.contexts), ['reader-selection', 'reader-highlight']);
  assert.equal(ctxCall.payload.type, 'submenu');
  assert.ok(ctxCall.payload.title.includes('2 על הבחירה'));
  assert.equal(ctxCall.payload.children[0].id, 'show-notes-open-all');
  assert.equal(ctxCall.payload.children[1].type, 'separator');
  // Each note entry defaults to a cascaded submenu showing full note lines
  const firstNoteItem = ctxCall.payload.children[2];
  assert.equal(firstNoteItem.type, 'submenu');
  assert.equal(firstNoteItem.param.action, 'open-thread');
  assert.equal(firstNoteItem.param.rootId, 'n-match');
  assert.ok(firstNoteItem.children.some((c) => String(c.title).includes('ביאור ממוקד על הבחירה')));
  assert.ok(ctxCall.payload.children[3].children.some((c) => String(c.title).includes('בטקסט התפריט העמוס')));

  const tbCall = calls.find((c) => c.method === 'reader.addToolbarItem');
  assert.ok(tbCall, 'expected toolbar registration');
  assert.equal(tbCall.payload.type, 'split');
  assert.equal(tbCall.payload.children[0].param.action, 'open-all');
  assert.equal(tbCall.payload.children[1].param.action, 'open-thread');

  // Overflow pagination & compact mode check
  const manyNotes = Array.from({ length: 15 }, (_, idx) => ({
    id: 'n-many-' + idx,
    status: 'published',
    tier: 'normal',
    kind: 'note',
    authorName: 'לומד ' + idx,
    body: 'תוכן מלא של הערה מספר ' + idx + ' לבדיקת תת תפריט עוד הערות',
    upCount: 1,
  }));
  calls.length = 0;
  await context.CN.menus.syncMenusForSection({
    notes: manyNotes,
    selectedText: '',
    permissions: ['reader.context_menu'],
    settings: { contextMenuFullSubmenus: true, contextMenuMaxNotes: 12 },
  });
  const overflowCtx = calls.find((c) => c.method === 'reader.addContextMenuItem').payload;
  const moreMenu = overflowCtx.children.find((c) => c.id === 'cn-note-more');
  assert.ok(moreMenu, 'expected overflow submenu for >12 notes');
  assert.equal(moreMenu.type, 'submenu');
  assert.ok(moreMenu.title.includes('(3)'));

  calls.length = 0;
  await context.CN.menus.syncMenusForSection({
    notes: [],
    selectedText: '',
    permissions: ['reader.context_menu', 'reader.toolbar'],
  });
  assert.equal(calls.find((c) => c.method === 'reader.addContextMenuItem').payload.type, 'item');
  assert.equal(calls.find((c) => c.method === 'reader.addToolbarItem').payload.type, 'button');
});

test('Client Daily Study & Priority Books sync target parsing and prefetching (CN.sync)', async () => {
  const { context } = loadPluginModules();
  vm.runInContext(fs.readFileSync(path.join(pluginDir, 'js/api.js'), 'utf8'), context, { filename: 'js/api.js' });
  vm.runInContext(fs.readFileSync(path.join(pluginDir, 'js/sync.js'), 'utf8'), context, { filename: 'js/sync.js' });

  const settings = context.CN.storage.defaultSettings();
  settings.priorityBooks = ['מסילת ישרים'];
  const targets = Array.from(context.CN.sync.parseDailyStudyTargetsFromCalendar(
    { dafYomi: 'ברכות דף ב', parasha: 'פרשת ויצא' },
    [],
    settings
  ));
  assert.ok(targets.some((t) => t.source === 'dafYomi' && t.bookQuery === 'ברכות' && t.refHint === 'ב'));
  assert.ok(targets.some((t) => t.source === 'parasha' && t.bookQuery === 'בראשית' && t.refHint === 'ויצא'));
  assert.ok(targets.some((t) => t.source === 'custom' && t.bookQuery === 'מסילת ישרים'));

  const priMatch = context.CN.sync.isBookPriority('מסכת ברכות', 'id:10', settings, targets);
  assert.equal(priMatch.isPriority, true);
  assert.equal(context.CN.sync.getEffectiveRefreshIntervalMs('ברכות', 'id:10', settings, targets), 60000);
  assert.equal(context.CN.sync.getEffectiveRefreshIntervalMs('רמב"ן על התורה', 'id:99', settings, targets), 180000);

  // End-to-end priority prefetch populates local section cache
  context.CN.state.isOnline = true;
  context.Otzaria.call = async (method, payload) => {
    if (method === 'storage.get') return { success: true, data: context._storage ? context._storage.get(payload.key) ?? null : null };
    if (method === 'calendar.getJewishDate') return { success: true, data: { dafYomi: 'ברכות דף ב' } };
    if (method === 'calendar.getEvents') return { success: true, data: [] };
    if (method === 'library.findBooks') return { success: true, data: [{ id: 10, title: 'ברכות', bookId: 'ברכות' }] };
    return { success: true, data: null };
  };
  const origCall = context.Otzaria.call;
  const mockStore = new Map();
  context.CN.storage.get = async (k, fb) => (mockStore.has(k) ? mockStore.get(k) : fb);
  context.CN.storage.set = async (k, v) => { mockStore.set(k, v); return true; };
  context.CN.storage.putCachedSectionNotes = async (bUid, rName, items) => {
    mockStore.set('cached:' + bUid + '::' + rName, { savedAt: Date.now(), items });
  };
  context.CN.storage.getCachedSectionNotes = async (bUid, rName) => mockStore.get('cached:' + bUid + '::' + rName) || null;
  context.Otzaria.call = origCall;
  context.CN.api.request = async (method, pathQ) => {
    if (pathQ === '/v1/books/id%3A10/index') {
      return { ok: true, status: 200, data: { refs: { 'דף ב': { notes: 2, questions: 0 } } } };
    }
    if (pathQ.indexOf('/v1/books/id%3A10/notes') === 0) {
      return { ok: true, status: 200, data: { items: [{ id: 'prefetched-1', body: 'פירוש בדף היומי' }] } };
    }
    return { ok: false, status: 404, data: null };
  };

  const syncMeta = await context.CN.sync.syncPriorityBooksIfDue({
    force: true,
    settings,
    permissions: ['calendar.read', 'library.books.read'],
  });
  assert.ok(syncMeta.booksSynced >= 1);
  assert.ok(syncMeta.sectionsCached >= 1);
  assert.equal(mockStore.get('cached:id:10::דף ב').items[0].id, 'prefetched-1');
});
