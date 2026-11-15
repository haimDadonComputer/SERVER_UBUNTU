"""Typed, root-owned Nginx publication. Never accepts proxy text or executable paths."""
import copy
import datetime
import ipaddress
import json
import pathlib
import re
import socket
import threading
from project_secrets import atomic_private
from project_lifecycle import Lifecycle, project_lock, BUILD_LOCK, REGISTRY_LOCK, PROJECT_LOCKS
from job_progress import emit

NETWORK_LOCK=threading.RLock()
DEFAULT={'ip':'','domain':'','email':'','management':False,'projects':{},'certificates':{},'firewallOwned':[]}

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
            raise ValueError('Run sudo bash /opt/ubuntu-control/scripts/setup-publication.sh first')
        self.h['run'](['/usr/sbin/nginx','-t'])
    def status(self):
        data=self.read()
        data['prepared']=(self.acme/'prepared').is_file()
        data['addressConfigured']=bool(data['ip'])
        data['externalReachability']='unverified'
        listeners=self.h['parse_ss'](self.h['run'](['/usr/bin/ss','-H','-lntup']))
        for item in data['projects'].values():
            item['listening']=any(row.get('address')==data['ip'] and row.get('port')==item['port'] and row.get('process')=='nginx' for row in listeners)
        for kind,cert in data['certificates'].items():
            path=self.acme/'certbot/live'/kind/'cert.pem'
            if path.is_file():
                try:cert['validity']=self.h['run'](['/usr/bin/openssl','x509','-in',str(path),'-noout','-dates']).strip()
                except Exception:cert['validity']='unavailable'
        result=self.h['run'](['/usr/bin/systemctl','show','ubuntu-control-cert-renew.service','-p','Result','-p','ExecMainExitTimestamp'],check=False)
        data['renewal']=result.strip()
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
    def transaction(self,before,after,changes):
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
            for name,text in changes.items():
                if text is None:self.path(name).unlink(missing_ok=True)
                else:self.write(name,text)
            self.h['run'](['/usr/sbin/nginx','-t'])
            for port in journal['added']:self.fw_rule(journal['ip'],port)
            self.h['run'](['/usr/bin/systemctl','reload','nginx.service'])
            for port in journal['removed']:self.fw_rule(journal['ip'],port,True)
            self.save(after);pending.unlink()
        except Exception:
            self.recover();raise
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
        return 'server {\n listen '+data['ip']+':80;\n server_name _;\n location ^~ /.well-known/acme-challenge/ { root /var/lib/ubuntu-control-acme; }\n location / { return 404; }\n}\n'
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
    def proxy(self,data,port,upstream,tls,management=False):
        name=data['domain'] if management else data['ip']
        lines=['server {',' listen '+data['ip']+':'+str(port)+(' ssl' if tls else '')+';',' server_name '+name+';']
        if tls:
            cert=self.cert_path('management' if management else 'ip')
            lines+=[' ssl_certificate '+str(cert/'fullchain.pem')+';',' ssl_certificate_key '+str(cert/'privkey.pem')+';',' ssl_protocols TLSv1.2 TLSv1.3;']
        if management:lines+=[' if ($host != '+name+') { return 444; }']
        lines+=[' location / {',' proxy_pass http://127.0.0.1:'+str(upstream)+';',' proxy_http_version 1.1;',' proxy_set_header Host $host;',' proxy_set_header X-Forwarded-Proto $scheme;',' proxy_set_header X-Forwarded-For $remote_addr;',' proxy_set_header Upgrade $http_upgrade;',' proxy_set_header Connection "upgrade";',' proxy_read_timeout 3600s;',' }','}']
        return '\n'.join(lines)+'\n'
    def publish(self,identifier,args):
        before=self.read();data=copy.deepcopy(before)
        if args.get('confirmed') is not True:raise ValueError('Explicit publication confirmation required')
        if type(args.get('enabled'))!=bool or 'https' in args and type(args['https'])!=bool:raise ValueError('Invalid publication flags')
        management=identifier is None
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
            self.transaction(before,data,changes);return self.status()
        self.ready()
        if not data['ip']:raise ValueError('Configure the public server IP first')
        self.interfaces(data['ip'])
        self.fw_status()
        if management:
            if not data['domain']:raise ValueError('Configure a management domain first')
            resolved={row[4][0] for row in socket.getaddrinfo(data['domain'],443,family=socket.AF_INET)}
            if data['ip'] not in resolved:raise ValueError('Management DNS does not resolve to configured server IP')
            port=443;upstream=3080;tls=True;previous=data['management']
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
            port=args.get('port',runtime['port']);upstream=runtime['port'];tls=args.get('https') is True;previous=identifier in data['projects']
            if type(port)!=int or not 1024<=port<=65535 or port==3080 or port in self.cfg.get('protected_ports',[22,80,443,3080]):raise ValueError('Invalid or protected public port')
            if any(key!=identifier and item['port']==port for key,item in data['projects'].items()):raise ValueError('Public port reserved by another project')
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
            if tls:self.certificate('management' if management else 'ip',data['domain'] if management else data['ip'],data)
        except Exception:
            if not challenge_ready:
                failed=self.read();restored=copy.deepcopy(data);restored['certificates']=failed['certificates']
                self.transaction(failed,restored,{'challenge.conf':None})
            raise
        if management:data['management']=True
        else:data['projects'][identifier]={'enabled':True,'port':port,'https':tls,'upstream':upstream,'url':('https' if tls else 'http')+'://'+data['ip']+':'+str(port)+'/','externalReachability':'unverified'}
        data.pop('challengePending',None)
        try:self.transaction(before,data,{name:self.proxy(data,port,upstream,tls,management)})
        except Exception:
            if not challenge_ready and not (self.state/'pending.json').exists():self.clear_bootstrap()
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
