#!/usr/bin/python3
"""Dedicated unprivileged GitHub App broker. Only the root helper is a peer.

No OAuth, private-key material in HTTP responses, or persistent installation tokens.
"""
import base64
import datetime as dt
import json
import os
import pathlib
import re
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

PEM_PATH = '/etc/ubuntu-control/github/app.pem'
API_VERSION = '2026-03-10'
ERRORS = {401:'GitHub דחה את האימות. בדקו App ID, מפתח ושעון שרת.',403:'אין הרשאה מתאימה או שהוגבלה מכסת GitHub. בדקו הרשאות ההתקנה.',404:'התקנה או מאגר לא נמצאו או שהגישה אליהם בוטלה.',422:'הגדרות או הרשאות GitHub App אינן תקינות. בדקו Contents: Read ואישור הרשאות ההתקנה.',429:'GitHub הגביל את קצב הבקשות. נסו שוב מאוחר יותר.'}

class GitHubError(ValueError):
    def __init__(self, status, retry_after=None,request_id=None):
        self.status=status
        self.retry_after=retry_after
        super().__init__(ERRORS.get(status,'שירות GitHub אינו זמין כעת. נסו שוב מאוחר יותר.'))
        self.details={'code':'GITHUB_HTTP_'+str(status),'stage':'github-api','httpStatus':status,'retryAfter':retry_after,'requestId':request_id,'hint':str(self),'time':dt.datetime.now(dt.timezone.utc).isoformat()}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None

def http_request(method, route, bearer, body=None,extra_headers=None):
    # Only fixed API routes constructed by the broker, never a client URL.
    if not route.startswith('/') or '://' in route: raise ValueError('Invalid GitHub route')
    request=urllib.request.Request('https://api.github.com'+route,method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization':'Bearer '+bearer,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':API_VERSION,'Content-Type':'application/json','User-Agent':'Ubuntu-Control-GitHub-App',**(extra_headers or {})})
    try:
        with urllib.request.build_opener(NoRedirect).open(request,timeout=25) as response:
            raw=response.read(16000000)
            if extra_headers and extra_headers.get('Accept')=='application/vnd.github.sha':return {'sha':raw.decode().strip(),'etag':response.headers.get('ETag')}
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        if e.code==304:e.close();return {'notModified':True}
        retry=e.headers.get('Retry-After')
        request_id=e.headers.get('X-GitHub-Request-Id')
        if request_id and not re.fullmatch(r'[A-Za-z0-9:-]{1,100}',request_id):request_id=None
        e.close()
        error=GitHubError(e.code,int(retry) if retry and retry.isdigit() else None,request_id)
        error.details['command']=[method,'https://api.github.com'+route]
        raise error from None
    except (OSError,ValueError):
        raise GitHubError(503) from None

def sign_jwt(app_id, key_path=PEM_PATH, now=None):
    now=int(time.time() if now is None else now)
    p=pathlib.Path(key_path)
    if str(p)!=PEM_PATH or p.is_symlink() or not p.is_file(): raise ValueError('קובץ PEM קבוע חסר או שאינו קובץ רגיל.')
    st=p.stat()
    if st.st_uid!=0 or st.st_mode & 0o027: raise ValueError('קובץ PEM חייב להיות בבעלות root ללא הרשאת כתיבה לקבוצה או גישה לאחרים.')
    encode=lambda value:base64.urlsafe_b64encode(json.dumps(value,separators=(',',':')).encode()).rstrip(b'=')
    unsigned=encode({'alg':'RS256','typ':'JWT'})+b'.'+encode({'iat':now-60,'exp':now+540,'iss':str(app_id)})
    try:
        result=subprocess.run(['/usr/bin/openssl','dgst','-sha256','-sign',PEM_PATH],input=unsigned,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10,check=True)
    except (OSError,subprocess.SubprocessError): raise ValueError('לא ניתן לחתום עם מפתח ה־GitHub App. בדקו מפתח RSA והרשאות.') from None
    return (unsigned+b'.'+base64.urlsafe_b64encode(result.stdout).rstrip(b'=')).decode()

def positive_id(value):
    if isinstance(value,bool) or not re.fullmatch(r'[1-9][0-9]{0,18}',str(value)): raise ValueError('מזהה GitHub אינו תקין.')
    return str(value)

