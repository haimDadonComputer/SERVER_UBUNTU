#!/usr/bin/python3
"""Root-owned, local-only privileged boundary. No shell and no caller-supplied commands."""
import os, sys, json, socket, struct, subprocess, re, time, threading, pathlib, ipaddress, shutil, urllib.request, urllib.error, hashlib, tempfile, datetime
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from diagnostics import failure,decode,exception_details,OperationError,clean
from project_lifecycle import Lifecycle,dispatch_lifecycle,READ_ACTIONS,MUTATIONS,REGISTRY_LOCK,BUILD_LOCK,PROJECT_LOCKS,project_lock,rehydrate,recover_transactions
from project_logs import ProjectLogHub
from project_secrets import parse_import
from project_ports import check_port
from job_progress import LOCAL as PROGRESS,execute as progress_execute
from publication import dispatch_publication,Publication,NETWORK_LOCK
PROJECT_LOG_HUB=None

CONFIG = '/etc/ubuntu-control/helper.json'
LOCK = threading.RLock()
FIREWALL_WORK=threading.Event()
ENV = {'PATH': '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'SYSTEMD_COLORS': '0'}

def run(argv, timeout=20, check=True, input_text=None):
    secrets=[]
    if input_text:
        try:secrets=[json.loads(input_text).get('token','')]
        except (ValueError,AttributeError):pass
    try:p = (progress_execute if getattr(PROGRESS,'callback',None) else subprocess.run)(argv, input=input_text, capture_output=True, text=True, timeout=timeout, env=ENV, cwd='/')
    except (OSError,subprocess.TimeoutExpired) as error:raise exception_details(error,'system-command','/',secrets) from None
    if check and p.returncode:
        child=decode(p.stderr,secrets)
        if child:
            child.details['launcher']=clean({'command':argv,'cwd':'/','exitCode':p.returncode},secrets)
            raise child
        raise failure(argv,'/','system-command',returncode=p.returncode,stdout=p.stdout,stderr=p.stderr,secrets=secrets)
    return p.stdout[:4000000]

def load_config():
    p = pathlib.Path(CONFIG)
    st = p.stat()
    if st.st_uid != 0 or st.st_mode & 0o022:
        raise ValueError('Helper configuration must be root owned and not writable by group/others')
    return json.loads(p.read_text())

def service(cfg, identifier):
    if isinstance(identifier,str) and identifier.startswith('uc:'):
        project_id=project_identifier(identifier[3:]);p=all_projects(cfg).get(project_id,{})
        if p.get('ownership')=='managed' and p.get('lifecycle','active')=='active':return {'id':identifier,'kind':'systemd','name':Lifecycle(cfg,globals()).names(project_id)['unit']}
    for item in cfg.get('services', []):
        if item['id'] == identifier:
            if item['kind'] == 'systemd' and re.fullmatch(r'[A-Za-z0-9_.@:-]+\.service', item['name']):
                return item
            if item['kind'] == 'docker' and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]+', item['name']):
                return item
            if item['kind'] == 'pm2' and re.fullmatch(r'[A-Za-z0-9_-]+', item['name']):
                return item
    raise ValueError('Service is not in the root-owned allowlist')

def pm2(cfg, args):
    user = cfg.get('project_user', 'ubuntu-projects')
    binary = cfg.get('pm2_binary', '/usr/local/bin/pm2')
    p = pathlib.Path(binary).resolve()
    if not p.is_file() or p.stat().st_uid != 0 or p.stat().st_mode & 0o022:
        raise ValueError('PM2 executable must be root-owned')
    return run(['/usr/sbin/runuser', '-u', user, '--', '/usr/bin/env', 'PM2_HOME='+cfg.get('pm2_home', '/var/lib/ubuntu-projects/pm2'), binary, *args])

def parse_ss(output):
    result = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 5 or not parts[0].startswith(('tcp', 'udp')):
            continue
        endpoint = parts[4]
        try:
            address, port = endpoint.rsplit(':', 1)
            port = int(port)
        except ValueError:
            continue
        pid = re.search(r'pid=(\d+)', line)
        name = re.search(r'users:\(\("([^"]+)', line)
        address = address.strip('[]')
        local = address == '::1' or address.startswith('127.')
        result.append({'port': port, 'protocol': parts[0][:3], 'address': address,
                       'pid': int(pid[1]) if pid else None, 'process': name[1] if name else None,
                       'exposure': 'local' if local else 'unknown', 'service': None, 'status': 'unmanaged', 'project': None})
    return result

