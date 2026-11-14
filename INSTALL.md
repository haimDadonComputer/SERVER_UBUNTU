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

הרשאות ההתקנה נקבעות במפורש, גם אם קובצי המקור הועלו עם הרשאות מגבילות או הועתקו תחת `umask 077`:

- לפני `npm ci`, קובצי המקור, ה־helper ותבניות systemd הם בבעלות `root:root` בהרשאות `0644`, והתיקיות בהרשאות `0755`. משתמש השירות יכול לקרוא ולעבור בתיקיות, אך אינו יכול לשנות, למחוק או להחליף קוד ותבניות מערכת.
- רק `node_modules` ו־`dist` נמצאות זמנית בבעלות `ubuntu-control` לצורך התקנת תלויות ובנייה. כל פקודות npm ממשיכות לרוץ כמשתמש זה, ללא root.
- לאחר ההתקנה והבנייה, גם התלויות ותוצרי הבנייה חוזרים לבעלות root ללא הרשאות כתיבה למשתמש השירות. נשמרות הרשאות הרצה של כלי התלויות, ונוספות הרשאות קריאה וגישה לקבצים שנוצרו תחת `umask 077`.
- ההרשאות המגבילות של `/etc/ubuntu-control`, קובצי הסודות ותיקיות הנתונים נשארות כפי שהוגדרו. אין צורך להחליש את `umask`, להשתמש ב־`chmod 777` או להעביר את בעלות קובצי המקור למשתמש השירות.

אם ניסיון קודם נכשל והותיר `/opt/ubuntu-control` או `/etc/ubuntu-control`, הסקריפט ימשיך לסרב לדרוס אותן. גבו ובדקו את השרידים לפני הכנת סביבה נקייה; התיקון אינו מוחק התקנה חלקית, נתונים או סודות באופן אוטומטי.

בדיקת רגרסיה ייעודית להרשאות זמינה על Linux. היא משתמשת בתיקייה זמנית ובמשתמש `nobody`, מריצה `npm ci` ו־`npm prune` על חבילת בדיקה ללא תלויות חיצוניות, ובודקת גם חסימת כתיבה למקור וקריאת תלויות אחרי הנעילה. היא אינה מתקינה שירותים או משנה משתמשים במערכת:

```bash
sudo env "PATH=$PATH" bash tests/install-permissions.sh
```

בדיקה זו כלולה גם ב־GitHub Actions על Ubuntu 24.04. יש להריץ אותה מתוך עותק המקור עם Node.js ו־npm הזמינים גם למשתמש בדיקה אחר.

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

## 4. יצירת תיקיות פרויקטים דרך האתר

במסך ״פרויקטים״ לחצו ״הוספת פרויקט״, הזינו שם תיקייה באנגלית (לדוגמה `my-app`) ושם לתצוגה בעברית ושמרו. אפשר לחזור על הפעולה ליצירת כמה פרויקטים. התיקיות נוצרות תחת `/srv/ubuntu-projects` עם הרשאות משותפות למשתמש הפרויקטים ולממשק. לחצו ״קבצים״ כדי ליצור תיקיות פנימיות, להעלות ולערוך קובצי טקסט.

אין צורך להוסיף פרויקט ל־`helper.json`, לערוך JSON או להפעיל מחדש את ה־helper לכל תיקייה חדשה. אם קיימת תיקייה ישירה באותו שם, האתר מוסיף אותה לרשימה בלי למחוק או לשנות את תוכנה והרשאותיה. לתיקייה קיימת יש לוודא הרשאות כתיבה מתאימות למשתמש השירות. תיקיות מחוץ לתיקיית הפרויקטים וקישורים סמליים נשארים חסומים.

רישום הפרויקטים שנוצרו דרך האתר נשמר אוטומטית בקובץ root פרטי `/var/lib/ubuntu-control-helper/projects.json`, ונשמר גם אחרי restart. ערכי `projects` קיימים ב־helper.json ממשיכים לעבוד ומקבלים עדיפות, כדי לשמור על תאימות להתקנות קודמות.