class GitHubApp:
    def __init__(self,state_dir,request=http_request,signer=sign_jwt,clock=time.time):
        self.state=pathlib.Path(state_dir);self.state.mkdir(mode=0o700,parents=True,exist_ok=True)
        self.request=request;self.signer=signer;self.clock=clock;self.tokens={};self.issued={};self.key_stamp=None
        self.config=json.loads((self.state/'config.json').read_text()) if (self.state/'config.json').exists() else {'enabled':False,'appId':'','installationId':''}
        self.last=json.loads((self.state/'status.json').read_text()) if (self.state/'status.json').exists() else {'connection':'not-configured','checkedAt':None,'error':None}

    def persist(self,name,value):
        fd,temp=tempfile.mkstemp(prefix='.'+name,dir=self.state)
        try:
            with os.fdopen(fd,'w') as f: json.dump(value,f);f.flush();os.fsync(f.fileno())
            os.replace(temp,self.state/(name+'.json'))
        finally:
            if os.path.exists(temp):os.unlink(temp)

    def status(self):
        # Explicit allowlist: never serialize token cache, JWTs, key data or API payloads.
        return {'appId':self.config.get('appId',''),'installationId':self.config.get('installationId',''),'enabled':bool(self.config.get('enabled')),
                'connection':self.last.get('connection'),'checkedAt':self.last.get('checkedAt'),'error':self.last.get('error'),'repositoryCount':self.last.get('repositoryCount'),
                'pemPath':PEM_PATH,'keyPresent':os.path.isfile(PEM_PATH)}

    def revoke(self):
        failed=False
        for value,expires in self.issued.items():
            if expires<=self.clock():continue
            try:self.request('DELETE','/installation/token',value)
            except (GitHubError,ValueError):failed=True
        self.tokens.clear();self.issued.clear()
        return failed

    def configure(self,args):
        if set(args)-{'appId','installationId','pemPath'} or args.get('pemPath',PEM_PATH)!=PEM_PATH:raise ValueError('נתיב המפתח קבוע בשרת ואינו ניתן לשינוי מהדפדפן.')
        config={'appId':positive_id(args.get('appId')),'installationId':positive_id(args.get('installationId')),'enabled':True}
        self.revoke();self.config=config;self.persist('config',config)
        self.last={'connection':'unchecked','checkedAt':None,'error':None};self.persist('status',self.last)
        return self.status()

    def disconnect(self):
        failed=self.revoke();self.config['enabled']=False;self.persist('config',self.config)
        self.last={'connection':'disconnected','checkedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'error':'החיבור נותק מקומית; ביטול Tokens ב־GitHub לא אומת. ניתן לבטל את ההתקנה בחשבון GitHub.' if failed else None}
        self.persist('status',self.last);return self.status()

    def token(self,repository_id=None,force=False):
        if not self.config.get('enabled'):raise ValueError('GitHub App אינו מחובר. הגדירו את החיבור במסך ההגדרות.')
        try:
            st=pathlib.Path(PEM_PATH).stat();stamp=(st.st_ino,st.st_mtime_ns,st.st_size)
        except OSError:raise ValueError('קובץ המפתח אינו זמין לשירות GitHub.') from None
        if stamp!=self.key_stamp:
            self.revoke();self.key_stamp=stamp
        key=str(repository_id) if repository_id is not None else 'listing'
        cached=self.tokens.get(key)
        if not force and cached and cached['expires']>self.clock()+300:return cached['value']
        body={'permissions':{'metadata':'read'}}
        if repository_id is not None:body={'repository_ids':[int(repository_id)],'permissions':{'contents':'read','metadata':'read'}}
        result=self.request('POST','/app/installations/'+self.config['installationId']+'/access_tokens',self.signer(self.config['appId']),body)
        try:
            expires=dt.datetime.fromisoformat(result['expires_at'].replace('Z','+00:00')).timestamp()
            value=result['token']
            if not isinstance(value,str) or not value or expires<=self.clock()+60:raise ValueError()
        except (KeyError,TypeError,ValueError):raise GitHubError(502) from None
        self.tokens[key]={'value':value,'expires':expires}
        self.issued={t:e for t,e in self.issued.items() if e>self.clock()};self.issued[value]=expires
        return value

    def authorized_request(self,route):
        try:return self.request('GET',route,self.token())
        except GitHubError as e:
            if e.status!=401:raise
            return self.request('GET',route,self.token(force=True))

    def repositories(self):
        repos=[];page=1
        while True:
            data=self.authorized_request('/installation/repositories?per_page=100&page='+str(page))
            batch=data.get('repositories',[])
            if not isinstance(batch,list):raise GitHubError(502)
            for r in batch:
                if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',r.get('full_name','')):raise GitHubError(502)
                repos.append({'id':int(positive_id(r['id'])),'name':r['name'],'full_name':r['full_name'],'description':r.get('description') or '', 'private':bool(r.get('private')),'default_branch':r.get('default_branch') or 'main','updated_at':r.get('updated_at'),'archived':bool(r.get('archived')),'fork':bool(r.get('fork')),'clone_url':'https://github.com/'+r['full_name']+'.git'})
            if len(batch)<100:break
            page+=1
        return repos

    def repository(self,identifier):
        identifier=int(positive_id(identifier))
        # Re-read installation permissions, including revocations, on every import/token request.
        found=next((r for r in self.repositories() if r['id']==identifier),None)
        if not found:raise GitHubError(404)
        if found['archived']:raise ValueError('המאגר בארכיון ואינו זמין לייבוא במערכת.')
        return found

    def check(self):
        try:
            repos=self.repositories();self.last={'connection':'connected','checkedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'error':None,'repositoryCount':len(repos)}
            self.persist('status',self.last);return self.status()
        except (GitHubError,ValueError) as e:
            self.last={'connection':'error','checkedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'error':str(e)};self.persist('status',self.last);raise

    def dispatch(self,action,args):
        if not isinstance(args,dict):raise ValueError('Invalid GitHub broker arguments')
        if action=='status':return self.status()
        if action=='configure':return self.configure(args)
        if action=='disconnect':return self.disconnect()
        if action=='check':return self.check()
        if action=='repositories':return self.repositories()
        if action=='repository':return self.repository(args['repositoryId'])
        if action=='repository-token':
            repo=self.repository(args['repositoryId'])
            return {'repository':repo,'token':self.token(repo['id'])}
        if action=='head':
            import urllib.parse
            identifier=positive_id(args.get('repositoryId'));name=args.get('fullName','');branch=args.get('branch','')
            if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',name) or not isinstance(branch,str) or not branch or len(branch)>101:raise ValueError('Invalid repository head request')
            # The read-only token is scoped by repository ID; permissions are enforced by GitHub.
            headers={'Accept':'application/vnd.github.sha'}
            etag=args.get('etag')
            if etag and isinstance(etag,str) and len(etag)<200 and not any(ord(c)<32 for c in etag):headers['If-None-Match']=etag
            path='/repos/'+name+'/commits/'+urllib.parse.quote(branch,safe='')
            try:result=self.request('GET',path,self.token(identifier),None,headers)
            except GitHubError as e:
                if e.status!=401:raise
                result=self.request('GET',path,self.token(identifier,force=True),None,headers)
            if not result.get('notModified') and not re.fullmatch(r'[a-f0-9]{40}',result.get('sha','')):raise GitHubError(502)
            return result
        raise ValueError('Unsupported GitHub broker action')

def serve():
    app=GitHubApp('/var/lib/ubuntu-control-github')
    filename='/run/ubuntu-control-github/broker.sock'
    if os.path.exists(filename):os.unlink(filename)
    server=socket.socket(socket.AF_UNIX);server.bind(filename);os.chmod(filename,0o600);server.listen(8)
    # Serialize cache/config mutations; service runs without root capabilities.
    while True:
        conn,_=server.accept()
        with conn:
            try:
                conn.settimeout(120)
                _,uid,_=struct.unpack('3i',conn.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                if uid!=0:raise ValueError('Unauthorized GitHub broker peer')
                data=b''
                while b'\n' not in data:
                    chunk=conn.recv(4096)
                    if not chunk or len(data)>16384:raise ValueError('Invalid broker request')
                    data+=chunk
                request=json.loads(data.split(b'\n')[0]);result=app.dispatch(request['action'],request.get('args',{}))
                conn.sendall((json.dumps({'ok':True,'data':result})+'\n').encode())
            except Exception as e:
                controlled=str(e) if isinstance(e,ValueError) else 'שירות GitHub אינו זמין. בדקו את שירות ה־broker.'
                try:conn.sendall((json.dumps({'ok':False,'error':controlled,'status':getattr(e,'status',400),'retryAfter':getattr(e,'retry_after',None),'details':getattr(e,'details',None)})+'\n').encode())
                except OSError:pass

if __name__=='__main__':serve()
