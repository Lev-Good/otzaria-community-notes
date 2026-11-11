# תוסף "הערות הקהילה" לאוצריא (גרסה 2)

מימוש מלא של תוסף **הערות הקהילה** לאוצריא ושל השרת הקהילתי החינמי (Cloudflare Worker + D1 + Cron גיבוי יומי ל-GitHub).

## מבנה הפרויקט

- `plugin/` — תוסף אוצריא המלא (HTML/CSS/JS ללא תלויות חיצוניות, RTL, Material Design 3, תואם CSP ומסונכרן עם ה-theme של אוצריא):
  - `manifest.json` — תצהיר הרשאות מדויק (ללא baseline מיותרות), פקד סרגל, תפריטי הקשר, קיצור `Ctrl+Alt+N`, ומנוע רקע עצל.
  - `index.html` — מסכי התוסף: `בקטע`, `שאלות`, `שלי`, `הודעות`, `בית`, `שרשור`, `כתיבה/עריכה`, `לוח מודרטורים`, ופאנל `הגדרות` צף.
  - `background.html` — מנוע רקע עצל לבדיקת התראות בעליית אוצריא ובמעבר מקטעים (במכבד שבת/חג) וסימון ציטוטים בטקסט הראשי.
  - `i18n/en.js` — תמיכה בריבוי־לשוני לפי מדריך אוצריא.
- `worker/` — שרת Cloudflare Worker + D1:
  - `migrations/0001_initial.sql` — סכמת D1 ואינדקסים מלאים.
  - `src/auth.js` — אימות חתימות ECDSA P-256, הגנת Anti-Replay (`seq`), אתגר חישובי Proof of Work, וקודי שחזור.
  - `src/moderation.js` — אימות מבנה, קישורים (`otzaria://open/book` בלבד), מילון עברי מנורמל $O(1)$ בשתי רמות, ריכוך לפי הקשר הציטוט, ואופציונלי Workers AI מייעץ.
  - `src/ranking.js` — חישוב חסם תחתון של Wilson (95%), חישוב `tier`, קידום/הורדת רמות אמון, והגנות אנטי-מניפולציה.
  - `src/backup.js` — Cron יומי לגיבוי JSON לכל ספר למאגר GitHub ציבורי + ניקוי הודעות מעל 60 יום.
- `scripts/` — כלי פיתוח, ולידציה, אריזה ל־`.otzplugin` ושרת פיתוח מקומי מעל SQLite.
- `tests/` — בדיקות אינטגרציה ויחידה לשרת וללקוח.

## בדיקות, ולידציה ואריזה

```bash
# הרצת כל הבדיקות, בדיקת הולידטור הרשמי של אוצריא, ובניית קובץ ההתקנה
npm test

# ולידציה בלבד
npm run validate

# אריזה ל-dist/community-notes.otzplugin
npm run pack
```

## הפעלה מקומית לפיתוח ובדיקה (בלי חשבון Cloudflare)

1. הפעל שרת מקומי של ה־Worker על גבי SQLite מובנה ב-Node:
   ```bash
   npm run dev:worker
   ```
   השרת רץ על `http://127.0.0.1:8787` ומאתחל אוטומטית את קודי ההזמנה `OTZ-BETA-2026` (משתמש פעיל) ו־`OTZ-MOD-2026` (מודרטור).
2. לפריסה מקומית באוצריא לפני מיזוג Allowlist ב־GitHub, הוסף בהגדרות המתקדמות של התוסף את הכתובת `http://127.0.0.1:8787` (ובגרסת פיתוח של המניפסט החלף את `network.access` ל־`network.localhost`).

## פריסה ל-Cloudflare Workers + D1

```bash
cd worker
npx wrangler d1 create otzaria-community-notes
# הדבק את database_id ב-worker/wrangler.toml
npx wrangler d1 migrations apply otzaria-community-notes --remote
npx wrangler secret put CHALLENGE_SECRET
npx wrangler secret put ADMIN_BOOTSTRAP_SECRET
# אופציונלי לגיבוי היומי ל-GitHub:
npx wrangler secret put GITHUB_BACKUP_TOKEN
npx wrangler deploy
```

לאחר הפריסה:
1. עדכן את כתובת ה־Worker ב־`plugin/manifest.json` (`network.allowlist`) וב־`plugin/js/config.js` (`DEFAULT_API_BASE`).
2. הרץ `npm test` כדי להפיק `dist/community-notes.otzplugin` מעודכן.
3. צור הזמנות בטא ומודרטור ראשון דרך `POST /v1/mod/invites` עם הכותרת `X-Admin-Secret`.
4. פתח PR להיתר הרשת של אוצריא לפי `docs/ALLOWLIST_PR_GUIDE.md`.
