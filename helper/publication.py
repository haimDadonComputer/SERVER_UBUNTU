"""Typed, root-owned Nginx publication. Never accepts proxy text or executable paths."""
import copy
import hashlib
import datetime
import ipaddress
import json
import pathlib
import re
import socket
import threading
import http.client
import ssl
import time
import collections
from project_secrets import atomic_private
from project_lifecycle import Lifecycle, project_lock, BUILD_LOCK, REGISTRY_LOCK, PROJECT_LOCKS
from project_storage import Storage
from job_progress import emit
from diagnostics import OperationError,exception_details

NETWORK_LOCK=threading.RLock()
CERTIFICATE_CACHE=collections.OrderedDict()
CERTIFICATE_CACHE_LOCK=threading.Lock()
DEFAULT={'ip':'','domain':'','email':'','management':False,'projects':{},'certificates':{},'firewallOwned':[],'projectDomainSuffix':'haimdadon.co.il'}

def valid_domain(value):
    return isinstance(value,str) and len(value)<=253 and re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}',value)

class Publication:
    def __init__(self,cfg,backend):
        self.cfg=cfg;self.h=backend
        self.state=pathlib.Path(cfg.get('state_dir','/var/lib/ubuntu-control-helper'))/'publication'
        self.directory=pathlib.Path(cfg.get('publication_dir','/etc/nginx/ubuntu-control'))
        self.acme=pathlib.Path(cfg.get('publication_acme','/etc/ubuntu-control-publication'))
    def read(self):
        path=self.state/'settings.json'
        if path.is_symlink():raise ValueError('Unsafe publication state')
        return {**copy.deepcopy(DEFAULT),**(json.loads(path.read_text()) if path.exists() else {})}
    def save(self,data):atomic_private(self.state/'settings.json',json.dumps(data))
    def path(self,name):
        if not re.fullmatch(r'(?:challenge|management|project-[a-f0-9]{16})\.conf',name):raise ValueError('Invalid proxy resource')
        p=self.directory/name
        if self.directory.is_symlink() or p.is_symlink():raise ValueError('Unsafe proxy resource')
        return p
    def write(self,name,text):
        atomic_private(self.path(name),text);self.path(name).chmod(0o644)
    def ready(self):
        if not self.directory.is_dir() or self.directory.is_symlink() or not (self.acme/'prepared').is_file():
            raise ValueError('HTTPS preparation is incomplete. Run scripts/upgrade.sh from the source checkout; it prepares Nginx and Certbot automatically')
        self.h['run'](['/usr/sbin/nginx','-t'])
    def certificate_validity(self,path):
        # File identity changes on renewal invalidate immediately. Share probes
        # across status readers, bound entries, and never serve stale success on failure.
        info=path.stat();key=str(path);fingerprint=(info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns)
        with CERTIFICATE_CACHE_LOCK:
            now=time.monotonic();cached=CERTIFICATE_CACHE.get(key)
            if cached and cached['fingerprint']==fingerprint and now-cached['time']<cached['ttl']:
                CERTIFICATE_CACHE.move_to_end(key);return cached['value']
            try:value=self.h['run'](['/usr/bin/openssl','x509','-in',str(path),'-noout','-dates']).strip();ttl=60
            except Exception:value='unavailable';ttl=5
            CERTIFICATE_CACHE[key]={'fingerprint':fingerprint,'time':time.monotonic(),'ttl':ttl,'value':value}
            CERTIFICATE_CACHE.move_to_end(key)
            while len(CERTIFICATE_CACHE)>128:CERTIFICATE_CACHE.popitem(last=False)
            return value
    def status(self):
        data=self.read()
        data['prepared']=(self.acme/'prepared').is_file()
        data['addressConfigured']=bool(data['ip'])
        data['externalReachability']='unverified'
        data['probeDiagnostics']=[]
        try:listeners=self.h['parse_ss'](self.h['run'](['/usr/bin/ss','-H','-lntup']))
        except Exception as error:
            listeners=None;data['probeDiagnostics'].append(exception_details(error,'publication-listeners',self.directory).details)
        for item in data['projects'].values():
            item['listening']=None if listeners is None else any(row.get('address')==data['ip'] and row.get('port')==item['port'] and row.get('process')=='nginx' for row in listeners)
        for kind,cert in data['certificates'].items():
            path=self.acme/'certbot/live'/kind/'cert.pem'
            if path.is_file():
                try:cert['validity']=self.certificate_validity(path)
                except Exception:cert['validity']='unavailable'
        try:data['renewal']=self.h['run'](['/usr/bin/systemctl','show','ubuntu-control-cert-renew.service','-p','Result','-p','ExecMainExitTimestamp'],check=False).strip()
        except Exception as error:
            data['renewal']='unavailable';data['probeDiagnostics'].append(exception_details(error,'publication-renewal',self.directory).details)
        return data
    def settings(self,args):
        data=self.read()
        ip=args.get('ip','');domain=args.get('domain','').lower();email=args.get('email','')
        if ip and (not isinstance(ip,str) or not ipaddress.IPv4Address(ip).is_global):raise ValueError('A public IPv4 address is required')
        if domain and (not isinstance(domain,str) or len(domain)>253 or not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}',domain)):raise ValueError('Invalid management domain')
        if email and (not isinstance(email,str) or not re.fullmatch(r'[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}',email)):raise ValueError('Invalid certificate email')
        if (data['management'] or data['projects']) and any(data[k]!=v for k,v in (('ip',ip),('domain',domain),('email',email))):raise ValueError('Disable publication before changing server addresses or certificate contact')
        data.update(ip=ip,domain=domain,email=email);self.save(data);return self.status()
    def interfaces(self,ip):
        rows=json.loads(self.h['run'](['/usr/sbin/ip','-j','-4','address','show']))
        if not any(a.get('local')==ip for row in rows for a in row.get('addr_info',[])):raise ValueError('Public IP is not assigned to this server interface; NAT requires operator configuration')
    def listeners(self,ip,port,owned=False):
        rows=self.h['parse_ss'](self.h['run'](['/usr/bin/ss','-H','-lntup']))
        for row in rows:
            if row.get('port')==port and row.get('address') in (ip,'0.0.0.0','::','*'):
                if owned and row.get('process')=='nginx':continue
                raise ValueError('Public port is already occupied: '+str(port)+'; stop wildcard listeners or choose another public port')
    def fw_status(self):
        output=self.h['run'](['/usr/sbin/ufw','status'])
        active='Status: active' in output
        if active and self.cfg.get('ufw_verified_host_network') is not True:raise ValueError('Verify host networking and set ufw_verified_host_network in root helper configuration before publication')
        return active,output
    def firewall(self,data):
        ports={80} if data['projects'] or data['management'] or data.get('challengePending') else set()
        if data['management']:ports.add(443)
        ports.update(item['port'] for item in data['projects'].values())
        return sorted(ports)
    def fw_rule(self,ip,port,delete=False):
        args=['allow','in','proto','tcp','from','any','to',ip,'port',str(port),'comment','uc-publication-'+str(port)]
        self.h['run'](['/usr/sbin/ufw',*(['--force','delete'] if delete else []),*args])
    def preserve_failure(self,error,recovery):
        try:recovery()
        except Exception as recovery_error:
            primary=exception_details(error,'publication',self.directory)
            details=dict(primary.details);details['hint']=details.get('hint','')+' Recovery also failed; inspect private recovery state before retrying: '+str(recovery_error)
            raise OperationError(str(primary),details) from None
    def verify_project(self,data,identifier,p):
        # Reload signals Nginx asynchronously. Allow a short, bounded grace for
        # its new listener/workers; never retry TLS/host-policy/auth failures.
        for attempt in range(3):
            try:return self.verify_project_once(data,identifier,p)
            except OperationError as error:
                transient=error.details.get('code')=='PUBLICATION_UNREACHABLE' or error.details.get('httpStatus') in (502,503,504)
                if attempt==2 or not transient:raise
                time.sleep(0.25)
    def verify_project_once(self,data,identifier,p):
        """Probe the owned public listener locally, without redirects or bodies.

        Destination is the configured local interface, never a caller URL. TLS
        checks the real public hostname/IP and uses the normal CA trust store.
        This verifies the local proxy path, not the provider firewall or Internet.
        """
        item=data['projects'][identifier];ip=data['ip'];port=item['port']
        if not ipaddress.IPv4Address(ip).is_global or type(port)!=int or not 1<=port<=65535:raise ValueError('Invalid local publication endpoint')
        host=item.get('domain') or ip
        if host!=ip and not valid_domain(host):raise ValueError('Invalid publication hostname')
        path=p['runtime'].get('healthPath','/')
        if not isinstance(path,str) or not path.startswith('/') or path.startswith('//') or len(path)>200 or any(ord(c)<33 for c in path):raise ValueError('Invalid publication health path')
        public_host=host+(':'+str(port) if port!=(443 if item['https'] else 80) else '')
        url=('https' if item['https'] else 'http')+'://'+public_host+path
        emit('publication-health','Checking the public proxy endpoint from this server')
        connection=http.client.HTTPConnection(ip,port,timeout=5)
        try:
            if item['https']:
                connection.connect()
                connection.sock=ssl.create_default_context().wrap_socket(connection.sock,server_hostname=host)
            connection.request('GET',path,headers={'Host':public_host,'Connection':'close'})
            response=connection.getresponse();status=response.status
            if not 200<=status<300:
                raise OperationError('בדיקת כתובת הפרסום נכשלה: HTTP '+str(status),{'code':'PUBLICATION_HTTP_STATUS','stage':'publication-health','httpStatus':status,'stderr':'Local proxy probe: '+url,'hint':'הפרסום לא אושר. בדקו שהאפליקציה מקבלת את שם המארח וה־Origin הציבוריים ושנתיב בדיקת התקינות מחזיר 2xx. תגובת האפליקציה אינה נשמרת בדוח.'})
            item['localCheck']={'status':'passed','httpStatus':status,'url':url,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
        except OperationError:raise
        except (OSError,http.client.HTTPException) as error:
            raise OperationError('לא ניתן לאמת את כתובת הפרסום דרך ה־proxy',{'code':'PUBLICATION_TLS_FAILED' if isinstance(error,ssl.SSLError) else 'PUBLICATION_UNREACHABLE','stage':'publication-health','stderr':'Local proxy probe: '+url+'; '+str(error),'hint':'בדקו האזנת Nginx, תוקף תעודה ותקינות האפליקציה. בדיקה זו נעשית מהשרת ואינה מאמתת את חומת האש אצל ספק השרת.'}) from None
        finally:
            try:connection.close()
            except OSError:pass
    def transaction(self,before,after,changes,verify=None):
        pending=self.state/'pending.json'
        if pending.exists():raise ValueError('Publication recovery is pending; inspect helper diagnostics')
        old={name:self.path(name).read_text() if self.path(name).exists() else None for name in changes}
        old_ports=set(before.get('firewallOwned',[]));desired=set(self.firewall(after))
        active,rules=self.fw_status()
        new_ports=desired if active else old_ports & desired
        after['firewallOwned']=sorted(new_ports)
        for port in new_ports-old_ports:
            # Never take ownership of a pre-existing unlabelled host rule.
            if any(str(port)+'/tcp' in line and after['ip'] in line and 'ALLOW' in line and 'uc-publication-'+str(port) not in line for line in rules.splitlines()):
                raise ValueError('An existing firewall rule covers this endpoint; resolve ownership before managed publication')
        journal={'before':before,'files':old,'added':sorted(new_ports-old_ports),'removed':sorted(old_ports-new_ports),'ip':after['ip'] or before['ip']}
        # A private, durable backup also remains after a successful change.
        atomic_private(self.state/('backup-'+str(__import__('time').time_ns())+'.json'),json.dumps(journal))
        atomic_private(pending,json.dumps(journal))
        try:
            emit('proxy-configuration','Writing managed proxy configuration')
            for name,text in changes.items():
                if text is None:self.path(name).unlink(missing_ok=True)
                else:self.write(name,text)
            emit('proxy-validation','Checking Nginx configuration')
            self.h['run'](['/usr/sbin/nginx','-t'])
            for port in journal['added']:self.fw_rule(journal['ip'],port)
            emit('proxy-reload','Applying validated proxy configuration')
            self.h['run'](['/usr/bin/systemctl','reload','nginx.service'])
            if verify is not None:verify()
            for port in journal['removed']:self.fw_rule(journal['ip'],port,True)
            self.save(after);pending.unlink()
        except Exception as error:
            self.preserve_failure(error,self.recover);raise
    def recover(self):
        path=self.state/'pending.json'
        if not path.exists():return
        journal=json.loads(path.read_text())
        for name,text in journal['files'].items():
            if text is None:self.path(name).unlink(missing_ok=True)
            else:self.write(name,text)
        self.h['run'](['/usr/sbin/nginx','-t'])
        self.h['run'](['/usr/bin/systemctl','reload','nginx.service'])
        for port in journal['added']:self.fw_rule(journal['ip'],port,True)
        for port in journal['removed']:self.fw_rule(journal['ip'],port)
        self.save(journal['before']);path.unlink()
    def clear_bootstrap(self):
        data=self.read()
        if data.get('challengePending'):
            restored=copy.deepcopy(data);restored.pop('challengePending',None)
            self.transaction(data,restored,{'challenge.conf':None})
    def challenge(self,data):
        domains=([data['domain']] if data.get('management') and data.get('domain') else [])+[item['domain'] for item in data['projects'].values() if item.get('domain')]
        redirect=''.join(' if ($host = '+domain+') { return 308 https://'+domain+'$request_uri; }' for domain in sorted(set(domains)))
        return 'server {\n listen '+data['ip']+':80;\n server_name _;\n location ^~ /.well-known/acme-challenge/ { root /var/lib/ubuntu-control-acme; }\n location / {'+redirect+' return 404; }\n}\n'
    def cert_path(self,kind):return self.acme/'certbot/live'/kind
    def certificate(self,kind,identifier,data,staging=False):
        if not data['email']:raise ValueError('Certificate email is required')
        version=self.h['run'](['/opt/ubuntu-control-acme/bin/certbot','--version'])
        match=re.search(r'(\d+)\.(\d+)',version)
        if not match or tuple(map(int,match.groups()))<(5,4):raise ValueError('Certbot 5.4 or newer required')
        args=['/opt/ubuntu-control-acme/bin/certbot','certonly','--non-interactive','--agree-tos','--email',data['email'],'--webroot','--webroot-path','/var/lib/ubuntu-control-acme','--config-dir',str(self.acme/'certbot'),'--work-dir',str(self.state/'acme-work'),'--logs-dir',str(self.state/'acme-logs'),'--cert-name',kind]
        if kind=='ip':args+=['--ip-address',identifier,'--preferred-profile','shortlived']
        else:args+=['-d',identifier]
        if staging:args+=['--dry-run']
        emit('certificate','Validating certificate request')
        try:self.h['run'](args,timeout=240)
        except Exception:
            latest=self.read();latest['certificates'][kind]={'status':'failed','checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()};self.save(latest);raise
        if not staging:
            data['certificates'][kind]={'status':'issued','checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    def proxy(self,data,port,upstream,tls,management=False,storage=(),domain='',certificate_kind=None):
        name=data['domain'] if management else domain or data['ip']
        lines=['server {',' listen '+data['ip']+':'+str(port)+(' ssl' if tls else '')+';',' server_name '+name+';']
        if management:lines+=[' client_max_body_size 7m;']
        if tls:
            cert=self.cert_path(certificate_kind or ('management' if management else 'ip'))
            lines+=[' ssl_certificate '+str(cert/'fullchain.pem')+';',' ssl_certificate_key '+str(cert/'privkey.pem')+';',' ssl_protocols TLSv1.2 TLSv1.3;']
        if management or domain:lines+=[' if ($host != '+name+') { return 444; }']
        if not management:
            lines+=[' location ~* '+json.dumps(r'(^|/)(uploads?|shared|\.control-releases)(/|$)')+' { return 404; }']
            for path in storage:lines+=[' location ~* '+json.dumps('^/'+re.escape(path)+'(?:/|$)',ensure_ascii=False)+' { return 404; }']
        lines+=[' location / {',' proxy_pass http://127.0.0.1:'+str(upstream)+';',' proxy_http_version 1.1;',' proxy_set_header Host $http_host;',' proxy_set_header X-Forwarded-Host $http_host;',' proxy_set_header X-Forwarded-Proto $scheme;',' proxy_set_header X-Forwarded-For $remote_addr;',' proxy_set_header Upgrade $http_upgrade;',' proxy_set_header Connection "upgrade";',' proxy_read_timeout 3600s;',' }','}']
        return '\n'.join(lines)+'\n'
    def refresh_storage(self,identifier,p):
        with NETWORK_LOCK:
            before=self.read()
            if identifier not in before['projects']:return
            paths=sorted(set([*p.get('writableDirectories',[]),*Storage(Lifecycle(self.cfg,self.h),identifier).catalog()['paths']]))
            after=copy.deepcopy(before);item=after['projects'][identifier];item['storageDirectories']=paths
            name='project-'+Lifecycle(self.cfg,self.h).names(identifier)['key']+'.conf'
            self.transaction(before,after,{name:self.proxy(after,item['port'],item['upstream'],item['https'],storage=paths,domain=item.get('domain',''),certificate_kind=item.get('certificate'))})
    def publish(self,identifier,args):
        before=self.read();data=copy.deepcopy(before)
        if args.get('confirmed') is not True:raise ValueError('Explicit publication confirmation required')
        if type(args.get('enabled'))!=bool or 'https' in args and type(args['https'])!=bool:raise ValueError('Invalid publication flags')
        management=identifier is None
        domain=''
        if management:name='management.conf'
        else:
            life=Lifecycle(self.cfg,self.h);p=life.lookup(identifier,True);name='project-'+life.names(identifier)['key']+'.conf'
        enabled=args.get('enabled') is True
        if not enabled:
            if management:data['management']=False
            else:data['projects'].pop(identifier,None)
            if before==data:return self.status()
            self.ready();changes={name:None}
            if not data['projects'] and not data['management']:changes['challenge.conf']=None
            else:changes['challenge.conf']=self.challenge(data)
            self.transaction(before,data,changes);return self.status()
        self.ready()
        emit('network-preflight','Checking public interface and firewall prerequisites')
        if not data['ip']:raise ValueError('Configure the public server IP first')
        self.interfaces(data['ip'])
        self.fw_status()
        if management:
            if not data['domain']:raise ValueError('Configure a management domain first')
            emit('dns-resolution','Checking '+data['domain'])
            try:resolved={row[4][0] for row in socket.getaddrinfo(data['domain'],443,family=socket.AF_INET)}
            except socket.gaierror as error:
                raise OperationError('לא ניתן לפתור את דומיין הניהול: '+data['domain'],{
                    'code':'MANAGEMENT_DNS_UNRESOLVED','stage':'dns-resolution',
                    'stderr':'Domain: '+data['domain']+'; expected IPv4: '+data['ip']+'; resolver: '+str(error),
                    'hint':'ודאו שהוגדר הדומיין המלא ללא https:// או פורט, שקיימת עבורו רשומת A אל '+data['ip']+', ושהשרת מצליח לפתור אותה. בדקו שמספק ה־DNS לא הוסיף את סיומת הדומיין פעמיים. אם הרשומה חדשה, המתינו לעדכון מטמון ה־DNS ונסו שוב.'}) from None
            if data['ip'] not in resolved:
                raise OperationError('דומיין הניהול אינו מצביע ל־IP שהוגדר',{
                    'code':'MANAGEMENT_DNS_IP_MISMATCH','stage':'dns-resolution',
                    'stderr':'Domain: '+data['domain']+'; expected IPv4: '+data['ip']+'; resolved IPv4: '+', '.join(sorted(resolved)),
                    'hint':'תקנו את רשומת A של '+data['domain']+' כך שתצביע ל־'+data['ip']+', או תקנו את כתובת השרת בהגדרות. הפרסום לא הופעל.'})
            if any(item.get('domain')==data['domain'] for item in data['projects'].values()):raise ValueError('Management domain is already used by a project')
            port=443;upstream=3080;tls=True;previous=data['management'] or any(item['port']==443 for item in data['projects'].values())
        else:
            if p.get('lifecycle','active')!='active' or p.get('ownership')!='managed':raise ValueError('An active managed project is required')
            runtime=p.get('runtime',{})
            if runtime.get('health')!='http' or not runtime.get('port'):raise ValueError('Publication requires an HTTP project')
            if runtime['port']==3080 or runtime['port'] in self.cfg.get('protected_ports',[]):raise ValueError('Cannot proxy a protected management/system port')
            if runtime.get('listenAddress','127.0.0.1')!='127.0.0.1':raise ValueError('Stop project and select localhost listening before proxy publication')
            # A project setting alone is not proof that an existing localhost
            # service belongs to it. Never turn the proxy into an internal-service gateway.
            rows=self.h['parse_ss'](self.h['run'](['/usr/bin/ss','-H','-lntup']))
            for row in rows:
                if row.get('protocol')!='tcp' or row.get('port')!=runtime['port'] or row.get('address') not in ('127.0.0.1','0.0.0.0','::','*'):continue
                if row.get('address')!='127.0.0.1':raise ValueError('Application binds all interfaces; make it honor HOST=127.0.0.1 before proxy publication')
                try:
                    if runtime['kind']=='docker':
                        container=json.loads(life.docker(['inspect','--format','{{json .}}',life.names(identifier)['container']]))
                        bindings=container.get('NetworkSettings',{}).get('Ports',{}).get(str(runtime['internalPort'])+'/tcp') or []
                        owned=container.get('State',{}).get('Running') is True and container.get('Config',{}).get('Labels',{}).get('ubuntu-control.project')==identifier and container.get('Config',{}).get('Image')==p.get('image') and any(b.get('HostIp')=='127.0.0.1' and b.get('HostPort')==str(runtime['port']) for b in bindings)
                    else:owned=any(life.names(identifier)['unit'] in line.split('/') for line in pathlib.Path('/proc/'+str(row['pid'])+'/cgroup').read_text().splitlines())
                except (OSError,KeyError):owned=False
                if not owned:raise ValueError('The existing localhost listener does not belong to this managed project')
            domain=args.get('domain','')
            if isinstance(domain,str) and domain and '.' not in domain:
                if not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?',domain):raise ValueError('Invalid project subdomain')
                suffix=data.get('projectDomainSuffix',DEFAULT['projectDomainSuffix'])
                if not valid_domain(suffix):raise ValueError('Invalid project domain suffix')
                domain=domain+'.'+suffix
            if domain:
                if not valid_domain(domain):raise ValueError('Invalid project domain; enter a hostname without scheme, port or path')
                if domain==data['domain'] or domain.endswith('.'+data['domain']) and data['domain']:raise ValueError('Project domain must be separate from the management hostname')
                if any(key!=identifier and item.get('domain')==domain for key,item in data['projects'].items()):raise ValueError('Domain reserved by another project')
                emit('dns-resolution','Checking '+domain)
                try:resolved={row[4][0] for row in socket.getaddrinfo(domain,443,family=socket.AF_INET)}
                except socket.gaierror:
                    raise OperationError('לא ניתן לפתור את דומיין הפרויקט',{'code':'PROJECT_DNS_UNRESOLVED','stage':'dns-resolution','stderr':domain,'hint':'צרו רשומת A של '+domain+' אל '+data['ip']+' ונסו שוב לאחר עדכון DNS.'}) from None
                if resolved!={data['ip']}:raise OperationError('דומיין הפרויקט אינו מצביע רק לשרת שהוגדר',{'code':'PROJECT_DNS_IP_MISMATCH','stage':'dns-resolution','stderr':domain+' → '+', '.join(sorted(resolved)),'hint':'הגדירו רשומת A יחידה אל '+data['ip']+'.'})
                if before['projects'].get(identifier,{}).get('domain')!=domain:
                    existing=self.h['run'](['/usr/sbin/nginx','-T'])
                    if any(domain in names.split() for names in re.findall(r'\bserver_name\s+([^;]+);',existing)):raise ValueError('Domain already exists in Nginx configuration; existing site was not changed')
            elif not isinstance(domain,str):raise ValueError('Invalid project domain')
            port=443 if domain else args.get('port',runtime['port']);upstream=runtime['port'];tls=bool(domain) or args.get('https') is True
            previous=(port==443 and before['management']) or any(item['port']==port for item in before['projects'].values())
            if not domain and (type(port)!=int or not 1024<=port<=65535 or port==3080 or port in self.cfg.get('protected_ports',[22,80,443,3080])):raise ValueError('Invalid or protected public port')
            if any(key!=identifier and item['port']==port and not (domain and item.get('domain')) for key,item in data['projects'].items()):raise ValueError('Public port reserved by another project')
        emit('port-check','Checking publication port '+str(port))
        self.listeners(data['ip'],port,previous)
        # Challenge listener is a shared managed resource, never take over an existing listener.
        challenge_ready=self.path('challenge.conf').exists()
        self.listeners(data['ip'],80,challenge_ready)
        if not challenge_ready:
            bootstrap=copy.deepcopy(data)
            # Open only the challenge port while obtaining the first certificate.
            bootstrap['challengePending']=True
            self.transaction(before,bootstrap,{'challenge.conf':self.challenge(data)})
            before=self.read()
        try:
            # Separate lineages keep the old domain certificate usable if a
            # domain-change transaction rolls back after issuance.
            certificate_kind='management' if management else 'project-'+life.names(identifier)['key']+'-'+hashlib.sha256(domain.encode()).hexdigest()[:12] if domain else 'ip'
            if tls:self.certificate(certificate_kind,data['domain'] if management else domain or data['ip'],data)
        except Exception as error:
            if not challenge_ready:
                failed=self.read();restored=copy.deepcopy(data);restored['certificates']=failed['certificates']
                self.preserve_failure(error,lambda:self.transaction(failed,restored,{'challenge.conf':None}))
            raise
        if management:data['management']=True
        else:data['projects'][identifier]={'enabled':True,'port':port,'https':tls,'upstream':upstream,'domain':domain,'certificate':certificate_kind,'url':('https' if tls else 'http')+'://'+(domain if domain else data['ip']+':'+str(port))+'/','externalReachability':'unverified'}
        data.pop('challengePending',None)
        changes={name:self.proxy(data,port,upstream,tls,management,storage=() if management else p.get('writableDirectories',[]),domain=domain,certificate_kind=certificate_kind)}
        changes['challenge.conf']=self.challenge(data)
        try:self.transaction(before,data,changes,verify=None if management else lambda:self.verify_project(data,identifier,p))
        except Exception as error:
            if not challenge_ready and not (self.state/'pending.json').exists():self.preserve_failure(error,self.clear_bootstrap)
            raise
        return self.status()

def dispatch_publication(cfg,action,args,backend):
    publication=Publication(cfg,backend)
    if action=='network-status':return publication.status()
    identifier=args.get('project')
    if action=='network-project':identifier=backend['project_identifier'](identifier)
    lock=project_lock(identifier) if identifier else NETWORK_LOCK
    with lock,NETWORK_LOCK:
        with REGISTRY_LOCK:
            if (publication.state/'pending.json').exists():raise ValueError('Publication recovery is pending')
            if (pathlib.Path(cfg.get('state_dir','/var/lib/ubuntu-control-helper'))/'pending.json').exists() or backend['FIREWALL_WORK'].is_set():raise ValueError('A firewall transaction is pending')
            if any(key!=identifier and value.locked() for key,value in PROJECT_LOCKS.items()):raise ValueError('Wait for active project operations before changing publication')
            backend['FIREWALL_WORK'].set()
        try:
            if action=='network-settings':return publication.settings(args)
            if action=='network-project':return publication.publish(identifier,args)
            if action=='network-management':return publication.publish(None,args)
            if action=='network-certificate-test':
                if args.get('confirmed') is not True:raise ValueError('Explicit certificate-test confirmation required')
                data=publication.read();publication.ready();publication.interfaces(data['ip'])
                kind='management' if args.get('kind')=='management' else 'ip'
                temporary=not publication.path('challenge.conf').exists()
                if temporary:
                    publication.listeners(data['ip'],80)
                    staging=copy.deepcopy(data);staging['challengePending']=True
                    publication.transaction(data,staging,{'challenge.conf':publication.challenge(data)})
                try:publication.certificate(kind,data['domain'] if kind=='management' else data['ip'],data,True)
                finally:
                    if temporary:
                        data['certificates']=publication.read()['certificates']
                        publication.transaction(publication.read(),data,{'challenge.conf':None})
                return {'staging':'passed'}
        finally:backend['FIREWALL_WORK'].clear()
    raise ValueError('Unsupported publication action')
