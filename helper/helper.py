#!/usr/bin/python3
"""Root-owned, local-only privileged boundary. No shell and no caller-supplied commands."""
import os, sys, json, socket, struct, subprocess, re, time, threading, pathlib, ipaddress, shutil, urllib.request, urllib.error, hashlib

CONFIG = '/etc/ubuntu-control/helper.json'
LOCK = threading.RLock()
ENV = {'PATH': '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'SYSTEMD_COLORS': '0'}

def run(argv, timeout=20, check=True):
    p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=ENV)
    if check and p.returncode:
        raise ValueError('System command failed: ' + pathlib.Path(argv[0]).name)
    return p.stdout[:4000000]

def load_config():
    p = pathlib.Path(CONFIG)
    st = p.stat()
    if st.st_uid != 0 or st.st_mode & 0o022:
        raise ValueError('Helper configuration must be root owned and not writable by group/others')
    return json.loads(p.read_text())

def service(cfg, identifier):
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
    for entry in cfg.get('services', []):
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

def project(cfg, identifier):
    p = cfg.get('projects', {}).get(identifier)
    if not p: raise ValueError('Project must be authorized in helper.json by the operator')
    root = pathlib.Path(p['root'])
    base = pathlib.Path(cfg.get('project_root', '/srv/ubuntu-projects')).resolve()
    if not root.is_absolute() or root.is_symlink() or not root.resolve().is_relative_to(base) or root.resolve() == base:
        raise ValueError('Invalid authorized project root')
    return p

def project_run(cfg, p, args, timeout=30):
    # Run a fixed, root-owned runner as the isolated project user. It drops all web/helper privileges.
    env=['/usr/bin/env','UC_EXPECTED_REPO='+p.get('repo',''),'UC_EXPECTED_BRANCH='+p.get('branch','main')]
    if p.get('kind')=='docker':
        import pwd
        uid=pwd.getpwnam(cfg.get('project_user','ubuntu-projects')).pw_uid
        env+=['DOCKER_HOST=unix:///run/user/%d/docker.sock'%uid,'XDG_RUNTIME_DIR=/run/user/%d'%uid]
    return run(['/usr/sbin/runuser', '-u', cfg.get('project_user','ubuntu-projects'), '--', *env, '/usr/bin/python3', '/opt/ubuntu-control/helper/project_runner.py', p['root'], *args], timeout=timeout)

def dispatch(cfg, action, args):
    pending_file = pathlib.Path(cfg.get('state_dir','/var/lib/ubuntu-control-helper'))/'pending.json'
    if pending_file.exists() and action in ('project-deploy','project-clone','project-rollback','service'):
        raise ValueError('Confirm or roll back the pending firewall transaction first')
    if action == 'inventory': return inventory(cfg)
    if action == 'service': return service_action(cfg, args)
    if action == 'logs': return logs(cfg, args)
    if action == 'firewall-status': return firewall_status(cfg)
    if action == 'firewall-change': return firewall_change(cfg, args)
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
        return json.loads(project_run(cfg,p,['qr']))
    if action == 'project-releases': return json.loads(project_run(cfg,project(cfg,args['project']),['releases']))
    if action == 'project-rollback':
        p=project(cfg,args['project'])
        if not args.get('confirmed'): raise ValueError('Explicit rollback confirmation required')
        result=json.loads(project_run(cfg,p,['rollback',args['release']],120))
        if not result['restored']: raise ValueError('No previous release is available')
        service_action(cfg,{'service':p['service'],'operation':'restart','confirmed':True})
        with urllib.request.urlopen('http://127.0.0.1:%d/' % int(p['health_port']),timeout=10) as r:
            if r.status>=400: raise ValueError('Rollback health check failed')
        return result
    if action == 'project-preview': return json.loads(project_run(cfg, project(cfg,args['project']), ['preview'], 60))
    if action == 'project-clone':
        p = project(cfg,args['project'])
        return json.loads(project_run(cfg, p, ['clone', p.get('repo',''), p.get('branch','main')],120))
    if action == 'project-deploy':
        p = project(cfg,args['project'])
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
        p = project(cfg,args['project']); values = args.get('values',{})
        if len(values)>100 or any(not re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}',k) or not isinstance(v,str) or len(v)>8192 or '\n' in v or '\r' in v or '\x00' in v for k,v in values.items()): raise ValueError('Invalid environment values')
        target = pathlib.Path('/etc/ubuntu-control/projects')
        target.mkdir(mode=0o700,exist_ok=True)
        # JSON-quoted values are compatible with systemd EnvironmentFile quoting for ordinary values.
        content = '\n'.join(k+'='+json.dumps(v,ensure_ascii=False) for k,v in values.items())+'\n'
        f = target/(args['project']+'.env'); f.write_text(content); f.chmod(0o600)
        return {'saved':True, 'restartRequired':True}
    if action == 'project-authorized':
        return {k:{key:v.get(key) for key in ('root','service','repo','branch','health_port','kind')} for k,v in cfg.get('projects',{}).items()}
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
    threading.Thread(target=watchdog,args=(cfg,),daemon=True).start()
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
                    if len(data)>100000: raise ValueError('Request too large')
                request=json.loads(data.split(b'\n')[0])
                with LOCK: result=dispatch(cfg,request['action'],request.get('args',{}))
                conn.sendall((json.dumps({'ok':True,'data':result})+'\n').encode())
            except Exception as e:
                # Exception text is limited to controlled validation/system errors, never subprocess output.
                message=str(e) if isinstance(e,ValueError) else 'System operation failed; inspect helper service'
                try: conn.sendall((json.dumps({'ok':False,'error':message})+'\n').encode())
                except OSError: pass
    while True:
        conn,_=server.accept(); threading.Thread(target=client,args=(conn,),daemon=True).start()

if __name__ == '__main__': serve()
