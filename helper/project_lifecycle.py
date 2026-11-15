"""Root-owned project lifecycle. Inputs are typed; code always runs unprivileged."""
import contextlib
import hashlib
import json
import os
import pathlib
import re
import shutil
import threading
import time
import urllib.request
import uuid
import stat
from diagnostics import OperationError,clean,redact
from project_secrets import atomic_private,read_values,patch_values
from job_progress import emit
from project_storage import Storage,validate_directories,migrate_shared,systemd_state_path

REGISTRY_LOCK=threading.RLock()
BUILD_LOCK=threading.Lock()
PROJECT_LOCKS={}

@contextlib.contextmanager
def project_lock(identifier):
    with REGISTRY_LOCK:
        lock=PROJECT_LOCKS.setdefault(identifier,threading.Lock())
        if not lock.acquire(blocking=False):raise OperationError('פעולה אחרת כבר מתבצעת על הפרויקט',{'code':'PROJECT_BUSY','stage':'project-lock'})
    try:yield
    finally:lock.release()

def timestamp():return time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())

def validate_runtime(value,options):
    if not isinstance(value,dict):raise ValueError('Runtime configuration is required')
    kind=value.get('kind','node')
    if kind not in ('node','docker'):raise ValueError('Unsupported runtime')
    args=value.get('args',[])
    if not isinstance(args,list) or len(args)>40 or any(not isinstance(x,str) or len(x)>1024 or any(ord(c)<32 for c in x) for x in args):raise ValueError('Arguments must be a list without control characters')
    health=value.get('health','http')
    if health not in ('http','process'):raise ValueError('Invalid health check')
    port=value.get('port') or None
    if port is not None and (type(port)!=int or not 1024<=port<=65535):raise ValueError('Invalid host port')
    path=value.get('healthPath','/')
    if not isinstance(path,str) or not path.startswith('/') or path.startswith('//') or len(path)>200 or any(ord(c)<33 for c in path):raise ValueError('Invalid local health path')
    if health=='http' and port is None:raise ValueError('HTTP health checks require a port')
    result={'kind':kind,'args':args,'health':health,'port':port,'healthPath':path,'autostart':value.get('autostart') is True,'testScript':value.get('testScript',''),'buildScript':value.get('buildScript','')}
    install=value.get('dependencyInstall','install')
    if install not in ('locked','allow-install','install'):raise ValueError('Invalid dependency install policy')
    result['dependencyInstall']=install
    listen=value.get('listenAddress','127.0.0.1')
    if listen not in ('127.0.0.1','0.0.0.0'):raise ValueError('Invalid listen address')
    result['listenAddress']=listen
    result['storageDirectories']=validate_directories(value.get('storageDirectories',[]))
    for field in ('testScript','buildScript'):
        if result[field] and result[field] not in options.get('scripts',[]):raise ValueError('Select an existing package.json script')
    if kind=='node':
        mode=value.get('mode','npm')
        if mode not in ('npm','entry'):raise ValueError('Invalid Node launch mode')
        result['mode']=mode
        if mode=='npm':
            script=value.get('script','start')
            if script not in options.get('scripts',[]) or not re.fullmatch(r'[A-Za-z0-9:_-]{1,80}',script):raise ValueError('Select an existing start script')
            result['script']=script
        else:
            entry=value.get('entry','')
            if entry not in options.get('entries',[]):raise ValueError('Select an existing Node entry file')
            result['entry']=entry
    else:
        if not options.get('dockerfile'):raise ValueError('A project Dockerfile is required')
        internal=value.get('internalPort',3000)
        if type(internal)!=int or not 1<=internal<=65535:raise ValueError('Invalid container port')
        data=value.get('dataPath','/app/shared')
        if not isinstance(data,str) or not re.fullmatch(r'/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+',data) or data.split('/')[1] in ('proc','sys','dev','run','etc'):raise ValueError('Invalid container data path')
        result.update(internalPort=internal,dataPath=data)
    return result

