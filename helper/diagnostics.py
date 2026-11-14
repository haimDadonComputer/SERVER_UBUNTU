"""Bounded, redacted diagnostic records shared by the helper and project runner."""
import datetime
import getpass
import json
import os
import re
import subprocess

PREFIX='UC_DIAGNOSTIC_V1:'
FIELDS={'code','stage','action','user','uid','cwd','exitCode','timeoutSeconds','command','stdout','stderr','hint','time','launcher','httpStatus','requestId','retryAfter'}

def redact(value,secrets=()):
    text=value.decode('utf8','replace') if isinstance(value,bytes) else str(value or '')
    for secret in sorted((s for s in secrets if isinstance(s,str) and s),key=len,reverse=True):text=text.replace(secret,'[REDACTED]')
    text=re.sub(r'-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)','[REDACTED PRIVATE KEY]',text,flags=re.I)
    text=re.sub(r'otpauth://\S+','[REDACTED]',text,flags=re.I)
    text=re.sub(r'\b(?:gh[pousr]_[\w.\-]+|github_pat_[\w.\-]+|eyJ[\w\-]+\.[\w\-]+\.[\w\-]+)\b','[REDACTED]',text)
    text=re.sub(r'(https?://)[^\s/@]+:[^\s/@]+@',r'\1[REDACTED]@',text)
    text=re.sub(r'(Bearer\s+)[\w.\-]+',r'\1[REDACTED]',text,flags=re.I)
    text=re.sub(r'''(?<![\w-])((?:["']?[\w-]{0,80}(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|session)[\w-]{0,80}["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)''',r'\1[REDACTED]',text,flags=re.I)
    text=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',text)
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]','',text)

def clean(details,secrets=()):
    if not isinstance(details,dict):return {}
    result={}
    for key,value in details.items():
        if key not in FIELDS:continue
        if isinstance(value,dict):result[key]=clean(value,secrets)
        elif isinstance(value,list):result[key]=[redact(x,secrets)[:1000] for x in value[:80]]
        elif isinstance(value,(int,float)) or value is None:result[key]=value
        else:result[key]=redact(value,secrets)[-12000:]
    return result

def identify(stderr):
    text=str(stderr).lower()
    cases=[
      (('cannot set groups','failed to set uid','cannot open session','cannot set user'),'RUNUSER_IDENTITY','לא ניתן לעבור למשתמש הפרויקטים.','בדקו משתמש מערכת, קבוצות ויומן helper; אין להרחיב capabilities לפני אבחון.'),
      (('permission denied (publickey)',),'SSH_AUTH_FAILED','אימות SSH למאגר נכשל.','בדקו Deploy Key ו־known_hosts של משתמש הפרויקטים, או בחרו ייבוא באמצעות GitHub App.'),
      (('host key verification failed',),'SSH_HOST_KEY','אימות זהות שרת SSH נכשל.','בדקו known_hosts של משתמש הפרויקטים מול fingerprint רשמי; אין לבטל StrictHostKeyChecking.'),
      (('authentication failed','could not read username','could not read password','terminal prompts disabled','error: 401','error: 403'),'GIT_AUTH_FAILED','אימות Git מול המאגר נכשל.','בדקו GitHub App, הרשאת Contents: Read ושהפרויקט יובא במסלול GitHub App. URL של מאגר פרטי לבדו אינו מגדיר אימות.'),
      (('repository not found',),'REPOSITORY_ACCESS','המאגר לא נמצא או אינו מורשה.','בדקו כתובת מאגר והרשאות התקנת GitHub App או Deploy Key.'),
      (('remote branch','could not find remote ref'),'BRANCH_NOT_FOUND','הענף שהוגדר לא נמצא במאגר.','בדקו את ענף ברירת המחדל ואת שם הענף שהוגדר לפרויקט.'),
      (('not an empty directory','directory must be empty'),'DESTINATION_NOT_EMPTY','תיקיית היעד אינה ריקה.','בחרו תיקייה חדשה או בדקו ושמרו את התוכן הקיים. אין למחוק קבצים אוטומטית.'),
      (('dubious ownership',),'GIT_OWNERSHIP','Git דחה את בעלות תיקיית הפרויקט.','בדקו בעלות של התיקייה ו־.git תחת משתמש הפרויקטים. אין להגדיר safe.directory=*.'),
      (('permission denied','operation not permitted'),'PERMISSION_DENIED','מערכת ההפעלה דחתה גישה.','בדקו הרשאות בנתיב המוצג ואת המשתמש שמבצע את הפעולה; אין צורך ב־chmod 777.'),
      (('no such file','not found','cannot execute'),'EXECUTION_PATH','קובץ, תיקייה או כלי נדרשים אינם זמינים.','בדקו את הפקודה והנתיב המוצגים ואת שלמות העדכון תחת /opt/ubuntu-control.'),
      (('could not resolve host','network is unreachable','connection refused'),'NETWORK_FAILED','החיבור לרשת נכשל.','בדקו DNS, חיבור החוצה וכתובת השרת המופיעה בפלט.'),
      (('ssl certificate','certificate verify'),'TLS_FAILED','אימות תעודת HTTPS נכשל.','בדקו תעודות CA ושעון שרת; אין לבטל אימות TLS.'),
      (('not possible to fast-forward','diverging branches'),'NON_FAST_FORWARD','לא ניתן לעדכן באמצעות fast-forward.','שמרו את השינויים ופתרו את הפיצול ידנית; המערכת לא תבצע reset או force.'),
    ]
    for patterns,code,message,hint in cases:
        if any(p in text for p in patterns):return code,message,hint
    return 'COMMAND_FAILED','הפקודה נכשלה.','עיינו בשלב, בקוד היציאה ובפלט המסונן כדי לזהות את סיבת הכשל.'