בהתקנה קיימת, עדכנו את קוד ה־Web, את ה־helper ואת תוצרי הבנייה לפי סעיף 9. עדכנו גם את יחידת `ubuntu-control-helper.service` מהגרסה החדשה: היא כוללת `CAP_FSETID` לשמירת הרשאת setgid בתיקיות החדשות. לאחר העדכון הריצו `sudo systemctl daemon-reload` ו־`sudo systemctl restart ubuntu-control-helper ubuntu-control`. אין צורך לשנות את helper.json הקיים או להריץ שוב את סקריפט ההתקנה הראשונית.

### פריסה והרצת שירות (אופציונלי)

לניהול קבצים מספיקים שם תיקייה ושם לתצוגה. לפריסה דרך GitHub אפשר למלא בעת ההוספה גם כתובת מאגר, ענף, סוג פרויקט, שירות קיים ופורט בדיקת תקינות. שירותי מערכת קיימים עדיין מוגדרים ברשימת `services` לפי סעיף 3; יצירת תיקייה אינה מפעילה שירות ואינה פותחת פורטים. הדוגמה בהמשך משתמשת ב־`my-app` ובפורט `3000`.

המאגר חייב לכלול `package-lock.json` עבור Node. המערכת תבצע `npm ci` (כולל lifecycle scripts), ולאחר מכן `npm run test` ו־`npm run build` אם הוגדרו במאגר. יש לאשר בממשק רק מאגר וקוד מהימנים. הגרסאות נשמרות תחת `.control-releases`, והשירות רץ מתוך `current`; מקור המאגר המקורי נשאר ללא reset.

הכינו מראש יחידת systemd **חדשה** לפי `deploy/project-node.service.example`. עדכנו את `WorkingDirectory`, `ExecStart`, `PORT` ו־HOST לפי הפרויקט. אפליקציה חייבת לכבד את ההגדרות בפועל; המערכת אינה משנה את קוד האפליקציה כדי לכפות כתובת האזנה. השאירו אותה כבויה עד לפריסה הראשונה.

```bash
sudo install -m 0644 deploy/project-node.service.example /etc/systemd/system/my-app.service
sudoedit /etc/systemd/system/my-app.service
sudo systemctl daemon-reload
sudo systemctl restart ubuntu-control-helper
```

לאחר הכנת שירות לפריסה, בחרו בו בעת הוספת הפרויקט וציינו את מאגר GitHub ופורט בדיקת התקינות. לחצו ״התקנה ממאגר״ אם התיקייה ריקה. רק לאחר שהשכפול הסתיים בהצלחה ב״משימות רקע״, הכינו נתונים קבועים:

```bash
sudo install -d -m 0700 -o ubuntu-projects -g ubuntu-projects /srv/ubuntu-projects/my-app/shared
sudo setfacl -b -k /srv/ubuntu-projects/my-app/shared
sudo chmod 0700 /srv/ubuntu-projects/my-app/shared
```

לחצו ״סנכרון GitHub״, עיינו בגרסה ובשינויים ואשרו. המערכת תבנה תיקיית גרסה חדשה, תחליף את `current`, תפעיל את השירות ותבדוק HTTP מקומי. יש לספק endpoint תקין ב־`http://127.0.0.1:3000/` שמחזיר HTTP קטן מ־400 ללא הזדהות. במוצר שבו `/` מחייב אימות יש להתאים מראש את ה־helper לנתיב health קבוע.

רק לאחר פריסה מוצלחת אפשר ללחוץ ״הפעלה באתחול״. לקבצים קיימים מקומיים יש לוודא הרשאות ו־Git נקי; הסנכרון אינו מוחק שינויים מקומיים. אין הורדה אוטומטית של שינויים מקומיים ל־GitHub.

משתני סביבה נשמרים בממשק לאחר אימות נוסף בקובץ `/etc/ubuntu-control/projects/my-app.env` עם הרשאות `0600`. יחידת השירות לדוגמה כוללת `EnvironmentFile` תואם. הערכים אינם מוחזרים לממשק. שמירה מחליפה את כל משתני הקובץ; אין להזין סודות בקובצי קוד דרך מנהל הקבצים.

## 5. GitHub פרטי

### GitHub App קיימת — המסלול המומלץ לייבוא דרך האתר

נתמך גם על Contabo עם Ubuntu 24.04; חיבור GitHub אינו תלוי ב־Hetzner. אין צורך ב־OAuth או ביצירת מפתח חדש. השתמשו במפתח הקיים ב־`/etc/ubuntu-control/github/app.pem` וב־App ID ו־Installation ID של האפליקציה שכבר הותקנה. בהתקנת All repositories יוצגו כל המאגרים שההתקנה רשאית לגשת אליהם, בהתאם להרשאותיה.

