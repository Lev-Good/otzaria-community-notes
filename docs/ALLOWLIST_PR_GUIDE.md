# מדריך פתיחת PR להיתר הרשת של אוצריא (שלב 0)

לפי קוד אוצריא (`lib/plugins/models/plugin_network_allowlist.dart`), בקשות HTTP מהתוסף דרך `network.fetchStream` מותרות רק אם הדומיין מופיע בשני מקומות:
1. במניפסט של התוסף (`plugin/manifest.json` תחת `network.allowlist`).
2. בקובץ `plugin_network_allowlist.txt` בשורש הריפו הרשמי `Otzaria/otzaria` בענף `dev`.

> מרגע שה־PR מתמזג לענף `dev`, האישור נכנס לתוקף אצל כל משתמשי אוצריא באופן מיידי בלי להמתין לגרסה חדשה של האפליקציה.

## צעדים לביצוע
1. פרוס תחילה את ה־Worker של Cloudflare כדי לקבל את הכתובת הקבועה (למשל `https://community-notes.<account>.workers.dev` או דומיין ייעודי שעבר סינון נטפרי/אתרוג/רימון).
2. עדכן את אותה כתובת בדיוק ב:
   - `plugin/manifest.json` -> `network.allowlist`
   - `plugin/js/config.js` -> `DEFAULT_API_BASE`
3. צור Fork של `https://github.com/Otzaria/otzaria`, הוסף בסוף הקובץ `plugin_network_allowlist.txt` (ללא `/` בסוף!):

```text
# תוסף הערות הקהילה (community-notes)
https://community-notes.<account>.workers.dev
```

4. פתח Pull Request לענף `dev` עם הסבר קצר:
   - מזהה התוסף: `community-notes`
   - שימוש בשרת: קריאה וכתיבה של הערות, שאלות ותשובות קהילתיות, תיבת הודעות ומודרציה דרך Cloudflare Worker + D1.
   - כל הבקשות נשלחות טקסטואלית דרך `network.fetchStream` ללא העלאת נתוני קריאה פרטיים של המשתמש.

## פנייה מוקדמת למסנני רשת (נטפרי / רימון / אתרוג)
במקביל לפתיחת ה־PR, שלח פנייה לפתיחת הדומיין הספציפי (או שקול להצמיד דומיין ייעודי ל־Worker ב־Cloudflare Custom Domains כדי שפתיחתו לא תהיה תלויה בהיתר גורף של `*.workers.dev`).
