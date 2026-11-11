(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  var NIKUD_TEAMIM_RE = /[\u0591-\u05C7]/g;
  var FINAL_MAP = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
  var CONFUSABLE_MAP = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

  var OTZARIA_BOOK_LINK_RE = /^otzaria:\/\/open\/book\/[^\s<>"'`]+$/i;
  var ANY_OTZARIA_LINK_RE = /otzaria:\/\/[^\s<>"'`]*/gi;
  var EXTERNAL_URL_RE = /(?:https?:\/\/|ftp:\/\/|www\.)[^\s]+|\b[a-z0-9-]{2,}\.(?:com|net|org|co\.il|org\.il|il|io|dev|xyz|info|biz)\b/i;
  var EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
  var PHONE_RE = /(?:\+972|0)[-\s]?(?:[23489]|5\d|7\d)[-\s]?\d{3}[-\s]?\d{4}/;
  var HTML_TAG_RE = /<\/?[a-z][a-z0-9-]*(?:\s+[^>]*)?>/i;
  var SPAM_REPEAT_CHAR_RE = /(.)\1{7,}/;

  function normalizeText(text) {
    var s = String(text || '').toLowerCase();
    s = s.replace(NIKUD_TEAMIM_RE, '');
    s = s.replace(/[ךםןףץ]/g, function (ch) { return FINAL_MAP[ch] || ch; });
    s = s.replace(/([א-תa-z0-9])[._\-*'"״׳/\\|+~`]+(?=[א-תa-z0-9])/g, '$1');
    s = s.replace(/[013457@$!]/g, function (ch) { return CONFUSABLE_MAP[ch] || ch; });
    s = s.replace(/([א-תa-z])\1+/g, '$1');
    return s;
  }

  function extractTokens(text) {
    var norm = normalizeText(text);
    var words = norm.split(/[^א-תa-z0-9]+/).filter(Boolean);
    var set = {};
    var singleRun = '';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      set[w] = true;
      if (w.length === 1) {
        singleRun += w;
      } else {
        if (singleRun.length >= 3) set[singleRun] = true;
        singleRun = '';
      }
      if (i < words.length - 1) set[w + words[i + 1]] = true;
    }
    if (singleRun.length >= 3) set[singleRun] = true;
    return set;
  }

  var BLOCK_TERMS = [
    'זונה', 'שרמוטה', 'מזדיין', 'כוסאמק', 'בן זונה', 'מטומטם', 'אידיוט', 'חמור', 'בהמה',
    'fuck', 'shit', 'bitch', 'asshole', 'פורנו', 'סקס', 'אונס', 'porn',
    'להרוג', 'לרצוח', 'פיגוע', 'ישוע המשיח', 'הברית החדשה', 'יהודים למען ישו'
  ];
  var SOFT_TERMS = [
    'ממזר', 'ערווה', 'זנות', 'ניאוף', 'משכב', 'שכבת זרע', 'אפיקורוס', 'כופר',
    'עבודה זרה', 'נוצרי', 'כפירה', 'מינות', 'מיסיון',
    'פוליטיקה', 'בחירות', 'ממשלה', 'קנה עכשיו', 'מבצע', 'הנחה'
  ];

  var BLOCK_SET = {};
  var SOFT_SET = {};
  for (var b = 0; b < BLOCK_TERMS.length; b++) {
    BLOCK_SET[normalizeText(BLOCK_TERMS[b]).replace(/\s+/g, '')] = true;
  }
  for (var s = 0; s < SOFT_TERMS.length; s++) {
    SOFT_SET[normalizeText(SOFT_TERMS[s]).replace(/\s+/g, '')] = true;
  }

  function validateLiveBody(rawBody, quoteText) {
    var body = String(rawBody || '').replace(/\r\n/g, '\n').trim();
    if (body.length < 10) {
      return { valid: false, level: 'error', message: 'כתוב לפחות 10 תווים' };
    }
    if (body.length > 2000) {
      return { valid: false, level: 'error', message: 'הטקסט חורג ממגבלת 2,000 תווים' };
    }
    if (HTML_TAG_RE.test(body)) {
      return { valid: false, level: 'error', message: 'טקסט פשוט בלבד, ללא תגיות HTML' };
    }
    var otzLinks = body.match(ANY_OTZARIA_LINK_RE) || [];
    for (var i = 0; i < otzLinks.length; i++) {
      if (!OTZARIA_BOOK_LINK_RE.test(otzLinks[i])) {
        return { valid: false, level: 'error', message: 'קישורים מותרים רק אל ספרים באוצריא (otzaria://open/book/...)' };
      }
    }
    var withoutAllowed = body.replace(ANY_OTZARIA_LINK_RE, ' ');
    if (EXTERNAL_URL_RE.test(withoutAllowed)) {
      return { valid: false, level: 'error', message: 'קישורים חיצוניים אינם מותרים, אפשר להוסיף קישור לספר באוצריא' };
    }
    if (EMAIL_RE.test(body) || PHONE_RE.test(body)) {
      return { valid: false, level: 'error', message: 'כתובות דוא״ל ומספרי טלפון אינם מותרים' };
    }
    if (SPAM_REPEAT_CHAR_RE.test(body)) {
      return { valid: false, level: 'error', message: 'נראה שיש חזרה מרובה של תווים, נסח מחדש' };
    }

    var bodyTokens = extractTokens(body);
    var quoteTokens = quoteText ? extractTokens(quoteText) : {};
    var keys = Object.keys(bodyTokens);
    for (var k = 0; k < keys.length; k++) {
      var tok = keys[k];
      if (BLOCK_SET[tok] && !quoteTokens[tok]) {
        return {
          valid: false,
          level: 'error',
          message: 'נראה שיש כאן ביטוי שאינו מתאים להערות הקהילה, נסח מחדש',
        };
      }
      if (SOFT_SET[tok] || (BLOCK_SET[tok] && quoteTokens[tok])) {
        return {
          valid: true,
          level: 'warning',
          message: 'הטקסט כולל מונח רגיש וייתכן שייבדק על ידי מודרטור לפני פרסום',
        };
      }
    }

    return { valid: true, level: 'ok', message: '' };
  }

  function containsHiddenWord(text, hiddenWords) {
    if (!hiddenWords || hiddenWords.length === 0) return false;
    var normBody = normalizeText(text);
    for (var i = 0; i < hiddenWords.length; i++) {
      var w = normalizeText(hiddenWords[i]).trim();
      if (w && normBody.indexOf(w) !== -1) return true;
    }
    return false;
  }

  CN.filter = {
    normalizeText: normalizeText,
    validateLiveBody: validateLiveBody,
    containsHiddenWord: containsHiddenWord,
    OTZARIA_BOOK_LINK_RE: OTZARIA_BOOK_LINK_RE,
  };
})(typeof window !== 'undefined' ? window : globalThis);