class Lifecycle:
    def __init__(self,cfg,backend):self.cfg=cfg;self.h=backend
    def transaction_path(self,identifier):return pathlib.Path(self.cfg.get('state_dir','/var/lib/ubuntu-control-helper'))/'runtime-transactions'/(identifier+'.json')
    def begin(self,identifier,p,operation,**fields):
        path=self.transaction_path(identifier)
        if path.exists():raise OperationError('Project recovery is pending; inspect the helper and restart it after resolving the failure',{'code':'PROJECT_RECOVERY_PENDING','stage':'recovery'})
        self.transaction=uuid.uuid4().hex
        atomic_private(path,json.dumps({'id':self.transaction,'project':identifier,'operation':operation,'before':p,**fields}))
    def finish(self,identifier):self.transaction_path(identifier).unlink(missing_ok=True)
    def lookup(self,identifier,archived=False):
        self.h['project_identifier'](identifier)
        p=self.h['all_projects'](self.cfg).get(identifier)
        if not p or p.get('lifecycle')=='deleted':raise ValueError('Project not found')
        if not archived and p.get('lifecycle','active')!='active':raise ValueError('Project is archived or unavailable')
        # Validate scope even for archive operations; never trust an HTTP path.
        root=pathlib.Path(p['root']);base=pathlib.Path(self.cfg.get('project_root','/srv/ubuntu-projects')).resolve()
        if not root.is_absolute() or root.is_symlink() or root.parent.resolve()!=base:raise ValueError('Lifecycle operations require a direct project directory under project_root')
        return dict(p)
    def save(self,identifier,p,committed=False):
        if committed:p['operationId']=self.transaction
        with REGISTRY_LOCK:
            registry=self.h['read_project_registry'](self.cfg);registry[identifier]=p;self.h['write_project_registry'](self.cfg,registry)
        return self.public(identifier,p)
    def public(self,identifier,p):
        keys=('root','service','kind','repo','branch','auth','github_repository_id','health_port','runtime','ownership','lifecycle','desired','updates','remoteCommit','preparedCommit','activeCommit','failedCommit','checkedAt','deployedAt','deployment','archivedAt','writableDirectories')
        pending=self.transaction_path(identifier).exists()
        if pending:
            try:pending=json.loads(self.transaction_path(identifier).read_text()).get('id')!=p.get('operationId')
            except (OSError,ValueError):pass
        return {'id':identifier,**{k:p[k] for k in keys if k in p},'lifecycle':p.get('lifecycle','active'),'updates':p.get('updates','manual'),'recoveryPending':pending}
    def names(self,identifier):
        key=hashlib.sha256(identifier.encode()).hexdigest()[:16]
        return {'key':key,'build':'uc-build-'+key,'unit':'uc-project-'+key+'.service','container':'uc-project-'+key,'volume':'uc-data-'+key,'state':'ubuntu-control-projects/'+key}
    def env_path(self,identifier):return pathlib.Path(self.cfg.get('env_dir','/etc/ubuntu-control/projects'))/(identifier+'.env')
    def secret_values(self,identifier,p=None):
        p=p or self.lookup(identifier,True)
        filename=self.env_path(identifier)
        if p.get('lifecycle')=='archived':filename=self.archive_paths(identifier,p)[1]/filename.name
        return tuple(v for k,v in read_values(filename).items() if k not in p.get('publicBuild',[]) and v)
    def redact(self,identifier,text):return redact(text,self.secret_values(identifier))
    def options(self,identifier):return json.loads(self.h['project_run'](self.cfg,self.lookup(identifier),['options']))
    def metadata(self,identifier):
        p=self.lookup(identifier);values=read_values(self.env_path(identifier))
        return {'keys':sorted(values),'publicBuild':p.get('publicBuild',[]),'restartRequired':p.get('envPending',False),'buildRequired':p.get('runtimePending',False)}
    def identifier(self,p):return p['service'][3:] if p.get('ownership')=='managed' else next((key for key,value in self.h['all_projects'](self.cfg).items() if value['root']==p['root']),pathlib.Path(p['root']).name)
    def metadata_values(self,p):
        identifier=self.identifier(p)
        values=read_values(self.env_path(identifier))
        return {k:values[k] for k in p.get('publicBuild',[]) if k in values}
    def qr(self,identifier):
        p=self.lookup(identifier)
        if not p.get('qr_enabled') or p.get('runtime',{}).get('kind')!='node':raise ValueError('QR integration is not enabled for this Node project')
        data=pathlib.Path('/var/lib')/self.names(identifier)['state']
        if data.is_symlink():
            if data.lstat().st_uid!=0 or data.resolve()!=pathlib.Path('/var/lib/private')/self.names(identifier)['state']:raise ValueError('Unsafe state link')
            data=data.resolve()
        with contextlib.ExitStack() as stack:
            fd=os.open(data,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);stack.callback(os.close,fd)
            directory=os.open('whatsapp',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);stack.callback(os.close,directory)
            file=os.open('qr.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory);stack.callback(os.close,file)
            info=os.fstat(file)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>10000:raise ValueError('Invalid QR payload')
            payload=json.loads(os.read(file,10001))
        if not isinstance(payload.get('qr'),str) or len(payload['qr'])>5000 or not time.time()*1000<payload.get('expires',0)<time.time()*1000+120000:raise ValueError('QR is missing or expired')
        return {'qr':payload['qr'],'expires':payload['expires']}
    def environment(self,identifier,args):
        p=self.lookup(identifier)
        old=read_values(self.env_path(identifier));old_public=set(p.get('publicBuild',[]))
        public=args.get('publicBuild',[key for key in p.get('publicBuild',[]) if key not in args.get('unset',[])])
        result=patch_values(self.env_path(identifier),args.get('set',{}),args.get('unset',[]),public,args.get('importEmpty') is True)
        changed=old_public!=set(result['publicBuild']) or any(key in result['publicBuild'] and value!='' and old.get(key)!=value for key,value in args.get('set',{}).items())
        p.update(publicBuild=result['publicBuild'],envPending=True,runtimePending=p.get('runtimePending',False) or changed);self.save(identifier,p)
        result['buildRequired']=p['runtimePending']
        return result
    def configure(self,identifier,args):
        p=self.lookup(identifier)
        if p.get('service') and p.get('ownership')!='managed' and args.get('replaceExternal') is not True:raise ValueError('Explicit conversion approval is required for an externally managed service')
        if p.get('service') and p.get('ownership')!='managed':self.assert_unshared(identifier,p)
        runtime=validate_runtime(args.get('runtime'),self.options(identifier))
        from publication import Publication
        publication=Publication(self.cfg,self.h).read()['projects'].get(identifier)
        if publication and (runtime['listenAddress']!='127.0.0.1' or runtime['port']!=p.get('runtime',{}).get('port')):raise ValueError('Disable public access before changing the project listen address or port')
        if self.state(p).get('active')=='active':raise ValueError('Stop the project before changing runtime configuration')
        if runtime['port']:
            for other_id,other in self.h['all_projects'](self.cfg).items():
                if other_id!=identifier and other.get('lifecycle','active')=='active' and other.get('runtime',{}).get('port')==runtime['port']:raise ValueError('Port is reserved by another project')
        if p.get('service') and p.get('ownership')!='managed':p['externalService']=p['service']
        p.update(runtime=runtime,runtimePending=True,ownership='managed',service='uc:'+identifier,kind=runtime['kind'],health_port=runtime['port'],desired='stopped')
        self.save(identifier,p);return self.public(identifier,p)
    def state(self,p):
        if not p.get('service'):return {'active':'unmanaged'}
        kind,unit=self.service_ref(p)
        if kind=='docker':
            state=json.loads(self.h['run'](['/usr/bin/docker','inspect','--format','{{json .State}}',unit]))
            return {'active':'active' if state.get('Running') else 'inactive','pid':str(state.get('Pid',0)),'restarts':'0'}
        if kind=='pm2':
            item=next((x for x in json.loads(self.h['pm2'](self.cfg,['jlist'])) if x.get('name')==unit),{})
            return {'active':'active' if item.get('pm2_env',{}).get('status')=='online' else 'inactive','pid':str(item.get('pid',0)),'restarts':str(item.get('pm2_env',{}).get('restart_time',0))}
        output=self.h['run'](['/usr/bin/systemctl','show',unit,'-p','ActiveState','-p','MainPID','-p','NRestarts','-p','UnitFileState'],check=False)
        props=dict(line.split('=',1) for line in output.splitlines() if '=' in line)
        return {'active':props.get('ActiveState','unknown'),'pid':props.get('MainPID','0'),'restarts':props.get('NRestarts','0'),'enabled':props.get('UnitFileState')=='enabled'}
    def service_ref(self,p):
        if p.get('ownership')=='managed':return ('systemd',self.names(p['service'][3:])['unit'])
        item=self.h['service'](self.cfg,p['service']);return item['kind'],item['name']
    def assert_unshared(self,identifier,p):
        resource=self.service_ref(p)
        others=[key for key,value in self.h['all_projects'](self.cfg).items() if key!=identifier and value.get('service') and value.get('lifecycle','active')=='active' and self.service_ref(value)==resource]
        if others:raise ValueError('Service is shared by other projects: '+', '.join(others))
    def docker(self,args,timeout=30,build_unit=None):
        import pwd
        try:uid=pwd.getpwnam('ubuntu-docker').pw_uid
        except KeyError:raise ValueError('Rootless Docker user is missing. Run scripts/setup-rootless-docker.sh first.') from None
        if uid==0:raise ValueError('Rootless Docker must use a non-root dedicated account')
        argv=['/usr/bin/env',f'DOCKER_HOST=unix:///run/user/{uid}/docker.sock',f'XDG_RUNTIME_DIR=/run/user/{uid}','/usr/bin/docker',*args]
        if build_unit:return self.h['build_run'](build_unit,'ubuntu-docker','ubuntu-docker',argv,timeout)
        return self.h['run'](['/usr/sbin/runuser','-u','ubuntu-docker','--',*argv],timeout=timeout)
    def unit_text(self,identifier,p):
        n=self.names(identifier);r=p['runtime'];env=self.env_path(identifier);launch=env.with_suffix('.runtime.json')
        # WorkingDirectory is a scalar path, not a shell/JSON word. PID1 does
        # not remove surrounding quotes here. List directives do unquote words.
        def scalar(text):
            value=str(text)
            if any(ord(c)<32 for c in value) or value!=value.strip():raise ValueError('Unsupported control/edge whitespace in systemd path')
            return value.replace('%','%%')
        q=lambda text:json.dumps(scalar(text),ensure_ascii=False)
        lines=['[Unit]','Description=Ubuntu Control project '+identifier,'After=network-online.target ubuntu-control-helper.service','Wants=ubuntu-control-helper.service','[Service]','Type=simple','WorkingDirectory='+scalar(pathlib.Path(p['root'])/'current'),'ExecStart=/usr/bin/python3 /opt/ubuntu-control/helper/runtime_launcher.py','LoadCredential=launch:'+scalar(launch),'LoadCredential=environment:'+scalar(env),'Restart=on-failure','RestartSec=5','KillMode=control-group','UMask=0077','NoNewPrivileges=true','ProtectSystem=strict','ProtectHome=true','PrivateTmp=true','ProtectKernelTunables=true','ProtectKernelModules=true','ProtectControlGroups=true','RestrictSUIDSGID=true','LimitCORE=0','ReadOnlyPaths='+q(p['root']),'InaccessiblePaths=-/etc/ubuntu-control -/var/lib/ubuntu-control -/var/lib/ubuntu-control-helper -/var/lib/ubuntu-control-github']
        # BindPaths splits source:destination while unquoting each component.
        # Quoting the whole pair hides the separator and makes it one source path.
        if r['kind']=='node':
            lines+=['DynamicUser=true','User=ucp-'+n['key'],'SupplementaryGroups=ubuntu-projects','StateDirectory='+n['state'],'StateDirectoryMode=0700','BindPaths='+q('/var/lib/'+n['state'])+':'+q(p['root']+'/shared'),'ReadWritePaths='+q(p['root']+'/shared'),'InaccessiblePaths=-/var/lib/ubuntu-projects -/var/lib/ubuntu-docker']
            storage=p.get('storage',{})
            if storage.get('view'):
                lines+=['BindReadOnlyPaths='+q(storage['view'])+':'+q(p['root']),'NoExecPaths='+q(p['root']+'/shared'),'NoExecPaths='+q('/var/lib/'+n['state'])]
                for state_name in sorted(set(entry['state'] for entry in storage['directories'])):lines+=['StateDirectory='+state_name]
                for entry in storage['directories']:
                    for target in (p['root']+'/'+entry['path'],p['root']+'/.control-releases/'+p['release']+'/'+entry['path']):
                        lines+=['BindPaths='+q(entry['source'])+':'+q(target),'ReadWritePaths='+q(target),'NoExecPaths='+q(target)]
                    lines+=['NoExecPaths='+q(entry['source'])]
        else:
            import pwd
            docker_uid=pwd.getpwnam('ubuntu-docker').pw_uid
            lines+=['User=ubuntu-docker','Group=ubuntu-docker','SupplementaryGroups=ubuntu-projects','ProtectHome=read-only',f'ExecStop=-/usr/bin/docker --host unix:///run/user/{docker_uid}/docker.sock stop --time 20 '+n['container'],'TimeoutStopSec=35']
        lines+=['StandardOutput=journal','StandardError=journal','SyslogLevelPrefix=true']
        return '\n'.join([*lines,'[Install]','WantedBy=multi-user.target',''])
    def provision(self,identifier,p):
        n=self.names(identifier);env=self.env_path(identifier)
        if not env.exists():atomic_private(env,'')
        payload={'id':identifier,'root':p['root'],'runtime':p['runtime'],'publicBuild':p.get('publicBuild',[]),**{k:n[k] for k in ('container','volume')}}
        if p.get('image'):payload['image']=p['image']
        if p['runtime']['kind']=='node':
            if any(line.split(':',1)[0]=='ucp-'+n['key'] for line in pathlib.Path('/etc/passwd').read_text().splitlines()):raise ValueError('Managed DynamicUser identity conflicts with a static system account')
            # Only root-owned StateDirectory paths are used; persistent data stays outside releases.
            state_base=pathlib.Path('/var/lib/ubuntu-control-projects');state_base.mkdir(mode=0o755,exist_ok=True)
            if state_base.is_symlink():raise ValueError('Unsafe project state base')
            state_base.chmod(0o755)
            # systemd may replace this with its own root-owned private-state symlink.
            data=systemd_state_path(pathlib.Path('/var/lib')/n['state'],pathlib.Path('/var/lib/private')/n['state'])
            data.mkdir(mode=0o700,parents=True,exist_ok=True)
            shared=pathlib.Path(p['root'])/'shared'
            if shared.is_symlink():raise ValueError('Symlink persistent-data paths are prohibited')
            shared.mkdir(mode=0o700,exist_ok=True)
            if any(shared.iterdir()):
                migration=migrate_shared(shared,data,self.cfg.get('state_dir','/var/lib/ubuntu-control-helper'),identifier)
                if migration:emit('storage-prepare',text='Legacy shared data backed up and merged; existing private values retained. Conflicts preserved in root-only backup: '+str(migration['conflicts']))
        else:
            info=json.loads(self.docker(['info','--format','{{json .SecurityOptions}}']))
            if not any('rootless' in str(x) for x in info):raise ValueError('Docker engine must be rootless')
            self.docker(['volume','create','--label','ubuntu-control.project='+identifier,n['volume']])
            if self.docker(['volume','inspect','--format','{{index .Labels "ubuntu-control.project"}}',n['volume']]).strip()!=identifier:raise ValueError('Docker volume is not owned by this project')
        live=self.state(p).get('active')=='active'
        if not live and p['runtime']['kind']=='node':
            try:
                with BUILD_LOCK:p['storage']=Storage(self,identifier).prepare(p)
            except (ValueError,OSError) as error:
                if isinstance(error,OperationError):raise
                raise OperationError('הכנת תיקיות הנתונים נכשלה',{'code':'STORAGE_PREPARATION_FAILED','stage':'storage-prepare','stderr':str(error),'hint':'בדקו את רשימת תיקיות הנתונים ואת נתיבי ההעלאה. Symlinks, hardlinks ונתונים סותרים נחסמים ללא מחיקת המקור; אין לפתוח הרשאות לכל גרסת הקוד.'}) from None
            p['writableDirectories']=[entry['path'] for entry in p['storage']['directories']]
        if p.get('storage'):payload['storage']=p['storage']
        atomic_private(env.with_suffix('.runtime.json'),json.dumps(payload))
        if p['runtime']['kind']=='node':
            from publication import Publication
            Publication(self.cfg,self.h).refresh_storage(identifier,p)
        unit_dir=pathlib.Path(self.cfg.get('unit_dir','/run/systemd/system'))
        atomic_private(unit_dir/n['unit'],self.unit_text(identifier,p));(unit_dir/n['unit']).chmod(0o644)
        self.h['run'](['/usr/bin/systemctl','daemon-reload'])
        self.h['run'](['/usr/bin/systemctl','enable' if p['runtime']['autostart'] else 'disable','--runtime',n['unit']])
    def health(self,identifier,p):
        initial=self.state(p);r=p['runtime'];deadline=time.monotonic()+(20 if r['health']=='process' else 45)
        while True:
            state=self.state(p)
            if state['active']!='active' or state.get('restarts')!=initial.get('restarts'):raise ValueError('Service exited or restarted during health check')
            if r['health']=='http':
                try:
                    # No redirects to arbitrary hosts: a redirect is not a successful health check.
                    request=urllib.request.Request('http://127.0.0.1:'+str(r['port'])+r['healthPath'])
                    class NoRedirect(urllib.request.HTTPRedirectHandler):
                        def redirect_request(self,*a,**kw):return None
                    with urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect).open(request,timeout=2) as response:
                        if 200<=response.status<300 and self.http_owned(identifier,p):return
                except OSError:pass
                if time.monotonic()>=deadline:raise ValueError('HTTP health check failed or the listener does not belong to this project')
            elif time.monotonic()>=deadline:return
            time.sleep(1)
    def http_owned(self,identifier,p):
        if p['runtime']['kind']=='docker':
            value=self.docker(['inspect','--format','{{json .State.Running}}|{{.Config.Image}}|{{index .Config.Labels "ubuntu-control.project"}}',self.names(identifier)['container']]).strip()
            return value=='true|'+p.get('image','')+'|'+identifier
        # Keep Netid in ss output, as required by the shared TCP/UDP parser.
        output=self.h['run'](['/usr/bin/ss','-H','-lntup','sport = :'+str(p['runtime']['port'])])
        from publication import Publication
        published=identifier in Publication(self.cfg,self.h).read()['projects']
        unit=self.names(identifier)['unit']
        for row in self.h['parse_ss'](output):
            if row.get('pid') and row.get('protocol')=='tcp':
                if published and row.get('address') in ('0.0.0.0','::','*'):raise ValueError('Published projects must bind HOST=127.0.0.1; wildcard listening would bypass the proxy')
                if p['runtime'].get('listenAddress')=='0.0.0.0' and row.get('address') not in ('0.0.0.0','::','*'):continue
                try:
                    if any(unit in line.split('/') for line in pathlib.Path('/proc/'+str(row['pid'])+'/cgroup').read_text().splitlines()):return True
                except OSError:pass
        return False
    def release(self,identifier,p,expected=None):
        with BUILD_LOCK:
            options=self.options(identifier)
            if options['git']:
                if expected is None:expected=json.loads(self.h['project_run'](self.cfg,p,['preview'],60))['remoteCommit']
                result=json.loads(self.h['project_run'](self.cfg,p,['deploy',expected],1200))
                p.update(remoteCommit=result['commit'],checkedAt=timestamp())
            else:result=json.loads(self.h['project_run'](self.cfg,p,['snapshot'],1200))
            if p['runtime']['kind']=='docker':
                n=self.names(identifier);image='uc-project-'+n['key']+':'+result['release']
                target=pathlib.Path(p['root'])/'.control-releases'/result['release']
                values=read_values(self.env_path(identifier));build_args=[]
                for key in p.get('publicBuild',[]):build_args+=['--build-arg',key+'='+values[key]]
                try:self.docker(['build',*build_args,'--label','ubuntu-control.project='+identifier,'--tag',image,str(target)],timeout=900,build_unit=n['build']+'-image.service')
                except Exception:
                    self.h['project_run'](self.cfg,p,['rollback',result['release']]);raise
                p['image']=image
            p.update(preparedCommit=result['commit'],release=result['release'],deployment='prepared')
            return result
    def deploy(self,identifier,args,start=False):
        p=self.lookup(identifier)
        if p.get('ownership')!='managed':raise ValueError('Configure a managed runtime before activation')
        was_running=p.get('desired')=='running'
        old=dict(p);result=None
        self.begin(identifier,old,'deploy',expected=args.get('expected'))
        try:
            if start and p.get('release') and not p.get('runtimePending') and not args.get('rebuild'):pass
            else:result=self.release(identifier,p,args.get('expected'))
            if old.get('release') and self.state(old).get('active')=='active':self.h['run'](['/usr/bin/systemctl','stop',self.names(identifier)['unit']],timeout=45)
            self.provision(identifier,p)
            if start or was_running:
                emit('starting')
                if p.get('externalService'):
                    self.h['service_action'](self.cfg,{'service':p['externalService'],'operation':'stop','confirmed':True});p.pop('externalService',None)
                if p['runtime']['kind']=='node' and p['runtime'].get('port'):
                    from project_ports import check_port
                    status=check_port(self,identifier,p['runtime']['port'],p['runtime'].get('listenAddress','127.0.0.1')) if 'parse_ss' in self.h else {'status':'unknown'}
                    if status['status'] in ('occupied','reserved'):
                        raise OperationError('פורט ההפעלה תפוס או שמור לפרויקט אחר',{'code':'PROJECT_PORT_CONFLICT','stage':'port-check','stderr':json.dumps(status,ensure_ascii=False),'hint':'בחרו פורט פנוי או עצרו במפורש את התהליך המתנגש. המערכת אינה עוצרת תהליכים אחרים אוטומטית.'})
                self.h['run'](['/usr/bin/systemctl','restart',self.names(identifier)['unit']],timeout=45)
                emit('health');self.health(identifier,p)
                p.update(desired='running',activeCommit=p['preparedCommit'],envPending=False,deployment='healthy')
            else:p.update(desired='stopped',deployment='prepared-stopped')
            p.update(failedCommit=None,runtimePending=False,deployedAt=timestamp());self.save(identifier,p,True);self.finish(identifier)
            return self.public(identifier,p)
        except Exception as error:
            emit('rollback')
            restored=False;recovery_error=None
            try:
                if result:restored=json.loads(self.h['project_run'](self.cfg,p,['rollback',result['release']],120)).get('restored',False)
                if restored and old.get('release'):
                    self.provision(identifier,old)
                    if was_running:
                        self.h['run'](['/usr/bin/systemctl','restart',self.names(identifier)['unit']]);self.health(identifier,old)
                elif result:
                    # Provisioning can fail before the first unit becomes valid.
                    # A failed stop is not proof of inactivity: query LoadState
                    # and ActiveState, retaining the transaction if uncertain.
                    try:self.h['run'](['/usr/bin/systemctl','stop',self.names(identifier)['unit']])
                    except Exception:
                        state=self.h['run'](['/usr/bin/systemctl','show',self.names(identifier)['unit'],'-p','LoadState','-p','ActiveState'],check=False)
                        props=dict(line.split('=',1) for line in state.splitlines() if '=' in line)
                        if props.get('LoadState') not in ('not-found','bad-setting') or props.get('ActiveState') not in ('inactive','failed'):raise
            except Exception as recovery:
                recovery_error=str(recovery);restored=False
                try:self.h['run'](['/usr/bin/systemctl','stop',self.names(identifier)['unit']])
                except Exception:pass
            old.update(failedCommit=args.get('expected') or (result or {}).get('commit'),deployment='failed-rolled-back' if restored else 'failed',failureAt=timestamp())
            self.save(identifier,old,not recovery_error)
            if not recovery_error:self.finish(identifier)
            secrets=self.secret_values(identifier,old)
            raw=getattr(error,'details',{}) or {'code':'DEPLOY_FAILED','stage':'health-or-build','stderr':str(error),'hint':'The previous release was restored and checked.' if restored else 'Inspect runtime configuration and project logs.'}
            if not getattr(error,'details',None) and 'project_failure_logs' in self.h:
                try:raw['stdout']=self.h['project_failure_logs'](self.cfg,identifier)
                except Exception:pass
            details=clean(raw,secrets)
            if recovery_error:details['hint']='Recovery also failed: '+redact(recovery_error,secrets)
            raise OperationError(redact(str(error),secrets),details,secrets) from None
    def rollback_release(self,identifier,release):
        p=self.lookup(identifier);old=dict(p)
        if not p.get('release'):raise ValueError('No prepared release is available')
        self.begin(identifier,old,'deploy')
        try:
            if self.state(old).get('active')=='active':self.h['run'](['/usr/bin/systemctl','stop',self.names(identifier)['unit']],timeout=45)
            result=json.loads(self.h['project_run'](self.cfg,p,['rollback',release],120))
            if not result.get('restored'):raise ValueError('No previous release is available')
            p.update(release=result['release'],preparedCommit=result['commit'])
            if p['runtime']['kind']=='docker':p['image']='uc-project-'+self.names(identifier)['key']+':'+result['release']
            self.provision(identifier,p)
            if p.get('desired')=='running':
                self.h['run'](['/usr/bin/systemctl','restart',self.names(identifier)['unit']]);self.health(identifier,p);p['activeCommit']=result['commit']
            p['deployment']='restored';result=self.save(identifier,p,True);self.finish(identifier);return result
        except Exception:
            self.h['project_run'](self.cfg,old,['select-release',old['release']],120)
            self.provision(identifier,old)
            if old.get('desired')=='running':
                self.h['run'](['/usr/bin/systemctl','restart',self.names(identifier)['unit']]);self.health(identifier,old)
            self.save(identifier,old,True);self.finish(identifier)
            raise
    def control(self,identifier,operation):
        p=self.lookup(identifier)
        if operation in ('start','restart'):return self.deploy(identifier,{},True)
        if operation in ('enable','disable'):
            if p.get('ownership')!='managed':raise ValueError('Runtime is not managed')
            p['runtime']={**p['runtime'],'autostart':operation=='enable'}
            if p.get('release'):self.provision(identifier,p)
            return self.save(identifier,p)
        if operation!='stop':raise ValueError('Unsupported control operation')
        if p.get('service'):
            if p.get('ownership')=='managed':
                if p.get('release'):self.h['run'](['/usr/bin/systemctl','stop',self.names(identifier)['unit']])
            else:self.h['service_action'](self.cfg,{'service':p['service'],'operation':'stop','confirmed':True})
        p['desired']='stopped';return self.save(identifier,p)
    def updates(self,identifier,args):
        p=self.lookup(identifier);mode=args.get('mode')
        if mode not in ('manual','auto'):raise ValueError('Invalid update policy')
        if mode=='auto' and (not p.get('repo') or p.get('ownership')!='managed'):raise ValueError('Automatic updates require a repository and managed runtime')
        p['updates']=mode;return self.save(identifier,p)
    def head(self,identifier,args):
        p=self.lookup(identifier)
        if not p.get('repo'):raise ValueError('Project has no repository')
        if p.get('auth')=='github-app':
            name=p['repo'].removeprefix('https://github.com/').removesuffix('.git')
            result=self.h['github_broker']('head',{'repositoryId':p['github_repository_id'],'fullName':name,'branch':p.get('branch','main'),'etag':args.get('etag')})
        else:result=json.loads(self.h['project_run'](self.cfg,p,['head'],60))
        return result
    def archive(self,identifier,args):
        p=self.lookup(identifier);original=dict(p)
        if args.get('confirmName')!=identifier:raise ValueError('Type the project folder name to confirm')
        if p.get('service'):self.assert_unshared(identifier,p)
        from publication import Publication,NETWORK_LOCK
        with NETWORK_LOCK:
            publication=Publication(self.cfg,self.h)
            if identifier in publication.read()['projects']:publication.publish(identifier,{'enabled':False,'confirmed':True})
        root=pathlib.Path(p['root']);base=root.parent/'.archives';base.mkdir(mode=0o700,exist_ok=True)
        if base.is_symlink() or base.stat().st_uid!=os.geteuid() or base.stat().st_mode&0o022:raise ValueError('Unsafe archive root')
        destination=base/(identifier+'-'+uuid.uuid4().hex)
        env_archive=pathlib.Path(self.cfg.get('state_dir','/var/lib/ubuntu-control-helper'))/'archives'/destination.name
        env_archive.mkdir(mode=0o700,parents=True,exist_ok=False)
        kind,unit=self.service_ref(p) if p.get('service') else (None,None)
        if p.get('ownership')=='managed' and not p.get('release'):unit=None
        before=self.state(p) if unit else {'active':'inactive'}
        restart_policy=None
        if kind=='docker':restart_policy=self.h['run'](['/usr/bin/docker','inspect','--format','{{.HostConfig.RestartPolicy.Name}}',unit]).strip()
        moved=[];code_moved=False
        self.begin(identifier,original,'archive',archive={'code':str(destination),'environment':str(env_archive)},observed=before,restartPolicy=restart_policy)
        try:
            if p.get('service'):self.control(identifier,'stop')
            if unit and kind=='systemd':self.h['run'](['/usr/bin/systemctl','disable',*(['--runtime'] if p.get('ownership')=='managed' else []),unit])
            if kind=='docker':self.h['run'](['/usr/bin/docker','update','--restart=no',unit])
            if kind=='pm2':self.h['pm2'](self.cfg,['save','--force'])
            root.rename(destination);code_moved=True
            for ext in ('.env','.runtime.json'):
                source=self.env_path(identifier) if ext=='.env' else self.env_path(identifier).with_suffix(ext)
                if source.is_symlink():raise ValueError('Unsafe archived credential')
                if source.exists():atomic_private(env_archive/source.name,source.read_text());source.unlink();moved.append(source)
            p.update(lifecycle='archived',archivedAt=timestamp(),updates='manual',desired='stopped',archive={'code':str(destination),'environment':str(env_archive)})
            result=self.save(identifier,p,True);self.finish(identifier);return result
        except Exception:
            for source in moved:atomic_private(source,(env_archive/source.name).read_text())
            if code_moved:destination.rename(root)
            if unit and kind=='systemd' and (p.get('runtime',{}).get('autostart') or before.get('enabled')):self.h['run'](['/usr/bin/systemctl','enable',*(['--runtime'] if p.get('ownership')=='managed' else []),unit])
            if kind=='docker' and restart_policy in ('no','always','unless-stopped','on-failure'):self.h['run'](['/usr/bin/docker','update','--restart='+restart_policy,unit])
            if before.get('active')=='active':
                if p.get('ownership')=='managed':self.h['run'](['/usr/bin/systemctl','restart',unit])
                else:self.h['service_action'](self.cfg,{'service':p['service'],'operation':'start','confirmed':True})
            if kind=='pm2':self.h['pm2'](self.cfg,['save','--force'])
            self.save(identifier,original,True)
            self.finish(identifier)
            raise
    def restore(self,identifier):
        p=self.lookup(identifier,True)
        if p.get('lifecycle')!='archived':raise ValueError('Project is not archived')
        root=pathlib.Path(p['root'])
        if root.exists() or root.is_symlink():raise ValueError('Project path already exists; restore cannot overwrite it')
        source=self.archive_paths(identifier,p)[0]
        self.begin(identifier,p,'restore');source.rename(root)
        env_dir=pathlib.Path(p['archive']['environment'])
        restored_files=[]
        try:
            for name in (identifier+'.env',identifier+'.runtime.json'):
                f=env_dir/name;target=self.env_path(identifier).parent/name
                if target.exists() or target.is_symlink():raise ValueError('Environment destination already exists')
                if f.exists():atomic_private(target,f.read_text());restored_files.append(target)
            p.update(lifecycle='active',updates='manual',desired='stopped');p.pop('archive',None)
            if p.get('runtime'):p['runtime']={**p['runtime'],'autostart':False}
            result=self.save(identifier,p,True);self.finish(identifier)
        except Exception:
            for f in restored_files:f.unlink(missing_ok=True)
            root.rename(source);self.finish(identifier);raise
        try:
            for name in (identifier+'.env',identifier+'.runtime.json'):(env_dir/name).unlink(missing_ok=True)
            env_dir.rmdir()
        except OSError:print('Private restored archive cleanup requires operator attention: '+identifier,file=__import__('sys').stderr)
        return result
    def archive_paths(self,identifier,p):
        root=pathlib.Path(p['root']);code=pathlib.Path(p['archive']['code']);env=pathlib.Path(p['archive']['environment'])
        expected_env=pathlib.Path(self.cfg.get('state_dir','/var/lib/ubuntu-control-helper'))/'archives'
        if code.parent!=root.parent/'.archives' or not re.fullmatch(re.escape(identifier)+r'-[a-f0-9]{32}',code.name) or env.parent!=expected_env or env.name!=code.name or code.is_symlink() or env.is_symlink():raise ValueError('Archive path verification failed')
        return code,env
    def purge(self,identifier,args):
        p=self.lookup(identifier,True)
        if p.get('lifecycle')!='archived' or args.get('confirmName')!=identifier:raise ValueError('Only explicitly confirmed archived projects may be purged')
        if not shutil.rmtree.avoids_symlink_attacks:raise ValueError('Safe recursive deletion is not available on this platform')
        paths=list(self.archive_paths(identifier,p))
        if not getattr(self,'recovering',False):self.begin(identifier,p,'purge')
        if p.get('ownership')=='managed':self.h['run'](['/usr/bin/systemctl','stop',self.names(identifier)['unit']],check=False,timeout=45)
        state_link=None
        # StateDirectory is a fixed hash owned by this project. Follow only PID1's
        # root-owned link into /var/lib/private, never an application-controlled link.
        if p.get('runtime',{}).get('kind')=='node':
            data=pathlib.Path('/var/lib')/self.names(identifier)['state']
            if data.is_symlink():
                if data.lstat().st_uid!=0 or data.resolve()!=pathlib.Path('/var/lib/private')/self.names(identifier)['state']:raise ValueError('Unsafe private state link')
                paths.append(data.resolve());state_link=data
            elif data.exists():paths.append(data)
        if p.get('runtime',{}).get('kind')=='docker':
            n=self.names(identifier)
            if n['container'] in self.docker(['ps','-a','--format','{{.Names}}']).splitlines():
                label=self.docker(['inspect','--format','{{index .Config.Labels "ubuntu-control.project"}}',n['container']]).strip()
                if label!=identifier:raise ValueError('Container ownership does not match project')
                self.docker(['stop','--time','20',n['container']],timeout=35)
                if n['container'] in self.docker(['ps','-a','--format','{{.Names}}']).splitlines():self.docker(['rm',n['container']])
            volumes=self.docker(['volume','ls','--format','{{.Name}}']).splitlines()
            if n['volume'] in volumes:
                label=self.docker(['volume','inspect','--format','{{index .Labels "ubuntu-control.project"}}',n['volume']]).strip()
                if label!=identifier:raise ValueError('Docker volume ownership does not match project')
                self.docker(['volume','rm',n['volume']])
            tags=self.docker(['image','ls','--filter','label=ubuntu-control.project='+identifier,'--format','{{.Repository}}:{{.Tag}}']).splitlines()
            for tag in set(tags):
                if re.fullmatch(r'uc-project-'+n['key']+r':[0-9]+-[a-f0-9]{10}',tag):self.docker(['image','rm',tag])
        if p.get('runtime',{}).get('kind')=='node':Storage(self,identifier).purge()
        for path in paths:
            if not path.exists():continue
            with contextlib.ExitStack() as stack:
                fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);stack.callback(os.close,fd)
                shutil.rmtree(path.name,dir_fd=fd)
        if state_link:state_link.unlink(missing_ok=True)
        if p.get('ownership')=='managed':
            unit=pathlib.Path(self.cfg.get('unit_dir','/run/systemd/system'))/self.names(identifier)['unit']
            if unit.is_symlink():raise ValueError('Unsafe service unit')
            unit.unlink(missing_ok=True);self.h['run'](['/usr/bin/systemctl','daemon-reload'])
        p.update(lifecycle='deleted',updates='manual',desired='stopped');p.pop('archive',None);result=self.save(identifier,p,True);self.finish(identifier);return result