def inventory(cfg):
    rows = parse_ss(run(['/usr/bin/ss', '-H', '-lntup']))
    units = json.loads(run(['/usr/bin/systemctl', 'list-units', '--all', '--type=service', '--output=json', '--no-pager']))
    states = {u['unit']: u['active'] for u in units}
    managed = []
    docker = []
    try:
        docker = [json.loads(x) for x in run(['/usr/bin/docker', 'ps', '-a', '--no-trunc', '--format', '{{json .}}']).splitlines()]
    except (ValueError, FileNotFoundError):
        pass
    pm = []
    if cfg.get('pm2_enabled'):
        pm = json.loads(pm2(cfg, ['jlist']))
    entries=[*cfg.get('services',[]),*[{'id':v['service']} for v in all_projects(cfg).values() if v.get('ownership')=='managed' and v.get('lifecycle','active')=='active']]
    for entry in entries:
        item = service(cfg, entry['id'])
        state, pid, cwd = 'unknown', None, None
        if item['kind'] == 'systemd':
            state = states.get(item['name'], 'inactive')
            props = run(['/usr/bin/systemctl', 'show', item['name'], '-p', 'MainPID', '-p', 'WorkingDirectory'])
            prop = dict(x.split('=', 1) for x in props.splitlines() if '=' in x)
            pid = int(prop.get('MainPID', '0')) or None
            cwd = prop.get('WorkingDirectory') or None
        elif item['kind'] == 'docker':
            match = next((d for d in docker if d['Names'] == item['name']), None)
            state = 'active' if match and match['State'] == 'running' else 'inactive'
        else:
            match = next((p for p in pm if p['name'] == item['name']), None)
            state = 'active' if match and match['pm2_env']['status'] == 'online' else 'inactive'
            pid = match.get('pid') if match else None
        managed.append({**item, 'status': state, 'pid': pid, 'directory': cwd})
    for row in rows:
        unit = None
        if row['pid']:
            try:
                cgroup = pathlib.Path('/proc/%s/cgroup' % row['pid']).read_text()
                found = re.search(r'/([^/]+\.service)(?:/|\n|$)', cgroup)
                unit = found[1] if found else None
                row['directory'] = os.readlink('/proc/%s/cwd' % row['pid'])
            except OSError:
                pass
        for item in managed:
            docker_match = False
            if item['kind'] == 'docker':
                d = next((d for d in docker if d['Names'] == item['name']), None)
                # Map published ports only; do not guess ownership of docker-proxy processes.
                docker_match = bool(d and re.search(r':%s->\d+/%s\b' % (row['port'], row['protocol']), d.get('Ports', '')))
            if (item['pid'] and row['pid'] == item['pid']) or (unit and item['name'] == unit) or docker_match:
                row.update(service=item['id'], status=item['status'])
        if unit:
            row['process'] = unit
    return {'ports': rows, 'services': managed, 'unitCounts': {'active': sum(u['active']=='active' for u in units), 'inactive': sum(u['active']=='inactive' for u in units), 'failed': sum(u['active']=='failed' for u in units)}, 'failed': [u['unit'] for u in units if u['active']=='failed'], 'dockerDetected': bool(docker), 'pm2Detected': bool(pm)}

def service_action(cfg, args):
    item = service(cfg, args['service'])
    if item['name'] in ('ssh.service','sshd.service','ubuntu-control.service','ubuntu-control-helper.service','systemd-networkd.service','networking.service') or item['id'] in cfg.get('protected_services', []):
        raise ValueError('Management and network services are protected')
    action = args['operation']
    if action not in ('start', 'stop', 'restart', 'enable', 'disable'):
        raise ValueError('Unsupported service operation')
    if not args.get('confirmed'):
        raise ValueError('Explicit service-wide confirmation is required')
    if item['kind'] == 'systemd':
        run(['/usr/bin/systemctl', action, item['name']], timeout=35)
        state = run(['/usr/bin/systemctl', 'show', item['name'], '-p', 'ActiveState', '--value']).strip()
        if action in ('start', 'restart') and state != 'active':
            raise ValueError('Service did not reach active state')
        return {'state': state}
    if action in ('enable', 'disable'):
        raise ValueError('Autostart is configured by the operator for this runtime')
    if item['kind'] == 'docker':
        run(['/usr/bin/docker', action, item['name']], timeout=35)
        state = run(['/usr/bin/docker', 'inspect', '--format', '{{.State.Status}}', item['name']]).strip()
        if action in ('start', 'restart') and state != 'running':
            raise ValueError('Container did not reach running state')
        return {'state': state}
    pm2(cfg, [action, item['name']])
    processes=json.loads(pm2(cfg,['jlist']))
    current=next((p for p in processes if p['name']==item['name']),None)
    state=current['pm2_env']['status'] if current else 'missing'
    if action in ('start','restart') and state!='online': raise ValueError('PM2 process did not reach online state')
    if action=='stop' and state=='online': raise ValueError('PM2 process is still online')
    return {'state':state}

def logs(cfg, args):
    item = service(cfg, args['service'])
    if item['kind'] == 'systemd':
        return run(['/usr/bin/journalctl', '-u', item['name'], '-n', '250', '--no-pager', '-o', 'short-iso'])
    if item['kind'] == 'docker':
        # Docker writes stderr logs to stderr, so merge explicitly without a shell.
        p = subprocess.run(['/usr/bin/docker', 'logs', '--timestamps', '--tail', '250', item['name']], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20, env=ENV)
        if p.returncode: raise ValueError('Docker logs unavailable')
        return p.stdout.decode('utf8', errors='replace')[-1000000:]
    return pm2(cfg, ['logs', item['name'], '--nostream', '--lines', '250', '--timestamp'])