ב־GitHub App נדרשות הרשאות Repository **Contents: Read-only** ו־Metadata: Read. שינוי הרשאות ב־GitHub עשוי לדרוש אישור מחדש של ההתקנה. המערכת אינה מבקשת Write ולא מאפשרת Push. אל תזינו PAT, Client Secret או את תוכן ה־PEM באתר.

לאחר השדרוג המתואר בסעיף 9:

1. פתחו **הגדרות ואבטחה → GitHub App**.
2. הזינו App ID ו־Installation ID, ואת סיסמת מנהל המערכת וקוד TOTP אם מופעל. נתיב ה־PEM מוצג לקריאה בלבד ואינו מתקבל כנתיב חופשי מהלקוח.
3. לחצו **שמירת חיבור**, ולאחר מכן **בדיקת חיבור**. מוצגים מצב החיבור ותאריך הבדיקה האחרון.
4. לחצו **רענון מאגרים**, או עברו ל־**פרויקטים → ייבוא מ־GitHub**. ניתן לחפש לפי שם/תיאור, לסנן ציבורי/פרטי/ארכיון ולמיין לפי שם או תאריך עדכון. מוצגים ענף ברירת מחדל ותיאור. מאגר בארכיון מוצג אך אינו ניתן לייבוא.
5. בחרו מאגר ושם תיקייה, ואשרו ייבוא. אפשר גם לבחור בשם של פרויקט קיים שנוצר באתר, בתנאי שתיקייתו ריקה. תוכן קיים אינו נמחק; פרויקט ותיק שמוגדר ידנית ב־helper.json דורש שם תיקייה חדש במסלול הייבוא הזה.
6. בדקו את התוצאה ב־**משימות רקע**. הייבוא מוריד קוד בלבד. בעת הייבוא ניתן לבחור שירות קיים ופורט תקינות לצורך פריסות בהמשך; אם משייכים לפרויקט קיים נשמר השיוך הקודם שלו.

**משיכת קוד בלבד** משתמשת באותו חיבור GitHub App, דורשת checkout נקי ומבצעת fetch ו־merge ב־fast-forward בלבד. לפני העדכון נשמר ענף `control-backup-...` עם הקומיט הקודם. הפעולה אינה משנה את גרסת השירות שב־`current`, אינה מריצה scripts ואינה מבצעת Push. **סנכרון GitHub** ממשיך להשתמש בתהליך הבנייה, בדיקות התקינות והחזרת הגרסה הקודמת הקיים, עם אותן הרשאות קריאה למאגר.

הפרדת ההרשאות היא:

- `ubuntu-control`: Web ללא root וללא הרשאת קריאת PEM.
- `ubuntu-control-helper`: רק הוא מתקשר לשירות האישורים המקומי; אין API שמחזיר Token לדפדפן.
- `ubuntu-github`: שירות נפרד ללא capabilities, שקורא את הקובץ הקבוע בלבד וחותם JWT באמצעות OpenSSL RS256. IDs ומצב חיבור נשמרים ב־`/var/lib/ubuntu-control-github` עם הרשאות `0700`; Tokens אינם נשמרים בקבצים אלה.
- `ubuntu-projects`: Git מקבל Token למאגר בודד דרך stdin של runner ולאחר מכן דרך socket זמני של askpass בזיכרון. אין Token ב־argv, במשתני סביבה, ב־origin או ב־Git config. ה־socket נמחק אחרי פעולת הרשת והאישורים אינם מועברים ל־npm/build/test.

ה־Token מתחדש בעת הצורך חמש דקות לפני פקיעתו. רשימת המאגרים נקראת מחדש לפני הנפקת אישור ל־Git, ונשלח ל־GitHub repository ID ספציפי עם Contents: Read. מעבר של התקנת GitHub מ־All ל־Selected repositories, הסרת מאגר, השעיה או ביטול הרשאות יאכפו מחדש בייבוא ובבקשת האישור הבאה. אין מנגנון שמרחיב את הרשאות ההתקנה.