class OperationError(ValueError):
    def __init__(self,message,details,secrets=()):
        super().__init__(redact(message,secrets)[:1200]);self.details=clean(details,secrets)

def failure(argv,cwd,stage,*,returncode=None,stdout='',stderr='',timeout=None,secrets=()):
    code,message,hint=identify(stderr)
    if timeout is not None:code,message,hint='COMMAND_TIMEOUT','הפעולה חרגה מהזמן המותר.','בדקו תקשורת ועומס ואת פלט הפעולה לפני ניסיון חוזר.'
    try:
        import pwd
        user=pwd.getpwuid(os.geteuid()).pw_name
    except (ImportError,AttributeError,KeyError):user=getpass.getuser()
    details={'code':code,'stage':stage,'user':user,'uid':os.getuid() if hasattr(os,'getuid') else None,'cwd':str(cwd),'command':argv,'exitCode':returncode,'stdout':stdout,'stderr':stderr,'hint':hint,'time':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    if timeout is not None:details['timeoutSeconds']=timeout
    suffix=' שלב: '+stage
    if returncode is not None:suffix+='; קוד יציאה: '+str(returncode)
    return OperationError(message+suffix,details,secrets)

def exception_details(error,stage,cwd,secrets=()):
    if isinstance(error,OperationError):return error
    if isinstance(error,subprocess.TimeoutExpired):return failure(error.cmd,cwd,stage,stdout=error.stdout,stderr=error.stderr,timeout=error.timeout,secrets=secrets)
    return failure([],cwd,stage,stderr=str(error),secrets=secrets)

def serialize(error,stage,cwd,secrets=()):
    error=exception_details(error,stage,cwd,secrets)
    return PREFIX+json.dumps({'message':str(error),'details':error.details},ensure_ascii=True)

def decode(stderr,secrets=()):
    for line in reversed(str(stderr).splitlines()):
        if not line.startswith(PREFIX):continue
        try:
            data=json.loads(line[len(PREFIX):])
            if isinstance(data.get('message'),str) and isinstance(data.get('details'),dict):
                return OperationError(data['message'],data['details'],secrets)
        except (ValueError,TypeError):pass
    return None