def cloud(cfg, route, body=None):
    secret = pathlib.Path(cfg['hetzner_token_file']).read_text().strip()
    req = urllib.request.Request('https://api.hetzner.cloud/v1/'+route, data=json.dumps(body).encode() if body is not None else None, headers={'Authorization':'Bearer '+secret, 'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=20) as response: return json.load(response)
    except Exception:
        raise ValueError('Hetzner API request failed') from None

def cloud_rules(cfg, rules):
    result = cloud(cfg, 'firewalls/%s/actions/set_rules' % int(cfg['hetzner_firewall_id']), {'rules': rules})
    for action in result.get('actions', []):
        for _ in range(30):
            current = cloud(cfg, 'actions/%s' % action['id'])['action']
            if current['status'] == 'success': break
            if current['status'] == 'error': raise ValueError('Hetzner firewall action failed')
            time.sleep(1)
        else: raise ValueError('Hetzner firewall action timed out')

def firewall_status(cfg):
    result = {'ufw': run(['/usr/sbin/ufw', 'status', 'verbose']), 'cloud': None, 'effective': 'unknown', 'notice': 'Firewall rules do not prove external reachability; Docker may bypass UFW.'}
    if cfg.get('hetzner_firewall_id'):
        result['cloud'] = cloud(cfg, 'firewalls/%s' % int(cfg['hetzner_firewall_id']))['firewall']
    return result

def validate_firewall(cfg, args):
    port = int(args['port'])
    if not 1 <= port <= 65535 or args['protocol'] not in ('tcp', 'udp'):
        raise ValueError('Invalid port/protocol')
    protected = set(cfg.get('protected_ports', [22, 443, 3080, 3306, 5432, 6379, 27017]))
    if port in protected:
        raise ValueError('Management/sensitive ports cannot be changed through the UI')
    source = str(ipaddress.ip_network(args['source'], strict=True))
    if ipaddress.ip_network(source).prefixlen == 0 and not args.get('worldConfirmed'):
        raise ValueError('Opening to the world requires explicit confirmation')
    if args.get('operation') not in ('allow', 'remove') or not args.get('confirmed'):
        raise ValueError('Explicit firewall confirmation required')
    return port, source

def rollback(cfg, tx):
    state = pathlib.Path(cfg.get('state_dir', '/var/lib/ubuntu-control-helper'))
    record = state / 'pending.json'
    if not record.exists(): return
    pending = json.loads(record.read_text())
    if pending['id'] != tx: raise ValueError('Transaction mismatch')
    for name in ('user.rules', 'user6.rules'):
        shutil.copy2(state / (tx+'-'+name), '/etc/ufw/'+name)
    run(['/usr/sbin/ufw', 'reload'])
    if pending.get('cloud') is not None: cloud_rules(cfg, pending['cloud'])
    record.unlink()

def firewall_change(cfg, args):
    port, source = validate_firewall(cfg, args)
    state = pathlib.Path(cfg.get('state_dir', '/var/lib/ubuntu-control-helper'))
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    if (state/'pending.json').exists(): raise ValueError('A firewall transaction is pending')
    if 'Status: active' not in run(['/usr/sbin/ufw', 'status']): raise ValueError('UFW must already be active; automatic activation is prohibited')
    if cfg.get('ufw_verified_host_network') is not True:
        raise ValueError('Operator must verify host networking and absence of Docker UFW bypass before firewall changes')
    # Only dedicated app-owned cloud firewalls can be changed; shared firewall changes are prohibited.
    previous = None
    if cfg.get('hetzner_firewall_id'):
        fw = cloud(cfg, 'firewalls/%s' % int(cfg['hetzner_firewall_id']))['firewall']
        if fw.get('labels', {}).get('ubuntu-control') != 'dedicated': raise ValueError('Cloud firewall needs ubuntu-control=dedicated label')
        applied=fw.get('applied_to', [])
        if len(applied)!=1 or applied[0].get('type')!='server' or applied[0].get('server',{}).get('id')!=cfg.get('hetzner_server_id'):
            raise ValueError('Cloud firewall must be attached only to the configured hetzner_server_id')
        previous = fw['rules']
    tx = os.urandom(16).hex()
    for name in ('user.rules', 'user6.rules'): shutil.copy2('/etc/ufw/'+name, state/(tx+'-'+name))
    pending = {'id':tx, 'deadline':time.time()+120, 'cloud':previous}
    (state/'pending.json').write_text(json.dumps(pending))
    try:
        rule = ['allow','from',source,'to','any','port',str(port),'proto',args['protocol'],'comment','ubuntu-control']
        if args['operation'] == 'remove': rule = ['--force', 'delete', *rule]
        run(['/usr/sbin/ufw', '--dry-run', *rule])
        run(['/usr/sbin/ufw', *rule])
        if previous is not None:
            description = 'ubuntu-control:%s:%s:%s' % (port, args['protocol'], source)
            rules = [r for r in previous if r.get('description') != description]
            if args['operation'] == 'allow': rules.append({'direction':'in','protocol':args['protocol'],'port':str(port),'source_ips':[source],'description':description})
            cloud_rules(cfg, rules)
        return {'transaction':tx, 'expiresIn':120, 'effective':'unknown'}
    except Exception:
        rollback(cfg, tx)
        raise

def project_identifier(identifier):
    if not isinstance(identifier,str) or not re.fullmatch(r'[a-z][a-z0-9-]{1,40}',identifier):
        raise ValueError('Project folder name must contain 2-41 lowercase letters, digits or hyphens')
    return identifier

def read_project_registry(cfg):
    f=pathlib.Path(cfg.get('state_dir','/var/lib/ubuntu-control-helper'))/'projects.json'
    if not f.exists(): return {}
    st=f.lstat()
    if f.is_symlink() or st.st_uid!=0 or st.st_mode & 0o077:
        raise ValueError('Project registry must be root-owned and private')
    registry=json.loads(f.read_text())
    if not isinstance(registry,dict): raise ValueError('Invalid project registry')
    return registry

def write_project_registry(cfg,registry):
    state=pathlib.Path(cfg.get('state_dir','/var/lib/ubuntu-control-helper'))
    state.mkdir(mode=0o700,parents=True,exist_ok=True)
    st=state.lstat()
    if state.is_symlink() or st.st_uid!=0 or st.st_mode & 0o077:
        raise ValueError('Helper state directory must be root-owned and private')
    fd,name=tempfile.mkstemp(prefix='.projects-',dir=state)
    try:
        with os.fdopen(fd,'w') as stream:
            json.dump(registry,stream);stream.flush();os.fsync(stream.fileno())
        os.replace(name,state/'projects.json')
        if os.name=='posix':
            directory=os.open(state,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(directory)
            finally:os.close(directory)
    finally:
        if os.path.exists(name): os.unlink(name)

def all_projects(cfg):
    # Preserve existing installations. Static entries keep their operator settings.
    registry=read_project_registry(cfg)
    result={**registry,**cfg.get('projects',{})}
    lifecycle_keys={'operationId','runtime','runtimePending','ownership','lifecycle','desired','updates','remoteCommit','preparedCommit','activeCommit','failedCommit','checkedAt','deployedAt','deployment','archivedAt','archive','publicBuild','envPending','externalService','release','image'}
    for identifier,static in cfg.get('projects',{}).items():
        override=registry.get(identifier,{})
        result[identifier]={**static,**{k:v for k,v in override.items() if k in lifecycle_keys}}
        if override.get('ownership')=='managed':
            result[identifier]['service']='uc:'+identifier
            result[identifier]['kind']=override['runtime']['kind'];result[identifier]['health_port']=override['runtime'].get('port')
    return result

def make_project_directory(cfg,identifier):
    import pwd,grp
    base=pathlib.Path(cfg.get('project_root','/srv/ubuntu-projects'))
    if not base.is_absolute() or base.is_symlink() or not base.is_dir(): raise ValueError('Project base directory is not available')
    st=base.stat()
    if st.st_uid!=0 or st.st_mode & 0o022: raise ValueError('Project base must be root-owned without non-root write access')
    target=base/identifier
    # The parent is not writable by project processes, so they cannot replace
    # this direct child between creation and permission setup.
    if target.is_symlink(): raise ValueError('Symlink project directories are prohibited')
    if target.exists():
        if not target.is_dir(): raise ValueError('Project path is not a directory')
        return str(target.resolve())
    uid=pwd.getpwnam(cfg.get('project_user','ubuntu-projects')).pw_uid
    gid=grp.getgrnam(cfg.get('project_group','ubuntu-projects')).gr_gid
    target.mkdir(mode=0o700)
    try:
        os.chown(target,uid,gid);target.chmod(0o2770)
        run(['/usr/bin/setfacl','-d','-m','u::rwx,g::rwx,o::---',str(target)])
    except Exception:
        # Remove only the empty directory just created; never remove user files.
        try: target.rmdir()
        except OSError: pass
        raise
    return str(target.resolve())

def create_project(cfg,args):
    identifier=project_identifier(args.get('id'))
    if Lifecycle(cfg,globals()).transaction_path(identifier).exists():raise ValueError('Project recovery is pending')
    existing=all_projects(cfg).get(identifier)
    if existing and existing.get('lifecycle')!='deleted': return project(cfg,identifier)
    if existing and identifier in cfg.get('projects',{}):raise ValueError('Remove the old static project configuration before reusing its name')
    kind=args.get('kind','node')
    if kind not in ('node','docker'): raise ValueError('Invalid project runtime')
    repo=args.get('repo') or ''
    if repo and not re.fullmatch(r'(https://github\.com/|git@github\.com:)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',repo):
        raise ValueError('Only credential-free GitHub URLs are supported')
    branch=args.get('branch') or 'main'
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./-]{0,100}',branch) or '..' in branch: raise ValueError('Invalid branch')
    managed=args.get('service') or None
    if managed: service(cfg,managed)
    port=args.get('health_port')
    if port is not None and (isinstance(port,bool) or not isinstance(port,int) or not 1024<=port<=65535): raise ValueError('Invalid health port')
    if managed and port is None: raise ValueError('A health port is required when linking a service')
    root=make_project_directory(cfg,identifier)
    record={'root':root,'kind':kind,'service':managed,'repo':repo or None,'branch':branch,'health_port':port,'qr_enabled':False}
    registry=read_project_registry(cfg);registry[identifier]=record
    write_project_registry(cfg,registry)
    return record

def project(cfg, identifier):
    project_identifier(identifier)
    p = all_projects(cfg).get(identifier)
    if not p: raise ValueError('Project was not found; add it through the website')
    if p.get('lifecycle','active')!='active':raise ValueError('Project is archived or deleted')
    root = pathlib.Path(p['root'])
    base = pathlib.Path(cfg.get('project_root', '/srv/ubuntu-projects')).resolve()
    if not root.is_absolute() or root.is_symlink() or not root.resolve().is_relative_to(base) or root.resolve() == base:
        raise ValueError('Invalid authorized project root')
    return p

def github_broker(action,args=None):
    with socket.socket(socket.AF_UNIX) as conn:
        conn.settimeout(120)
        try:
            conn.connect('/run/ubuntu-control-github/broker.sock')
            conn.sendall((json.dumps({'action':action,'args':args or {}})+'\n').encode())
            data=b''
            while b'\n' not in data:
                part=conn.recv(65536)
                if not part or len(data)>16000000:raise ValueError('Invalid GitHub broker response')
                data+=part
        except OSError as error:raise exception_details(error,'github-broker-connect','/') from None
    result=json.loads(data.split(b'\n')[0])
    if not result.get('ok'):raise OperationError(result.get('error','GitHub request failed'),result.get('details') or {'code':'GITHUB_BROKER','stage':action})
    return result['data']

def project_failure_logs(cfg,identifier,since=None):
    records=ProjectLogHub(cfg,globals()).history(identifier)
    if since is not None:
        def current(record):
            try:return datetime.datetime.fromisoformat(record['time']).timestamp()>=since
            except (ValueError,KeyError,TypeError):return False
        records=[record for record in records if current(record)]
    return '\n'.join(record['time']+' ['+record['level']+'] '+record['text'] for record in records[-80:])

def build_run(unit,user,group,argv,timeout,input_text=None):
    if not re.fullmatch(r'uc-build-[a-f0-9]{16}-(?:source|image)\.service',unit):raise ValueError('Invalid managed build unit')
    # PID1 kills the complete build cgroup on exit/timeout. The helper does not
    # gain CAP_KILL or expose a general transient-unit endpoint to the web.
    return run(['/usr/bin/systemd-run','--unit='+unit,'--pipe','--wait','--collect','--quiet','--property=User='+user,'--property=Group='+group,'--property=UMask=0007','--property=KillMode=control-group','--property=NoNewPrivileges=true','--property=RuntimeMaxSec='+str(int(timeout)),'--property=TimeoutStopSec=15','--working-directory=/','--',*argv],timeout=timeout+40,input_text=input_text)

def import_github_project(cfg,args):
    identifier=project_identifier(args.get('id'))
    repo=github_broker('repository',{'repositoryId':args.get('repositoryId')})
    existing=all_projects(cfg).get(identifier)
    if identifier in cfg.get('projects',{}):raise ValueError('בחרו שם תיקייה חדש; פרויקט זה מוגדר בתצורה הקיימת.')
    if existing:
        p=project(cfg,identifier)
        if any(pathlib.Path(p['root']).iterdir()):raise ValueError('ייבוא מחייב תיקייה ריקה. בחרו שם חדש כדי לשמור את הקבצים הקיימים.')
    else:p=create_project(cfg,{**args,'repo':repo['clone_url'],'branch':repo['default_branch']})
    p={**p,'repo':repo['clone_url'],'branch':repo['default_branch'],'auth':'github-app','github_repository_id':repo['id']}
    registry=read_project_registry(cfg);registry[identifier]=p;write_project_registry(cfg,registry)
    return p

def project_run(cfg, p, args, timeout=30):
    # Run a fixed, root-owned runner as the isolated project user. It drops all web/helper privileges.
    env=['/usr/bin/env','UC_EXPECTED_REPO='+(p.get('repo') or ''),'UC_EXPECTED_BRANCH='+(p.get('branch') or 'main')]
    if getattr(PROGRESS,'callback',None):env+=['UC_PROGRESS=1']
    credential_input=None
    if p.get('ownership')=='managed':
        runtime=p['runtime'];env+=['UC_RUNTIME_BUILD='+json.dumps({'kind':runtime['kind'],'mode':runtime.get('mode'),'script':runtime.get('script'),'dependencyInstall':runtime.get('dependencyInstall','locked'),'testScript':runtime.get('testScript',''),'buildScript':runtime.get('buildScript',''),'storageDirectories':runtime.get('storageDirectories',[]),'skipDocker':True})]
    if args[0] in ('deploy','snapshot'):
        values=Lifecycle(cfg,globals()).metadata_values(p)
        credential_input=json.dumps({'build_env':values})+'\n';env+=['UC_RUNNER_INPUT=1']
    if p.get('auth')=='github-app' and args[0] in ('clone','preview','deploy','pull'):
        lease=github_broker('repository-token',{'repositoryId':p['github_repository_id']})
        if lease['repository']['clone_url']!=p['repo']:raise ValueError('כתובת המאגר השתנתה. יש לייבא מחדש לתיקייה חדשה.')
        body=json.loads(credential_input) if credential_input else {}
        credential_input=json.dumps({**body,'token':lease['token']})+'\n'
        env+=['UC_GITHUB_AUTH_STDIN=1']
    if p.get('kind')=='docker' and p.get('ownership')!='managed':
        import pwd
        uid=pwd.getpwnam(cfg.get('project_user','ubuntu-projects')).pw_uid
        env+=['DOCKER_HOST=unix:///run/user/%d/docker.sock'%uid,'XDG_RUNTIME_DIR=/run/user/%d'%uid]
    argv=[*env,'/usr/bin/python3','/opt/ubuntu-control/helper/project_runner.py',p['root'],*args]
    if args[0] in ('deploy','snapshot'):
        life=Lifecycle(cfg,globals());unit=life.names(life.identifier(p))['build']+'-source.service'
        return build_run(unit,cfg.get('project_user','ubuntu-projects'),cfg.get('project_group','ubuntu-projects'),argv,timeout,credential_input)
    return run(['/usr/sbin/runuser', '-u', cfg.get('project_user','ubuntu-projects'), '--', *argv], timeout=timeout, input_text=credential_input)

def dispatch(cfg, action, args):
    global PROJECT_LOG_HUB
    if action=='project-port-check':return check_port(Lifecycle(cfg,globals()),project_identifier(args.get('project')),args.get('port'),args.get('listenAddress','127.0.0.1'))
    if action.startswith('network-'):return dispatch_publication(cfg,action,args,globals())
    if action=='project-env-preview':
        Lifecycle(cfg,globals()).lookup(project_identifier(args.get('project')))
        return {'keys':list(parse_import(args.get('text')))}
    if action=='project-env-import':
        identifier=project_identifier(args.get('project'))
        with project_lock(identifier):
            if FIREWALL_WORK.is_set() or (pathlib.Path(cfg.get('state_dir','/var/lib/ubuntu-control-helper'))/'pending.json').exists():raise ValueError('A firewall operation is pending')
            life=Lifecycle(cfg,globals());values=parse_import(args.get('text'))
            if life.transaction_path(identifier).exists():raise ValueError('Project recovery is pending')
            p=life.lookup(identifier)
            return life.environment(identifier,{'set':values,'importEmpty':True,'publicBuild':[k for k in p.get('publicBuild',[]) if k not in values]})
    if action in ('project-clone','project-pull','project-rollback') and Lifecycle(cfg,globals()).transaction_path(project_identifier(args.get('project'))).exists():raise ValueError('Project recovery is pending')
    pending_file = pathlib.Path(cfg.get('state_dir','/var/lib/ubuntu-control-helper'))/'pending.json'
    if (pending_file.exists() or FIREWALL_WORK.is_set()) and action in (MUTATIONS | {'project-deploy','project-clone','project-rollback','service'}):
        raise ValueError('Confirm or roll back the pending firewall transaction first')
    if action=='project-log-history':
        with REGISTRY_LOCK:
            if PROJECT_LOG_HUB is None:PROJECT_LOG_HUB=ProjectLogHub(cfg,globals())
        return PROJECT_LOG_HUB.history(args['project'],args.get('cursor'))
    if action in READ_ACTIONS or action in MUTATIONS:return dispatch_lifecycle(cfg,action,args,globals())
    if action=='service' and str(args.get('service','')).startswith('uc:'):
        if not args.get('confirmed'):raise ValueError('Explicit confirmation required')
        return dispatch_lifecycle(cfg,'project-'+args['operation'],{'project':args['service'][3:]},globals())
    if action=='project-deploy' and project(cfg,args['project']).get('ownership')=='managed':
        return dispatch_lifecycle(cfg,'project-activate',args,globals())
    if action in ('github-status','github-configure','github-check','github-repositories','github-disconnect'):
        return github_broker(action.removeprefix('github-'),args)
    if action=='github-import':return import_github_project(cfg,args)
    pending_file = pathlib.Path(cfg.get('state_dir','/var/lib/ubuntu-control-helper'))/'pending.json'
    if pending_file.exists() and action in ('project-deploy','project-clone','project-rollback','service'):
        raise ValueError('Confirm or roll back the pending firewall transaction first')
    if action == 'inventory': return inventory(cfg)
    if action == 'project-create': return create_project(cfg,args)
    if action == 'service': return service_action(cfg, args)
    if action == 'logs':
        text=logs(cfg,args);life=Lifecycle(cfg,globals())
        for identifier,p in all_projects(cfg).items():
            if p.get('service')==args.get('service') and p.get('lifecycle')!='deleted':text=life.redact(identifier,text)
        return text
    if action == 'firewall-status': return firewall_status(cfg)
    if action == 'firewall-change':
        with REGISTRY_LOCK:
            if FIREWALL_WORK.is_set():raise ValueError('Wait for the active network operation')
            if any(lock.locked() for lock in PROJECT_LOCKS.values()):raise ValueError('Wait for active project/service operations before changing the firewall')
            FIREWALL_WORK.set()
        try:return firewall_change(cfg,args)
        finally:FIREWALL_WORK.clear()
    if action == 'firewall-rollback': rollback(cfg, args['transaction']); return {'restored':True}
    if action == 'firewall-confirm':
        f = pathlib.Path(cfg.get('state_dir','/var/lib/ubuntu-control-helper'))/'pending.json'
        pending = json.loads(f.read_text())
        if pending['id'] != args['transaction'] or time.time()>pending['deadline']: raise ValueError('Transaction expired')
        f.unlink(); return {'confirmed':True}
    if action == 'project-status': return json.loads(project_run(cfg, project(cfg,args['project']), ['status']))
    if action == 'project-qr':
        p=project(cfg,args['project'])
        if not p.get('qr_enabled'): raise ValueError('QR integration is not enabled for this project')
        if p.get('ownership')=='managed' and p.get('runtime',{}).get('kind')=='node':return Lifecycle(cfg,globals()).qr(args['project'])
        return json.loads(project_run(cfg,p,['qr']))
    if action == 'project-releases': return json.loads(project_run(cfg,project(cfg,args['project']),['releases']))
    if action == 'project-rollback':
        p=project(cfg,args['project'])
        if not args.get('confirmed'): raise ValueError('Explicit rollback confirmation required')
        if p.get('ownership')=='managed':return Lifecycle(cfg,globals()).rollback_release(args['project'],args['release'])
        result=json.loads(project_run(cfg,p,['rollback',args['release']],120))
        if not result['restored']: raise ValueError('No previous release is available')
        service_action(cfg,{'service':p['service'],'operation':'restart','confirmed':True})
        with urllib.request.urlopen('http://127.0.0.1:%d/' % int(p['health_port']),timeout=10) as r:
            if r.status>=400: raise ValueError('Rollback health check failed')
        return result
    if action == 'project-preview': return json.loads(project_run(cfg, project(cfg,args['project']), ['preview'], 60))
    if action == 'project-pull':
        if not args.get('confirmed'):raise ValueError('Explicit pull confirmation required')
        return json.loads(project_run(cfg,project(cfg,args['project']),['pull'],120))
    if action == 'project-clone':
        p = project(cfg,args['project'])
        return json.loads(project_run(cfg, p, ['clone', p.get('repo',''), p.get('branch','main')],120))
    if action == 'project-deploy':
        p = project(cfg,args['project'])
        if not p.get('service') or not p.get('health_port'): raise ValueError('Link a managed service and health port before deployment')
        if service(cfg,p['service'])['kind'] != 'systemd': raise ValueError('Release deployment requires a systemd service (Node or rootless Docker launcher)')
        if not args.get('confirmed'): raise ValueError('Deployment confirmation required')
        result = json.loads(project_run(cfg,p,['deploy',args['expected']],600))
        try:
            service_action(cfg, {'service':p['service'],'operation':'restart','confirmed':True})
            port = int(p['health_port'])
            for _ in range(15):
                try:
                    with urllib.request.urlopen('http://127.0.0.1:%d/' % port,timeout=3) as r:
                        if r.status < 400: return result
                except Exception: time.sleep(1)
            raise ValueError('Post-deployment health check failed')
        except Exception:
            restored=json.loads(project_run(cfg,p,['rollback',result['release']],120))
            if restored['restored']:
                service_action(cfg, {'service':p['service'],'operation':'restart','confirmed':True})
                raise ValueError('Deployment failed; previous release restored (verify application health)') from None
            service_action(cfg, {'service':p['service'],'operation':'stop','confirmed':True})
            raise ValueError('First deployment failed; no previous release exists and the service was stopped') from None
    if action == 'project-env':
        # Keep the replacement endpoint compatible, with the same atomic validation.
        life=Lifecycle(cfg,globals());identifier=args['project'];values=args.get('values',{})
        old=life.metadata(identifier)
        return life.environment(identifier,{'set':values,'unset':[k for k in old['keys'] if k not in values],'publicBuild':[k for k in old['publicBuild'] if k in values]})
    if action == 'project-authorized':
        return {k:{key:v.get(key) for key in ('root','service','repo','branch','health_port','kind')} for k,v in all_projects(cfg).items() if v.get('lifecycle','active')=='active'}
    raise ValueError('Unsupported helper action')

def watchdog(cfg):
    while True:
        with LOCK:
            f = pathlib.Path(cfg.get('state_dir','/var/lib/ubuntu-control-helper'))/'pending.json'
            if f.exists():
                try:
                    pending = json.loads(f.read_text())
                    if time.time() > pending['deadline']: rollback(cfg,pending['id'])
                except Exception: print('Firewall rollback requires operator attention',file=sys.stderr)
        time.sleep(3)

def serve():
    cfg = load_config()
    socket_path = cfg.get('socket','/run/ubuntu-control/helper.sock')
    pathlib.Path(socket_path).parent.mkdir(mode=0o750,parents=True,exist_ok=True)
    if os.path.exists(socket_path): os.unlink(socket_path)
    server = socket.socket(socket.AF_UNIX); server.bind(socket_path); os.chmod(socket_path,0o660)
    import pwd, grp
    os.chown(socket_path,0,grp.getgrnam(cfg.get('web_group','ubuntu-control')).gr_gid)
    allowed = pwd.getpwnam(cfg.get('web_user','ubuntu-control')).pw_uid
    recover_transactions(cfg,globals())
    Publication(cfg,globals()).recover()
    Publication(cfg,globals()).clear_bootstrap()
    threading.Thread(target=watchdog,args=(cfg,),daemon=True).start()
    threading.Thread(target=rehydrate,args=(cfg,globals()),daemon=True).start()
    server.listen(16)
    def client(conn):
        with conn:
            try:
                conn.settimeout(10)
                _,uid,_ = struct.unpack('3i',conn.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                if uid != allowed: raise ValueError('Unauthorized peer')
                data=b''
                while b'\n' not in data:
                    chunk=conn.recv(65536)
                    if not chunk: raise ValueError('Incomplete request')
                    data+=chunk
                    if len(data)>2200000: raise ValueError('Request too large')
                request=json.loads(data.split(b'\n')[0])
                if not isinstance(request,dict) or not isinstance(request.get('action'),str) or len(request['action'])>80 or not isinstance(request.get('args',{}),dict):raise ValueError('Invalid helper request')
                action=request['action'];args=request.get('args',{})
                send_lock=threading.Lock()
                def progress(event):
                    try:
                        with send_lock:conn.sendall((json.dumps({'event':event})+'\n').encode())
                    except OSError:pass # Client disconnect must not interrupt transaction recovery.
                PROGRESS.callback=progress
                PROGRESS.secrets=Lifecycle(cfg,globals()).secret_values(args['project']) if args.get('project') in all_projects(cfg) else ()
                # Read-only and long-running project work never holds the firewall lock.
                if action=='project-log-stream':
                    global PROJECT_LOG_HUB
                    with REGISTRY_LOCK:
                        if PROJECT_LOG_HUB is None:PROJECT_LOG_HUB=ProjectLogHub(cfg,globals())
                    PROJECT_LOG_HUB.serve(conn,args);return
                if action.startswith('firewall-'):
                    with LOCK:result=dispatch(cfg,action,args)
                elif action in ('project-clone','project-pull','project-rollback'):
                    with project_lock(project_identifier(args.get('project'))):result=dispatch(cfg,action,args)
                elif action=='project-deploy' and project(cfg,args['project']).get('ownership')!='managed':
                    with project_lock(args['project']),BUILD_LOCK:result=dispatch(cfg,action,args)
                elif action in ('project-create','github-import'):
                    with REGISTRY_LOCK:result=dispatch(cfg,action,args)
                elif action=='service' and not str(args.get('service','')).startswith('uc:'):
                    with project_lock('service:'+str(args.get('service',''))):result=dispatch(cfg,action,args)
                elif action=='project-env':
                    with project_lock(args['project']):result=dispatch(cfg,action,args)
                else:result=dispatch(cfg,action,args)
                conn.sendall((json.dumps({'ok':True,'data':result})+'\n').encode())
            except Exception as e:
                # Exception text is limited to controlled validation/system errors, never subprocess output.
                message=str(e) if isinstance(e,ValueError) else 'System operation failed; inspect helper service'
                action=request.get('action') if isinstance(locals().get('request'),dict) and isinstance(request.get('action'),str) else 'helper-request'
                details=getattr(e,'details',None) or exception_details(e,action,'/').details
                if details:details={**details,'action':request.get('action') if isinstance(locals().get('request'),dict) else None}
                try: conn.sendall((json.dumps({'ok':False,'error':message,'details':details})+'\n').encode())
                except OSError: pass
    while True:
        conn,_=server.accept(); threading.Thread(target=client,args=(conn,),daemon=True).start()

if __name__ == '__main__': serve()