**ניתוק:** הזינו סיסמה וקוד TOTP בהגדרות ולחצו ״ניתוק GitHub App״. המערכת חוסמת אישורים חדשים, מוחקת מטמון בזיכרון ומנסה לבטל את כל ה־Tokens שהנפיקה ועדיין בתוקף. היא אינה מסירה את ההתקנה מחשבון GitHub ואינה מוחקת מאגרים מקומיים. אם GitHub אינו זמין בזמן הניתוק, הביטול מרחוק אינו מובטח; הממשק יציג זאת, וניתן לבטל את ההתקנה ב־GitHub עצמו. Tokens אבודים עקב restart של השירות נשארים כפופים לפקיעתם ולהרשאות GitHub.

**החלפת מפתח:** החליפו מקומית את קובץ ה־PEM באותו נתיב קבוע בקובץ בבעלות root, ללא הכנסת התוכן לשורת הפקודה. לאחר החלפת הקובץ הריצו מעותק המקור:

```bash
sudo bash scripts/github-access.sh
sudo systemctl restart ubuntu-control-github
```

השירות יזהה גם שינוי inode/mtime/גודל של מפתח בזמן עבודה ויבטל את מטמון האישורים הקודם. אם החלפתם App ID או Installation ID, שמרו שוב בהגדרות ובדקו חיבור. אין להוסיף את ubuntu-control לקבוצת ubuntu-github או לתת לו ACL לקריאת המפתח.

**שגיאות:** 401 מציין App ID/PEM/שעון או Token שפקע (לבקשת רשימה מתבצע חידוש אחד); 403 מציין הרשאות או מכסת API; 404 מציין התקנה/מאגר לא מורשים או שנמחקו; 429 מציין הגבלת קצב. לא מבוצעות לולאות retry אגרסיביות. כשל Git אינו מציג stdout/stderr גולמיים שעלולים להכיל מידע רגיש. מאגר שנכשל באמצע clone אינו נמחק אוטומטית; בחרו תיקייה חדשה או בדקו ושמרו את תוכן התיקייה הקיימת לפני ניסיון חוזר.

### Deploy Key — תאימות למסלול הקיים

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

`install.sh` מיועד להתקנה ראשונה. להתקנה קיימת השתמשו ב־`scripts/upgrade.sh`, בלי להריץ מחדש את ההתקנה הראשונית ובלי לבצע git pull בתוך `/opt/ubuntu-control`.

בשרת Contabo שלכם, מתוך חלון SSH:

```bash
cd /home/adminuser/apps/SERVER_UBUNTU
git pull --ff-only
sudo bash scripts/upgrade.sh
```

אם קוד המקור נמצא במקום אחר, התאימו רק את `cd`. `git pull` רץ כ־adminuser; השדרוג דורש sudo אך כל npm והבדיקות שבמהלכו רצים כ־ubuntu-control. אין צורך לבנות בנפרד או להעתיק ידנית קבצים ל־`/opt`.

הסקריפט דורש Ubuntu 24.04, Node.js 24.11+, npm, Python, OpenSSL, `setfacl`/`getfacl`, המפתח הקיים בבעלות root והתקנה סטנדרטית קיימת. תלות חסרה תגרום לעצירה לפני החלפת הקוד. אם חסרות חבילות מערכת, התקינו אותן מקומית: `sudo apt-get install acl openssl`. אין שינוי חומת אש, VPN, DNS או Reverse Proxy; הפעולות על Contabo אינן משתמשות ב־Hetzner API.

בדיקות ה־helper משתמשות אוטומטית ב־`python3` על Ubuntu וב־`python` על Windows באמצעות `scripts/check-helper.mjs`. אין צורך להתקין `python-is-python3`, ליצור symlink או להרחיב הרשאות. אם גרסה קודמת של השדרוג נעצרה עם `python: not found`, ההתקנה הפעילה עדיין לא הוחלפה. משכו את התיקון מ־GitHub והריצו שוב `sudo bash scripts/upgrade.sh`; אין צורך למחוק תיקיות staging או להריץ התקנה ראשונית.

תהליך השדרוג:

