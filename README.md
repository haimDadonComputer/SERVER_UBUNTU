# Ubuntu Control

מערכת ניהול שרת Ubuntu 24.04 דרך הדפדפן, בעברית וב־RTL. React + TypeScript, Express, SQLite, WebSocket ו־helper מקומי נפרד לפעולות מערכת. אין נתוני דמה במוצר.

לפריסה על שרת ראו **[INSTALL.md](INSTALL.md)**. ההתקנה מאזינה ל־localhost בלבד ואינה משנה את חומת האש או מפרסמת את הממשק.

## יכולות

- מנהל ראשוני ב־CLI בלבד, Argon2id, Sessions במסד הנתונים, Cookie מאובטח, CSRF, הגבלת ניסיונות, TOTP עם מניעת שימוש חוזר בקוד, ניתוק לאחר 15 דקות ללא פעילות ויומן פעולות.
- ניטור CPU, RAM, דיסק, רשת ו־uptime; מידע מ־`ss` ו־systemd; זיהוי Docker ו־PM2 (PM2 דורש הגדרה).
- רשימת פורטים חיה, חיפוש וסינון, שיוך שירותים, פעולות שירות מאושרות ולוגים לקריאה בלבד. שירות שאינו ברשימת ההרשאות אינו ניתן להפעלה או לעצירה.
- UFW ו־Hetzner API, תמיכה ב־IPv4/IPv6 ו־CIDR, חסימת שינוי פורטים רגישים, צילום מצב ושחזור אוטומטי אחרי 120 שניות ללא אישור. שינויי ענן מותרים רק לחומת אש ייעודית עם תווית מתאימה. נגישות חיצונית לא מוסקת מתוך כללי Firewall.
- יצירה ופתיחה של כמה תיקיות פרויקט ישירות מהאתר תחת `/srv/ubuntu-projects`, בלי להוסיף כל פרויקט ל־helper.json. אפשר לציין מאגר GitHub ולשייך שירות קיים. Deploy Key למאגר פרטי, סקירת עדכונים לפני פריסה, גרסאות באמצעות Git worktrees, הרצת npm/test/build כמשתמש פרויקטים נפרד, בדיקת HTTP ושחזור גרסה קודמת בכשל.
- ניהול קובצי טקסט עד 1 MB, יצירה, העלאה, הורדה ומחיקה באישור. קבצים רגישים, symlinks, hardlinks ונתוני runtime חסומים. ב־Linux תיקיות מעוגנות באמצעות file descriptors למניעת החלפת symlinks בזמן גישה.
- הגדרות התראות ותצוגה, גיבויי SQLite מוצפנים ב־AES-256-GCM, וקובצי דוגמה ל־systemd, Docker ו־whatsapp-web.js.

## הפעלה לפיתוח

נדרש Node.js 24.11 ומעלה ו־Python 3. ניתן לבנות ולבדוק ב־Windows. פונקציות מערכת דורשות Ubuntu ו־helper; ב־Windows יוצג שהנתונים אינם זמינים.

```powershell
npm ci
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

העתיקו את המפתח לשדה `MASTER_KEY` ב־`.env` (אל תשתפו אותו), ושנו:

```dotenv
NODE_ENV=development
LOCAL_DEV=true
HOST=127.0.0.1
PORT=3080
PUBLIC_ORIGIN=http://localhost:5173
DATA_DIR=./data
PROJECT_ROOT=./data/projects
```

```powershell
npm run admin
npm run dev
```

פתחו `http://localhost:5173`. אין שם משתמש או סיסמה מובנים. יצירת מנהל נוסף דרך bootstrap נחסמת לאחר יצירת המנהל הראשון. השתמשו ב־localhost באופן עקבי; Origin אחר ייחסם.

```text
npm test
npm run check:helper
npm run build
npm run test:ui
```

בדיקות דפדפן משתמשות ב־Edge המותקן ב־Windows. ב־Linux התקינו תחילה את דפדפן הבדיקה באמצעות `npx playwright install chromium`. הן משתמשות בחשבון זמני ובמסד נפרד ואינן משנות שירותים בשרת.

## מבנה

