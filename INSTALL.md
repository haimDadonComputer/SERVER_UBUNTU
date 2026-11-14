# התקנה על Ubuntu 24.04 LTS

הפקודות במסמך מיועדות לשרת Ubuntu, לא לחלון PowerShell במחשב Windows. התחברו תחילה דרך SSH של Hetzner. שמרו חלון SSH נוסף פתוח ואת הגישה ל־Console של Hetzner במהלך ההתקנה. הסקריפט אינו משנה UFW, חומת אש בענן, SSH או שירותים קיימים.

## 1. הכנה והעתקת הפרויקט

נדרשים Ubuntu 24.04, הרשאות sudo, Node.js 24.11 ומעלה המותקן לכל המשתמשים ב־`/usr/bin/node` או `/usr/local/bin/node`, npm וגישה לרשת להתקנת חבילות. התקינו Node.js באמצעות ההנחיות הרשמיות ב־[nodejs.org](https://nodejs.org/en/download), ובדקו `node --version` ו־`npm --version`. אין להשתמש ב־nvm של root להפעלת השירות.

העתיקו את תיקיית הפרויקט לשרת באמצעות SFTP (למשל WinSCP) או Git, ללא `.env`, `data`, או `node_modules`. ודאו ש־`package-lock.json` נכלל. דוגמה לאחר שהקבצים הועתקו ל־`~/ubuntu-control-source`:

```bash
cd ~/ubuntu-control-source
sudo bash scripts/install.sh
```

הסקריפט יבקש כתובת HTTPS מדויקת, כגון `https://control.example.com`, ולאחר מכן שם מנהל וסיסמה של 14 תווים לפחות. הסיסמה אינה מוצגת. ההתקנה יוצרת שני משתמשים נפרדים: `ubuntu-control` לממשק ו־`ubuntu-projects` לקוד הפרויקטים. קוד המערכת וה־helper הופכים ל־root-owned לפני הפעלת השירות. סקריפט ההתקנה מסרב לדרוס התקנה קיימת.

בסיום:

```bash
sudo systemctl status ubuntu-control ubuntu-control-helper --no-pager
curl --fail http://127.0.0.1:3080/api/health
```

התוצאה הצפויה היא `{"ok":true}`. זו בדיקת Web בלבד; בדקו גם את הניטור בממשק לאחר חיבור HTTPS. כשל התקנה אינו מתקן את עצמו באמצעות מחיקת תיקיות; עיינו בלוגים ובצעו תיקון ממוקד:

```bash
sudo journalctl -u ubuntu-control -u ubuntu-control-helper -n 60 --no-pager
```

## 2. גישה מוגנת מהדפדפן

השרת מאזין ל־`127.0.0.1:3080`, שאינו נגיש מבחוץ. הגדירו VPN כגון WireGuard או Tailscale לפי מדיניות הרשת שלכם. לאחר שה־VPN פועל, התקינו Reverse Proxy עם תעודת HTTPS מהימנה, האזנה לכתובת ה־VPN בלבד ורשימת כתובות מורשות.

`deploy/nginx.conf.example` הוא קובץ לדוגמה. החליפו את `VPN_ADDRESS`, `VPN_CIDR`, שם המתחם ונתיבי התעודות. אין להעתיק אותו בלי התאמה. הוסיפו אותו כקובץ חדש בלבד, ובדקו לפני טעינה:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

הכתובת בדפדפן חייבת להתאים במדויק ל־`PUBLIC_ORIGIN` שב־`/etc/ubuntu-control/app.env`. Cookie מסוג Secure לא יעבוד ב־HTTP רגיל. אין להפעיל `LOCAL_DEV` על השרת לגישה מרחוק. שינוי hostname/port דורש שינוי תצורה ו־restart; אינו נכתב אוטומטית מהממשק כדי למנוע ניתוק.

## 3. אישור שירות קיים

ערכו מקומית על השרת:

```bash
sudoedit /etc/ubuntu-control/helper.json
```

בתוך `services`, הוסיפו רק שירותים שאתם מתכוונים לאפשר לממשק לשלוט בהם:

```json
{"id":"my-app","kind":"systemd","name":"my-app.service"}
```

אפשר גם `{"id":"container1","kind":"docker","name":"actual-container-name"}` עבור מכולה קיימת, או `{"id":"pm-app","kind":"pm2","name":"actual-pm2-name"}`. להפעלת PM2 הגדירו `pm2_enabled: true`, נתיב binary בבעלות root, ו־`pm2_home` של משתמש הפרויקטים. PM2 של root אינו נתמך. ממשק Web אינו חבר בקבוצת docker.

הפעילו מחדש רק את ה־helper לאחר שינוי ההרשאות:

```bash
sudo systemctl restart ubuntu-control-helper
```

שירותי SSH, רשת ושירותי מערכת הניהול מוגנים גם אם נכנסו בטעות לרשימה. כל פעולת שירות מחייבת אישור בממשק ומשפיעה על כל הפורטים שלו.

## 4. הכנת פרויקט Node.js

הדוגמה משתמשת בשם `my-app`, במאגר GitHub מהימן ובפורט `3000`. בחרו פורט פנוי. הכינו תיקייה בעלת הרשאות קבוצתיות כך שמנהל הקבצים יוכל לערוך קוד, אך לא לקרוא נתוני התחברות:

```bash
sudo install -d -m 2770 -o ubuntu-projects -g ubuntu-projects /srv/ubuntu-projects/my-app
sudo setfacl -d -m u::rwx,g::rwx,o::--- /srv/ubuntu-projects/my-app
```

הוסיפו תחת `projects` ב־helper.json (בנוסף לשירות ברשימת `services`):

```json
"my-app": {
  "root": "/srv/ubuntu-projects/my-app",
  "kind": "node",
  "service": "my-app",
  "repo": "https://github.com/YOUR-ORG/YOUR-REPO.git",
  "branch": "main",
  "health_port": 3000,
  "qr_enabled": false
}
```

המאגר חייב לכלול `package-lock.json` עבור Node. המערכת תבצע `npm ci` (כולל lifecycle scripts), ולאחר מכן `npm run test` ו־`npm run build` אם הוגדרו במאגר. יש לאשר בממשק רק מאגר וקוד מהימנים. הגרסאות נשמרות תחת `.control-releases`, והשירות רץ מתוך `current`; מקור המאגר המקורי נשאר ללא reset.

הכינו מראש יחידת systemd **חדשה** לפי `deploy/project-node.service.example`. עדכנו את `WorkingDirectory`, `ExecStart`, `PORT` ו־HOST לפי הפרויקט. אפליקציה חייבת לכבד את ההגדרות בפועל; המערכת אינה משנה את קוד האפליקציה כדי לכפות כתובת האזנה. השאירו אותה כבויה עד לפריסה הראשונה.

```bash
sudo install -m 0644 deploy/project-node.service.example /etc/systemd/system/my-app.service
sudoedit /etc/systemd/system/my-app.service
sudo systemctl daemon-reload
sudo systemctl restart ubuntu-control-helper
```

כעת בממשק: ״פרויקטים״ ← ״הוספת פרויקט״ ← מזהה `my-app` ושם לתצוגה. לחצו ״התקנה ממאגר״ אם התיקייה ריקה. רק לאחר שהשכפול הסתיים בהצלחה ב״משימות רקע״, הכינו נתונים קבועים:

```bash
sudo install -d -m 0700 -o ubuntu-projects -g ubuntu-projects /srv/ubuntu-projects/my-app/shared
sudo setfacl -b -k /srv/ubuntu-projects/my-app/shared
sudo chmod 0700 /srv/ubuntu-projects/my-app/shared
```

לחצו ״סנכרון GitHub״, עיינו בגרסה ובשינויים ואשרו. המערכת תבנה תיקיית גרסה חדשה, תחליף את `current`, תפעיל את השירות ותבדוק HTTP מקומי. יש לספק endpoint תקין ב־`http://127.0.0.1:3000/` שמחזיר HTTP קטן מ־400 ללא הזדהות. במוצר שבו `/` מחייב אימות יש להתאים מראש את ה־helper לנתיב health קבוע.

רק לאחר פריסה מוצלחת אפשר ללחוץ ״הפעלה באתחול״. לקבצים קיימים מקומיים יש לוודא הרשאות ו־Git נקי; הסנכרון אינו מוחק שינויים מקומיים. אין הורדה אוטומטית של שינויים מקומיים ל־GitHub.

משתני סביבה נשמרים בממשק לאחר אימות נוסף בקובץ `/etc/ubuntu-control/projects/my-app.env` עם הרשאות `0600`. יחידת השירות לדוגמה כוללת `EnvironmentFile` תואם. הערכים אינם מוחזרים לממשק. שמירה מחליפה את כל משתני הקובץ; אין להזין סודות בקובצי קוד דרך מנהל הקבצים.

## 5. GitHub פרטי

צרו Deploy Key ללא passphrase במשתמש `ubuntu-projects`, תנו למפתח הציבורי הרשאת קריאה בלבד למאגר ב־GitHub והוסיפו את host key המאומת של github.com ל־known_hosts של המשתמש. אימות fingerprint צריך להתבצע מול [תיעוד GitHub הרשמי](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints), ולא באמצעות אישור עיוור של ssh-keyscan. המפתח הפרטי אינו נכנס למערכת Web או לקוד.

```bash
sudo install -d -m 0700 -o ubuntu-projects -g ubuntu-projects /var/lib/ubuntu-projects/.ssh
sudo -u ubuntu-projects ssh-keygen -t ed25519 -f /var/lib/ubuntu-projects/.ssh/id_ed25519 -N ''
```

הגדירו כתובת מאגר מסוג `git@github.com:ORG/REPO.git`. חיבור SSH נעשה עם `BatchMode` ו־`StrictHostKeyChecking`. אין לשים Token בתוך כתובת HTTPS. עבור מספר מאגרים, העדיפו משתמש פרויקטים נפרד או מפתח מצומצם מתאים; מימוש זה אינו מנפיק GitHub App tokens.

## 6. חומת אש מקומית ו־Hetzner

אין להפעיל UFW אוטומטית מתוך המערכת. מנהל השרת צריך להכין UFW פעיל עם כללי SSH ו־VPN קיימים, ולבדוק שלא נוצרת עקיפה דרך Docker/iptables. רק אז ניתן להגדיר `ufw_verified_host_network: true`. לאחר מכן הממשק מאפשר שינוי פורטים שאינם מוגנים.

לחיבור Hetzner, צרו חומת אש **ייעודית** לשרת המיועד עם תווית `ubuntu-control=dedicated`. ודאו שכבר קיימים בה כללי ניהול/VPN הנדרשים. הקוד אינו יוצר ואינו מחיל חומת אש חדשה על השרת. שמרו API token בקובץ root בלבד באמצעות עורך מקומי, והוסיפו ל־helper.json:

```json
"hetzner_firewall_id": 123456,
"hetzner_server_id": 654321,
"hetzner_token_file": "/etc/ubuntu-control/hetzner.token"
```

```bash
sudo touch /etc/ubuntu-control/hetzner.token
sudo chmod 0600 /etc/ubuntu-control/hetzner.token
sudoedit /etc/ubuntu-control/hetzner.token
sudo systemctl restart ubuntu-control-helper
```

המפתח אינו מוחזר לממשק. כל שינוי שומר את `user.rules`, `user6.rules` ואת כללי הענן הקודמים תחת `/var/lib/ubuntu-control-helper`. לאחר השינוי יש לאשר בממשק שחיבור הניהול עובד בתוך 120 שניות; אחרת watchdog משחזר. מצב השחזור נשמר בדיסק גם אם ה־helper מופעל מחדש. אין להריץ במקביל שינויי חומת אש מכלי אחר בזמן שממתין אישור, אחרת השחזור יכול לבטל גם אותם. כשל שחזור בענן דורש טיפול ב־Hetzner Console; אין הבטחת rollback אם ספק הענן אינו זמין.

הפעולה ״הסרת הרשאה״ מסירה כלל מדויק שנוצר בידי המערכת. היא לא מוחקת כלל רחב קיים ולא מבטיחה חסימה. סטטוס החשיפה נשאר ״לא ידוע״ עד אימות רשת חיצוני; בדקו IPv4/IPv6, כתובת האזנה, Proxy ושכבות נוספות. ההגנה על פורטים מתייחסת לתקשורת הניהול ולשירותים נפוצים; הוסיפו כל פורט ניהול ייעודי שלכם ל־`protected_ports`.

## 7. Docker ו־Chromium

שליטה במכולות קיימות מוגבלת ל־start/stop/restart/logs של שמות מאושרים. פריסת Docker מהמאגר משתמשת בבניית image כמשתמש פרויקטים דרך **Docker rootless**, לא ב־Docker daemon של root. יש להתקין rootless Docker לפי תיעוד Docker, להפעיל lingering למשתמש הפרויקטים, להגדיר את socket המשתמש בסביבת הבנייה ולהשתמש ביחידת `deploy/project-docker.service.example` במקום שירות Node. שנו `PROJECT_UID` ל־`id -u ubuntu-projects`. הבנייה שומרת image נפרד לכל גרסה, ושחזור `current` בוחר את image הקודם. התיקייה `shared` מחוברת כ־volume קבוע. פורטים בדוגמה מפורסמים ב־localhost בלבד.

ל־whatsapp-web.js יש קובץ Dockerfile ודוגמת client תחת `examples/whatsapp`. עבור שירות Node מקומי ב־Ubuntu ניתן להתקין Chromium דרך snap (`sudo snap install chromium`) ולוודא בפועל שהמשתמש והשירות יכולים להפעיל sandbox. אין להוסיף `--no-sandbox` כפתרון כללי. יש לבדוק התאמה בין Chromium, Puppeteer ומגבלות systemd על השרת האמיתי.

שמרו את LocalAuth תחת `shared/whatsapp`, לא בתוך גרסת הקוד. מיקום זה אינו נגיש דרך מנהל הקבצים ואינו נמחק בעדכון. הפעלת QR דורשת `qr_enabled: true` בפרויקט והפקת קובץ `shared/whatsapp/qr.json` בפורמט שבדוגמה; הקוד נמסר רק ל־Session מנהל מחובר עם תפוגה קצרה. אין להדפיס QR או נתוני LocalAuth ללוגים.

## 8. גיבוי ושחזור

גיבוי במסך ההגדרות יוצר SQLite snapshot עקבי ומצפין אותו באמצעות `MASTER_KEY`. הורידו את קובץ ה־`.enc` לאחסון מוגן. גיבוי מלא דורש גם עותק root של `/etc/ubuntu-control`, יחידות systemd, `/var/lib/ubuntu-control-helper`, מפתחות Deploy Key, תיקיות `shared` ומסדי נתונים של הפרויקטים. שמרו את MASTER_KEY בנפרד מהגיבוי המוצפן, אחרת אי אפשר לשחזר. גיבוי עם המפתח לידו אינו מוגן מפני גניבה של שני הקבצים יחד.

כלי השחזור המקומי דורש עצירת שירות ה־Web, קובץ מוצפן ומיקום פלט **שאינו קיים**. הוא אינו דורס מסד חי:

```bash
sudo systemctl stop ubuntu-control
sudo -u ubuntu-control /usr/bin/node --env-file=/etc/ubuntu-control/app.env /opt/ubuntu-control/scripts/restore.mjs /path/to/backup.enc /var/lib/ubuntu-control/restored.sqlite
```

לאחר בדיקת העותק, גיבוי המסד הנוכחי והחלפה ידנית שלו (כולל טיפול ב־WAL/SHM כשהשירות כבוי), הפעילו את השירות. כלי השחזור מבטל Sessions כדי לחייב כניסה מחדש.

## 9. עדכון מערכת הניהול

הסקריפט מיועד להתקנה ראשונה ואינו דורס קבצים. לעדכון: גבו את הנתונים והתצורה, בנו ובדקו עותק חדש במשתמש בלתי מורשה, עצרו את שני השירותים, והחליפו רק את קובצי הקוד ב־`/opt/ubuntu-control` לאחר סקירת ההבדלים. השאירו את הבעלות root, שמרו על `app.env`, בסיס הנתונים ו־helper.json, בדקו תאימות schema, והפעילו מחדש. אין updater שמוריד ומריץ קוד root מהאינטרנט.

## 10. בדיקות קבלה על שרת אמיתי

לפני שימוש תפעולי יש לבצע:

1. כניסה ב־HTTPS דרך VPN, בדיקת Secure/HttpOnly/SameSite, הפעלת TOTP, יציאה ותוקף חוסר פעילות גם כאשר לוח הבקרה פתוח.
2. השוואת הטבלה ל־`sudo ss -lntup`, ל־systemctl ול־Docker/PM2 אם מותקנים; בדיקת IPv6 ופורט UDP.
3. שירות בדיקה ייעודי: start/stop/restart/logs, כשל הפעלה, איסור שליטה בשירות לא מורשה והצגת משימות שנכשלו.
4. קבצים: חסימת `.env`, `.git`, `shared`, symlinks ו־hardlinks; עריכת קוד רגיל. בדקו שהרשאות הפרויקט מאפשרות כתיבה, ושנתוני Web אינם קריאים למשתמש הפרויקטים.
5. UFW/Hetzner: שינוי פורט בדיקה שאינו ניהול, אי־אישור כדי לבדוק rollback, restart של helper באמצע ובדיקת שחזור גם ב־IPv6. אל תבדקו זאת על SSH או על פורט ה־VPN.
6. פריסה ממאגר בדיקה, בנייה שנכשלת, health check שנכשל, שחזור, שמירת LocalAuth והמשך הפעלה לאחר reboot.
7. יצירת גיבוי ושחזור לעותק נפרד, כולל מפתחות ותצורת root; תעדו תוצאות לפני העברת המערכת לשימוש קבוע.