READ_ACTIONS={'project-options','project-env-meta','project-records','project-state','project-head'}
MUTATIONS={'project-runtime','project-env-patch','project-updates','project-start','project-stop','project-restart','project-enable','project-disable','project-archive','project-restore','project-purge','project-activate'}

def dispatch_lifecycle(cfg,action,args,backend):
    life=Lifecycle(cfg,backend)
    if action=='project-records':return [life.public(k,v) for k,v in backend['all_projects'](cfg).items()]
    identifier=backend['project_identifier'](args.get('project'))
    if action=='project-options':return life.options(identifier)
    if action=='project-env-meta':return life.metadata(identifier)
    if action=='project-head':return life.head(identifier,args)
    if action=='project-state':
        p=life.lookup(identifier,True);return {**life.public(identifier,p),'observed':life.state(p) if p.get('lifecycle','active')=='active' else {'active':'archived'}}
    with project_lock(identifier):
        firewall=backend.get('FIREWALL_WORK')
        if (firewall and firewall.is_set()) or (pathlib.Path(cfg.get('state_dir','/var/lib/ubuntu-control-helper'))/'pending.json').exists():raise ValueError('Confirm or roll back the firewall transaction before project mutations')
        if life.transaction_path(identifier).exists():raise OperationError('Project recovery is pending; inspect and restart the helper',{'code':'PROJECT_RECOVERY_PENDING','stage':'recovery'})
        if action=='project-runtime':return life.configure(identifier,args)
        if action=='project-env-patch':return life.environment(identifier,args)
        if action=='project-updates':return life.updates(identifier,args)
        if action=='project-archive':return life.archive(identifier,args)
        if action=='project-restore':return life.restore(identifier)
        if action=='project-purge':return life.purge(identifier,args)
        if action=='project-activate':return life.deploy(identifier,args)
        if action in ('project-start','project-stop','project-restart','project-enable','project-disable'):return life.control(identifier,action.removeprefix('project-'))
    raise ValueError('Unsupported lifecycle action')

