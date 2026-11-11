/**
 * Hebrew & structural moderation engine for Otzaria Community Notes.
 * Runs in O(tokens) using pre-normalized Set lookups for Workers CPU budget (<10ms).
 */

const NIKUD_TEAMIM_RE = /[\u0591-\u05C7]/g;
const FINAL_MAP = {
  'ך': 'כ',
  'ם': 'מ',
  'ן': 'נ',
  'ף': 'פ',
  'ץ': 'צ',
};

const CONFUSABLE_MAP = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  '$': 's',
  '!': 'i',
  'vv': 'w',
};

const OTZARIA_BOOK_LINK_RE = /^otzaria:\/\/open\/book\/[^\s<>"'`]+$/i;
const ANY_OTZARIA_LINK_RE = /otzaria:\/\/[^\s<>"'`]*/gi;
const EXTERNAL_URL_RE = /(?:https?:\/\/|ftp:\/\/|www\.)[^\s]+|\b[a-z0-9-]{2,}\.(?:com|net|org|co\.il|org\.il|il|io|dev|xyz|info|biz)\b/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /(?:\+972|0)[-\s]?(?:[23489]|5\d|7\d)[-\s]?\d{3}[-\s]?\d{4}/;
const HTML_TAG_RE = /<\/?[a-z][a-z0-9-]*(?:\s+[^>]*)?>/i;
const SPAM_REPEAT_CHAR_RE = /(.)\1{7,}/u;

/**
 * Normalize a Hebrew/Latin text snippet for dictionary matching.
 */
export function normalizeForDictionary(text) {
  let s = String(text || '').toLowerCase();
  s = s.replace(NIKUD_TEAMIM_RE, '');
  // Replace final letters
  s = s.replace(/[ךםןףץ]/g, (ch) => FINAL_MAP[ch] || ch);
  // Replace separators inserted inside words (e.g., מ.י.ל.ה or מ-י-ל-ה)
  s = s.replace(/([א-תa-z0-9])[._\-*'"״׳/\\|+~`]+(?=[א-תa-z0-9])/g, '$1');
  // Replace basic confusable ASCII digits/symbols when mixed with Latin
  s = s.replace(/[013457@$!]/g, (ch) => CONFUSABLE_MAP[ch] || ch);
  // Collapse consecutive duplicate letters (כפל אותיות)
  s = s.replace(/([א-תa-z])\1+/g, '$1');
  return s;
}

/**
 * Tokenize normalized text into words + sliding merged bigrams (catches spaced-out evasions like "מ י ל ה").
 */
export function extractNormalizedTokens(text) {
  const norm = normalizeForDictionary(text);
  const words = norm.split(/[^א-תa-z0-9]+/).filter(Boolean);
  const tokens = new Set(words);

  // Merge runs of single-letter tokens (evasion like "ז ו נ ה")
  let singleRun = '';
  for (const w of words) {
    if (w.length === 1) {
      singleRun += w;
    } else {
      if (singleRun.length >= 3) tokens.add(singleRun);
      singleRun = '';
    }
  }
  if (singleRun.length >= 3) tokens.add(singleRun);

  // Also add concatenated adjacent pairs
  for (let i = 0; i < words.length - 1; i++) {
    tokens.add(words[i] + words[i + 1]);
  }
  return tokens;
}

// Raw dictionary terms — normalized once at module load into Sets.
// Category labels are shown to the author without ever revealing the specific matched word.
const RAW_BLOCK_TERMS = [
  // גידופים וניבול פה
  ['זונה', 'ביטוי לא ראוי'],
  ['שרמוטה', 'ביטוי לא ראוי'],
  ['מזדיין', 'ביטוי לא ראוי'],
  ['כוסאמק', 'ביטוי לא ראוי'],
  ['בן זונה', 'ביטוי לא ראוי'],
  ['מטומטם', 'גידוף או זלזול'],
  ['אידיוט', 'גידוף או זלזול'],
  ['חמור', 'גידוף או זלזול'],
  ['בהמה', 'גידוף או זלזול'],
  ['fuck', 'ביטוי לא ראוי'],
  ['shit', 'ביטוי לא ראוי'],
  ['bitch', 'ביטוי לא ראוי'],
  ['asshole', 'ביטוי לא ראוי'],
  // תוכן מיני מפורש
  ['פורנו', 'תוכן מיני מפורש'],
  ['סקס', 'תוכן מיני מפורש'],
  ['אונס', 'תוכן אלים או מיני'],
  ['porn', 'תוכן מיני מפורש'],
  // הסתה / אלימות
  ['להרוג', 'הסתה או אלימות'],
  ['לרצוח', 'הסתה או אלימות'],
  ['פיגוע', 'הסתה או אלימות'],
  ['מוות ל', 'הסתה או אלימות'],
  // הטפה למיסיון
  ['ישוע המשיח', 'הטפה דתית'],
  ['הברית החדשה', 'הטפה דתית'],
  ['יהודים למען ישו', 'הטפה דתית'],
];

const RAW_SOFT_TERMS = [
  // מונחים שיכולים להופיע בדיון הלכתי/תלמודי לגיטימי -> לתור המודרטורים בלבד
  ['ממזר', 'מונח רגיש לבדיקה'],
  ['ערווה', 'מונח רגיש לבדיקה'],
  ['זנות', 'מונח רגיש לבדיקה'],
  ['ניאוף', 'מונח רגיש לבדיקה'],
  ['משכב', 'מונח רגיש לבדיקה'],
  ['שכבת זרע', 'מונח רגיש לבדיקה'],
  ['אפיקורוס', 'מונח רגיש לבדיקה'],
  ['כופר', 'מונח רגיש לבדיקה'],
  ['עבודה זרה', 'מונח רגיש לבדיקה'],
  ['נוצרי', 'מונח רגיש לבדיקה'],
  ['כפירה', 'מונח רגיש לבדיקה'],
  ['מינות', 'מונח רגיש לבדיקה'],
  ['מיסיון', 'מונח רגיש לבדיקה'],
  ['פוליטיקה', 'נושא שעלול להיות חוץ-תורני'],
  ['בחירות', 'נושא שעלול להיות חוץ-תורני'],
  ['ממשלה', 'נושא שעלול להיות חוץ-תורני'],
  ['קנה עכשיו', 'חשד לתוכן מסחרי'],
  ['מבצע', 'חשד לתוכן מסחרי'],
  ['הנחה', 'חשד לתוכן מסחרי'],
];

const BLOCK_MAP = new Map();
for (const [term, cat] of RAW_BLOCK_TERMS) {
  BLOCK_MAP.set(normalizeForDictionary(term).replace(/\s+/g, ''), cat);
}

const SOFT_MAP = new Map();
for (const [term, cat] of RAW_SOFT_TERMS) {
  SOFT_MAP.set(normalizeForDictionary(term).replace(/\s+/g, ''), cat);
}

const RESERVED_TITLES_NORMALIZED = new Set(
  ['הרב', 'רב', 'רבי', 'אדמור', 'פרופ', 'פרופסור', 'דוקטור', 'דר', 'מודרטור', 'מנהל', 'צוות', 'admin', 'moderator', 'staff']
    .map((t) => normalizeForDictionary(t))
);

/**
 * Validate display name at registration / rename.
 */
export function validateDisplayName(rawName, { allowTitles = false } = {}) {
  const name = String(rawName || '').trim();
  const strippedLen = normalizeForDictionary(name).replace(/[^א-תa-z0-9]/g, '').length;
  if (name.length < 3 || name.length > 20 || strippedLen < 3) {
    return { ok: false, code: 'INVALID_NAME_LENGTH', message: 'שם התצוגה חייב להכיל 3 עד 20 תווים' };
  }
  if (HTML_TAG_RE.test(name) || /[\r\n\t]/.test(name)) {
    return { ok: false, code: 'INVALID_NAME_CHARS', message: 'שם התצוגה מכיל תווים לא מותרים' };
  }
  const tokens = extractNormalizedTokens(name);
  for (const tok of tokens) {
    if (BLOCK_MAP.has(tok)) {
      return { ok: false, code: 'NAME_BLOCKED', message: 'שם התצוגה אינו מתאים לכללי הקהילה' };
    }
    if (!allowTitles && RESERVED_TITLES_NORMALIZED.has(tok)) {
      return { ok: false, code: 'NAME_TITLE_RESERVED', message: 'לא ניתן להשתמש בתואר שמור בשם התצוגה ללא אימות' };
    }
  }
  return { ok: true, name };
}

/**
 * Validate structure & safety rules of note/question/answer/reply body.
 */
export function validateStructure(rawBody) {
  const body = String(rawBody || '').replace(/\r\n/g, '\n').trim();
  if (body.length < 10) {
    return { ok: false, code: 'TOO_SHORT', message: 'כתוב לפחות 10 תווים' };
  }
  if (body.length > 2000) {
    return { ok: false, code: 'TOO_LONG', message: 'הטקסט חורג ממגבלת 2,000 תווים' };
  }
  if (HTML_TAG_RE.test(body)) {
    return { ok: false, code: 'HTML_FORBIDDEN', message: 'טקסט פשוט בלבד, ללא תגיות HTML' };
  }
  // Check otzaria:// links carefully: allow ONLY otzaria://open/book/...
  const otzariaLinks = body.match(ANY_OTZARIA_LINK_RE) || [];
  for (const link of otzariaLinks) {
    if (!OTZARIA_BOOK_LINK_RE.test(link)) {
      return {
        ok: false,
        code: 'FORBIDDEN_OTZARIA_LINK',
        message: 'קישורים מותרים רק אל ספרים באוצריא (otzaria://open/book/...)',
      };
    }
  }
  // Strip allowed otzaria://open/book/... before testing external URLs
  const withoutAllowedLinks = body.replace(ANY_OTZARIA_LINK_RE, ' ');
  if (EXTERNAL_URL_RE.test(withoutAllowedLinks)) {
    return {
      ok: false,
      code: 'EXTERNAL_LINK_FORBIDDEN',
      message: 'קישורים חיצוניים אינם מותרים, אפשר להוסיף קישור לספר באוצריא',
    };
  }
  if (EMAIL_RE.test(body) || PHONE_RE.test(body)) {
    return {
      ok: false,
      code: 'CONTACT_FORBIDDEN',
      message: 'כתובות דוא״ל ומספרי טלפון אינם מותרים',
    };
  }
  if (SPAM_REPEAT_CHAR_RE.test(body)) {
    return {
      ok: false,
      code: 'SPAM_REPETITION',
      message: 'נראה שיש חזרה מרובה של תווים, נסח מחדש',
    };
  }
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 5) {
    const uniqueLines = new Set(lines);
    if (uniqueLines.size <= Math.floor(lines.length / 3)) {
      return {
        ok: false,
        code: 'SPAM_LINES',
        message: 'נראה שיש חזרה מרובה של שורות, נסח מחדש',
      };
    }
  }
  return { ok: true, body };
}

/**
 * Run structural + dictionary + quote-context mitigation.
 * Returns { action: 'pass' | 'pending' | 'reject', category?: string, riskScore: number, softFlags: string[] }
 */
export function evaluateContent(body, quote = '') {
  const struct = validateStructure(body);
  if (!struct.ok) {
    return {
      ok: false,
      action: 'invalid',
      code: struct.code,
      message: struct.message,
      riskScore: 0,
      softFlags: [],
    };
  }

  const bodyTokens = extractNormalizedTokens(struct.body);
  const quoteTokens = quote ? extractNormalizedTokens(quote) : new Set();

  let blockCategory = null;
  const softFlags = [];

  for (const tok of bodyTokens) {
    if (BLOCK_MAP.has(tok)) {
      const cat = BLOCK_MAP.get(tok);
      // Context mitigation: if the exact normalized term appears in the quoted source text,
      // downgrade hard block to soft flag for human review.
      if (quoteTokens.has(tok)) {
        softFlags.push(`${cat} (ממקור מצוטט)`);
      } else {
        blockCategory = cat;
        break;
      }
    } else if (SOFT_MAP.has(tok)) {
      softFlags.push(SOFT_MAP.get(tok));
    }
  }

  if (blockCategory) {
    return {
      ok: true,
      body: struct.body,
      action: 'reject',
      category: blockCategory,
      riskScore: 100,
      softFlags,
    };
  }

  if (softFlags.length > 0) {
    return {
      ok: true,
      body: struct.body,
      action: 'pending',
      category: softFlags[0],
      riskScore: 50 + Math.min(30, softFlags.length * 10),
      softFlags: [...new Set(softFlags)],
    };
  }

  return {
    ok: true,
    body: struct.body,
    action: 'pass',
    category: null,
    riskScore: 10,
    softFlags: [],
  };
}

/**
 * Optional Workers AI advisory classification (never auto-rejects, only routes to pending queue).
 */
export async function runAdvisoryAiModeration(env, body, quote) {
  if (!env?.AI || env.AI_MODERATION_ENABLED !== 'true') {
    return { flags: [], riskDelta: 0 };
  }
  try {
    const prompt = [
      'Classify this Hebrew Jewish-study community note into JSON {"flags": string[]} with any of:',
      'off_topic, political_personal, commercial, offensive. Return {"flags":[]} if clean.',
      quote ? `Quote: ${quote.slice(0, 150)}` : '',
      `Note: ${body.slice(0, 600)}`,
    ].filter(Boolean).join('\n');

    const res = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 60,
    });
    const text = res?.response || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { flags: [], riskDelta: 0 };
    const parsed = JSON.parse(match[0]);
    const valid = ['off_topic', 'political_personal', 'commercial', 'offensive'];
    const flags = Array.isArray(parsed.flags) ? parsed.flags.filter((f) => valid.includes(f)) : [];
    return { flags, riskDelta: flags.length > 0 ? 35 : 0 };
  } catch {
    return { flags: [], riskDelta: 0 };
  }
}