1. מוודא שאין משימות queued/running או שינוי Firewall שממתין לאישור.
2. מכין staging חדש ב־`/opt`, עם מקור בבעלות root ותיקיות build בלבד בבעלות השירות. מריץ npm ci, בדיקות Node/Python, Build ו־prune ללא root. התקנה פעילה ממשיכה לעבוד בשלב הזה.
3. עוצר את שירותי Web/helper (ואת broker אם כבר קיים), בודק שוב שאין פעולה פעילה, ושומר גיבוי root פרטי ב־`/var/backups/ubuntu-control/<id>`. הגיבוי כולל SQLite snapshot עקבי, `/etc/ubuntu-control` כולל המפתח הקיים, מצב helper, ומצב broker אם קיים. שמרו את הגיבוי במקום מוגן: הוא כולל סודות.
4. מוסיף רק את משתמש השירות `ubuntu-github` אם חסר ואת הרשאות הקריאה המצומצמות שלו למפתח. משתמשי Web ופרויקטים אינם מוחלפים. נתוני הפרויקטים ומיקומיהם אינם משתנים. app.env ו־helper.json אינם נכתבים מחדש. הרשאות ה־PEM מצטמצמות ל־root ולקריאה עבור broker בלבד.
5. מתקין יחידת broker חדשה ו־drop-in שמסדר את הפעלתו לפני helper. יחידות Web/helper הקיימות אינן מוחלפות. אם קיים broker/drop-in שונה מהתבנית, השדרוג עוצר כדי לשמור על התאמות מקומיות.
6. מחליף את עץ הקוד באותו filesystem ומשאיר את הקוד הקודם תחת `/opt/.ubuntu-control-previous-<id>` בבעלות root ובהרשאות `0700`. בעליית Web מתווספות רק עמודות auth/repository ID חסרות, ללא מחיקת טבלאות או Sessions.
7. בודק שירותים ו־HTTP health. בכשל החלפה/עלייה הוא מחזיר את עץ הקוד ויחידות broker הקודמים ומנסה להפעיל שוב את השירותים שהיו פעילים. הוא אינו מחזיר אוטומטית מסד נתונים ישן ואינו דורס נתונים חדשים; העמודות הנוספות תואמות גם לגרסה הקודמת. במקרה של כשל לפני החלפת הקוד עשוי להישאר staging לבדיקת מנהל.

לאחר הצלחה:

```bash
sudo systemctl status ubuntu-control ubuntu-control-helper ubuntu-control-github --no-pager
curl --fail http://127.0.0.1:3080/api/health
```

רעננו את הדפדפן עם Ctrl+Shift+R והגדירו את GitHub App לפי סעיף 5. בדיקת health מוכיחה עליית Web בלבד; **בדיקת חיבור** בהגדרות היא שמאמתת גישה בפועל להתקנת GitHub שלכם. השירותים ו־ACL למפתח דורשים בדיקת קבלה על השרת האמיתי; הם לא נבדקו מקומית בסביבת Windows.

## 10. בדיקות קבלה על שרת אמיתי

לפני שימוש תפעולי יש לבצע:

1. כניסה ב־HTTPS דרך VPN, בדיקת Secure/HttpOnly/SameSite, הפעלת TOTP, יציאה ותוקף חוסר פעילות גם כאשר לוח הבקרה פתוח.
2. השוואת הטבלה ל־`sudo ss -lntup`, ל־systemctl ול־Docker/PM2 אם מותקנים; בדיקת IPv6 ופורט UDP.
3. שירות בדיקה ייעודי: start/stop/restart/logs, כשל הפעלה, איסור שליטה בשירות לא מורשה והצגת משימות שנכשלו.
4. קבצים: חסימת `.env`, `.git`, `shared`, symlinks ו־hardlinks; עריכת קוד רגיל. בדקו שהרשאות הפרויקט מאפשרות כתיבה, ושנתוני Web אינם קריאים למשתמש הפרויקטים.
5. UFW/Hetzner: שינוי פורט בדיקה שאינו ניהול, אי־אישור כדי לבדוק rollback, restart של helper באמצע ובדיקת שחזור גם ב־IPv6. אל תבדקו זאת על SSH או על פורט ה־VPN.
6. פריסה ממאגר בדיקה, בנייה שנכשלת, health check שנכשל, שחזור, שמירת LocalAuth והמשך הפעלה לאחר reboot.
7. יצירת גיבוי ושחזור לעותק נפרד, כולל מפתחות ותצורת root; תעדו תוצאות לפני העברת המערכת לשימוש קבוע.