def recover_transactions(cfg,backend):
    life=Lifecycle(cfg,backend);directory=pathlib.Path(cfg.get('state_dir','/var/lib/ubuntu-control-helper'))/'runtime-transactions'
    for path in directory.glob('*.json'):
        identifier=path.stem
        try:
            backend['project_identifier'](identifier)
            if path.is_symlink():raise ValueError('Unsafe recovery journal')
            with project_lock(identifier):
                tx=json.loads(path.read_text());current=backend['all_projects'](cfg).get(identifier)
                if current and current.get('operationId')==tx['id']:path.unlink();continue
                before=tx['before'];life.transaction=tx['id']
                if not current or before['root']!=current['root'] or tx['project']!=identifier:raise ValueError('Recovery scope changed')
                life.lookup(identifier,True);operation=tx['operation'];root=pathlib.Path(before['root'])
                if operation=='deploy':
                    # PID1 owns build cgroups; stop orphaned builders before touching current.
                    for suffix in ('-source.service','-image.service'):backend['run'](['/usr/bin/systemctl','stop',life.names(identifier)['build']+suffix],check=False,timeout=35)
                if operation=='purge':life.recovering=True;life.purge(identifier,{'confirmName':identifier});life.recovering=False;continue
                if operation=='deploy':
                    if before.get('release'):
                        backend['project_run'](cfg,before,['select-release',before['release']],120);life.provision(identifier,before)
                        if before.get('desired')=='running':
                            backend['run'](['/usr/bin/systemctl','restart',life.names(identifier)['unit']]);life.health(identifier,before)
                        else:backend['run'](['/usr/bin/systemctl','stop',life.names(identifier)['unit']],check=False)
                    else:
                        backend['project_run'](cfg,before,['clear-current'],120)
                        backend['run'](['/usr/bin/systemctl','stop',life.names(identifier)['unit']],check=False)
                    before.update(deployment='interrupted-rolled-back',failedCommit=tx.get('expected'))
                elif operation in ('archive','restore'):
                    code,environment=life.archive_paths(identifier,{**before,'archive':tx.get('archive',before.get('archive'))})
                    if operation=='archive':
                        if code.exists():
                            if root.exists():raise ValueError('Both recovery paths exist')
                            code.rename(root)
                        for name in (identifier+'.env',identifier+'.runtime.json'):
                            source=environment/name;target=life.env_path(identifier).parent/name
                            if source.exists():
                                if target.exists() and target.read_bytes()!=source.read_bytes():raise ValueError('Credential recovery conflict')
                                if not target.exists():atomic_private(target,source.read_text())
                        if before.get('ownership')=='managed' and before.get('release'):life.provision(identifier,before)
                        if before.get('service') and before.get('ownership')!='managed':
                            kind,unit=life.service_ref(before)
                            if kind=='systemd' and tx.get('observed',{}).get('enabled'):backend['run'](['/usr/bin/systemctl','enable',unit])
                            if kind=='docker' and tx.get('restartPolicy') in ('no','always','unless-stopped','on-failure'):backend['run'](['/usr/bin/docker','update','--restart='+tx['restartPolicy'],unit])
                        if before.get('service') and tx.get('observed',{}).get('active')=='active':
                            if before.get('ownership')=='managed':backend['run'](['/usr/bin/systemctl','start',life.names(identifier)['unit']])
                            else:backend['service_action'](cfg,{'service':before['service'],'operation':'start','confirmed':True})
                        if before.get('service') and life.service_ref(before)[0]=='pm2':backend['pm2'](cfg,['save','--force'])
                    else:
                        if root.exists():
                            if code.exists():raise ValueError('Both recovery paths exist')
                            root.rename(code)
                        for name in (identifier+'.env',identifier+'.runtime.json'):
                            source=life.env_path(identifier).parent/name;archived=environment/name
                            if source.exists():
                                if not archived.exists() or source.read_bytes()!=archived.read_bytes():raise ValueError('Credential recovery conflict')
                                source.unlink()
                else:raise ValueError('Unknown recovery operation')
                life.save(identifier,before,True);life.finish(identifier)
        except Exception:print('Project recovery requires operator attention: '+identifier,file=__import__('sys').stderr)

