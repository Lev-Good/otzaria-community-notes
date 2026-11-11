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
        const node = {
          tagName: tag.toUpperCase(),
          className: '',
          textContent: '',
          attrs: {},
          children: [],
          setAttribute(k, v) { this.attrs[k] = v; },
          addEventListener() {},
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
    'js/highlights.js',
    'js/ui-cards.js',
    'js/ui-composer.js',
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
  assert.ok(context.CN.highlights.syncSectionHighlights);
  assert.ok(context.CN.cards.buildNoteCard);
  assert.ok(context.CN.composer.renderComposer);
  assert.ok(context.CN.onboarding.ensureRegistered);
  assert.ok(context.CN.settingsUi.openSettingsPanel);
  assert.ok(context.CN.modUi.renderModPanel);
  assert.ok(context.CN.app.navigate);
});