```text
src/                    ממשק React, עברית, RTL, בהיר/כהה
server/app.mjs          API, אימות, CSRF, חשבונות ופרויקטים
server/security.mjs     Sessions, TOTP, הצפנה והסתרת סודות
server/files.mjs        גישה מוגבלת לקובצי פרויקט
server/queue.mjs        תור מתמשך ב־SQLite ונעילות משאבים
helper/helper.py        Unix socket, SO_PEERCRED, רשימת פעולות מוגדרת
helper/project_runner.py Git/בנייה כמשתמש פרויקטים ללא root
deploy/                 יחידות systemd ודוגמאות Proxy/תצורה
scripts/install.sh      התקנה ללא דריסת קבצים קיימים
tests/                  בדיקות אבטחה, API ו־helper עם mocks
examples/whatsapp/      דוגמת Chromium ונתונים קבועים
```

## גבולות ותפעול

זו גרסת מימוש מקומית שנבנתה בסביבת Windows. אין כאן אישור שפריסה על Hetzner/Ubuntu נבדקה בפועל; תהליך הקבלה ב־INSTALL.md הוא שלב נדרש לפני שימוש תפעולי. אין חיבור לשרת או מפתחות שסופקו בשיחה.

- פעולות מערכת נכשלות במפורש כאשר ה־helper חסר; לא מוחלפות בהדמיה.
- ניהול קבצים מיועד לקובצי טקסט. קבצים בינריים וגדולים נשארים ב־SFTP. הסתרת סודות בלוגים מבוססת תבניות ואינה יכולה לזהות כל סוד אפשרי; אין לרשום סודות בלוגים מלכתחילה.
- שירות systemd מזוהה גם דרך cgroups. שיוך Docker מבוסס פורטים מפורסמים, ו־PM2 לפי PID. כשאי אפשר להוכיח שיוך הוא נשאר לא מנוהל. פריסה בגרסאות דורשת systemd, כולל עבור rootless Docker.
- שינוי כללי UFW דורש אישור מקומי `ufw_verified_host_network`. Docker רגיל עלול לעקוף UFW; אין לסמן אישור בלי בדיקת הרשת בפועל. הסרת כלל מסירה כלל שהמערכת יצרה; אינה מבטיחה חסימת פורט אם קיימים כללים אחרים.
- גיבוי דרך הממשק כולל SQLite בלבד, מוצפן. גיבויי תצורת root, מפתחות, מידע קבוע ומסדי פרויקטים מתוארים בנפרד. אין שחזור אוטומטי של migrations במסד פרויקט.
- פריסה שומרת את Git checkout המקורי ואת הגרסאות הקודמות ואינה משתמשת ב־`git reset --hard`. בדיקות ובנייה עלולות לבצע פעולות חיצוניות לפי קוד המאגר; יש לאשר רק קוד מהימן. הפרדת המשתמשים מונעת הרשאות root, אך אינה מבודדת לחלוטין פרויקטים זה מזה: הגרסה הנוכחית משתמשת במשתמש פרויקטים משותף. לפרויקטים שאינם מהימנים זה לזה יש להפריד משתמשים/שרתים.
- בפריסה ראשונה אין גרסה קודמת לשחזור. יש לבצע פריסה ראשונית לפני הפעלת יחידת השירות. בעת אתחול המערכת, משימות שנקטעו מסומנות `interrupted` ואינן מורצות מחדש אוטומטית.
- אין מימוש סריקה חיצונית שמוכיח נגישות דרך Proxy, רשת Hetzner ו־IPv6. לכן חשיפה שאינה מקומית מוצגת ״לא ידוע״; תצוגת כללי השכבות זמינה בנפרד.
- whatsapp-web.js הוא כלי לא רשמי. אין הבטחה לחיבור רציף או לעמידה בתנאי WhatsApp.

## מקורות תכנון

- [Express security guidance](https://expressjs.com/en/advanced/best-practice-security/)
- [Node.js SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
- [Hetzner Cloud API](https://docs.hetzner.cloud/reference/cloud)
- [Hetzner Firewall behavior](https://docs.hetzner.com/cloud/firewalls/overview/)