def rehydrate(cfg,backend):
    """Restore generated units on boot without coupling running apps to web upgrades."""
    recover_transactions(cfg,backend)
    life=Lifecycle(cfg,backend);state=pathlib.Path(cfg.get('state_dir','/var/lib/ubuntu-control-helper'));marker=state/'runtime-boot-id'
    try:boot=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    except OSError:return
    new_boot=not marker.exists() or marker.read_text()!=boot
    for identifier,p in backend['all_projects'](cfg).items():
        if p.get('ownership')!='managed' or p.get('lifecycle','active')!='active' or not p.get('release'):continue
        try:
            with project_lock(identifier):
                if life.transaction_path(identifier).exists():continue
                p=life.lookup(identifier)
                if p.get('ownership')!='managed' or not p.get('release'):continue
                # Same-boot upgrades preserve existing units, including stopped
                # projects. Storage adoption/migration requires explicit activation.
                if not new_boot:continue
                life.provision(identifier,p)
                if p.get('storage'):life.save(identifier,p)
                if new_boot and p['runtime']['autostart']:
                    backend['run'](['/usr/bin/systemctl','start',life.names(identifier)['unit']]);p['desired']='running';life.save(identifier,p)
        except Exception:
            print('Managed project unit rehydration failed: '+identifier,file=__import__('sys').stderr)
    atomic_private(marker,boot)
