#!/usr/bin/python3
"""Unprivileged, fixed Git/release workflow; invoked only by the helper."""
import os, sys, json, subprocess, pathlib, re, time
from git_credentials import credentials
from diagnostics import failure,exception_details,serialize,OperationError

GITHUB_TOKEN=None

def command(root, argv, timeout=240):
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_ALLOW_PROTOCOL='https:ssh', GIT_SSH_COMMAND='/usr/bin/ssh -oBatchMode=yes -oStrictHostKeyChecking=yes', npm_config_audit='false')
    name=pathlib.Path(argv[0]).name
    if name=='git':stage='git-'+next((x for x in argv[1:] if x in ('clone','fetch','remote','status','rev-parse','for-each-ref','log','branch','merge','worktree')),'command')
    elif name=='env' and len(argv)>2 and argv[1]=='npm':stage='npm-'+(argv[3] if argv[2]=='run' and len(argv)>3 else argv[2])
    else:stage=' '.join(argv[:3])
    try:p = subprocess.run(argv,cwd=root,env=env,capture_output=True,text=True,timeout=timeout)
    except (OSError,subprocess.TimeoutExpired) as error:raise exception_details(error,stage,root,(GITHUB_TOKEN,)) from None
    if p.returncode: raise failure(argv,root,stage,returncode=p.returncode,stdout=p.stdout,stderr=p.stderr,secrets=(GITHUB_TOKEN,))
    return p.stdout.strip()

def git(root, *args): return command(root,['/usr/bin/git','-c','core.hooksPath=/dev/null',*args])

def network_command(root,argv):
    if not GITHUB_TOKEN:return command(root,[argv[0],'-c','core.hooksPath=/dev/null',*argv[1:]])
    expected=repository(os.environ['UC_EXPECTED_REPO'])
    if not expected.startswith('https://github.com/'):raise ValueError('GitHub App requires canonical HTTPS URLs')
    with credentials(expected,GITHUB_TOKEN) as auth_env:
        env=dict(os.environ,**auth_env)
        # Reset configured credential helpers/headers and disable redirects. Askpass
        # checks the exact host + repository path, including URL rewrite attempts.
        argv=[argv[0],'-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','credential.username=x-access-token','-c','credential.useHttpPath=true','-c','http.followRedirects=false','-c','http.extraHeader=',*argv[1:]]
        stage='git-clone' if 'clone' in argv else 'git-fetch'
        try:p=subprocess.run(argv,cwd=root,env=env,capture_output=True,text=True,timeout=240)
        except (OSError,subprocess.TimeoutExpired) as error:raise exception_details(error,stage,root,(GITHUB_TOKEN,)) from None
        if p.returncode:raise failure(argv,root,stage,returncode=p.returncode,stdout=p.stdout,stderr=p.stderr,secrets=(GITHUB_TOKEN,))
        return p.stdout.strip()

def fetch(root,*args):return network_command(root,['/usr/bin/git','fetch',*args])

def repository(value):
    if not re.fullmatch(r'(https://github\.com/|git@github\.com:)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?',value): raise ValueError('Only credential-free GitHub repositories are supported')
    return value

def status(root):
    remote=repository(git(root,'remote','get-url','origin'))
    branch=git(root,'branch','--show-current')
    if os.environ.get('UC_EXPECTED_REPO') and remote!=os.environ['UC_EXPECTED_REPO']: raise ValueError('Repository differs from the authorized configuration')
    if os.environ.get('UC_EXPECTED_BRANCH') and branch!=os.environ['UC_EXPECTED_BRANCH']: raise ValueError('Branch differs from the authorized configuration')
    current=git(root,'rev-parse','HEAD')
    dirty=bool(git(root,'status','--porcelain','--','.',':(exclude)current',':(exclude).control*',':(exclude)shared'))
    upstream=git(root,'for-each-ref','--format=%(objectname)','refs/remotes/origin/'+branch)
    return {'repo':remote,'branch':branch,'commit':current,'dirty':dirty,'remoteCommit':upstream or None,'remoteChecked':False}

def execute(root,action,args):
    global GITHUB_TOKEN
    if action=='qr':
        f=root/'shared/whatsapp/qr.json'
        if f.is_symlink() or f.stat().st_size>10000: raise ValueError('Invalid QR payload')
        payload=json.loads(f.read_text())
        if not isinstance(payload.get('qr'),str) or len(payload['qr'])>5000 or not time.time()*1000<payload.get('expires',0)<time.time()*1000+120000: raise ValueError('QR is missing or expired')
        return {'qr':payload['qr'],'expires':payload['expires']}
    if action=='releases':
        records=[]
        for f in sorted((root/'.control-releases').glob('*.json'),reverse=True):
            if re.fullmatch(r'\d+-[a-f0-9]{10}\.json',f.name):
                record=json.loads(f.read_text());records.append({'release':f.stem,'commit':record['commit'],'rollbackAvailable':record['previous'] is not None})
        return records[:30]
    if action=='clone':
        repo=repository(args[0]); branch=args[1]
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./-]{0,100}',branch) or '..' in branch: raise ValueError('Invalid branch')
        if root.exists() and any(root.iterdir()): raise ValueError('Project directory must be empty')
        root.mkdir(parents=True,exist_ok=True)
        network_command(root,['/usr/bin/git','clone','--branch',branch,'--',repo,'.'])
        return status(root)
    if action=='status': return status(root)
    if action=='preview':
        s=status(root)
        if s['dirty']: raise ValueError('Local changes must be committed or saved before deployment')
        fetch(root,'--prune','origin')
        remote=git(root,'rev-parse','refs/remotes/origin/'+s['branch'])
        changes=git(root,'log','--format=%h %s',s['commit']+'..'+remote)
        return {**s,'remoteCommit':remote,'remoteChecked':True,'changes':changes}
    if action=='pull':
        s=status(root)
        if s['dirty']:raise ValueError('Local changes prevent pull')
        fetch(root,'origin')
        GITHUB_TOKEN=None
        # Preserve a local ref before fast-forward; never reset, force or push.
        backup='control-backup-'+str(time.time_ns())
        git(root,'branch',backup,s['commit'])
        git(root,'merge','--ff-only','refs/remotes/origin/'+s['branch'])
        return {**status(root),'backupBranch':backup,'codeOnly':True}
    releases=root/'.control-releases'
    current=root/'current'
    if action=='deploy':
        s=status(root)
        if s['dirty']: raise ValueError('Local modifications prevent deployment')
        expected=args[0]
        if not re.fullmatch(r'[a-f0-9]{40}',expected): raise ValueError('Invalid expected commit')
        fetch(root,'origin')
        GITHUB_TOKEN=None  # Build/test lifecycle scripts never receive Git credentials.
        if git(root,'rev-parse','refs/remotes/origin/'+s['branch'])!=expected: raise ValueError('Remote changed; preview again')
        releases.mkdir(exist_ok=True)
        release=str(int(time.time()))+'-'+expected[:10]
        target=releases/release
        previous=os.readlink(current) if current.is_symlink() else None
        if previous and not pathlib.Path(previous).resolve().is_relative_to(releases.resolve()): raise ValueError('Current release is outside the managed release directory')
        if current.exists() and not current.is_symlink(): raise ValueError('current must be a managed symlink')
        git(root,'worktree','add','--detach',str(target),expected)
        try:
            # Build/test code executes as project user only, after explicit administrator approval.
            if (target/'package.json').exists():
                if not (target/'package-lock.json').exists(): raise ValueError('Node projects require package-lock.json')
                command(target,['/usr/bin/env','npm','ci'],300)
                package=json.loads((target/'package.json').read_text())
                for script in ('test','build'):
                    if script in package.get('scripts',{}): command(target,['/usr/bin/env','npm','run',script],300)
            elif not (target/'Dockerfile').exists():
                raise ValueError('Expected Node package.json or Dockerfile')
            # Docker projects use an operator-provisioned rootless Docker service; never build as root.
            if (target/'Dockerfile').exists():
                image='ubuntu-project-'+root.name+':'+release
                command(target,['/usr/bin/docker','build','-t',image,'.'],300)
                (target/'.control-image').write_text(image)
            (releases/(release+'.json')).write_text(json.dumps({'previous':previous,'commit':expected}))
            tmp=root/'.control-current'; tmp.symlink_to(target); tmp.replace(current)
            return {'release':release,'commit':expected,'rollbackAvailable':previous is not None}
        except Exception:
            # Keep failed releases for investigation; preserve current and persistent shared data.
            raise
    if action=='rollback':
        release=args[0]
        if not re.fullmatch(r'\d+-[a-f0-9]{10}',release): raise ValueError('Invalid release')
        record=json.loads((releases/(release+'.json')).read_text())
        previous=record['previous']
        if previous is None:
            if current.is_symlink(): current.unlink()
            return {'restored':False}
        if not pathlib.Path(previous).resolve().is_relative_to(releases.resolve()): raise ValueError('Invalid previous release')
        tmp=root/'.control-current'; tmp.symlink_to(previous); tmp.replace(current)
        return {'restored':True}
    raise ValueError('Unsupported project operation')

if __name__=='__main__':
    try:
        if os.environ.pop('UC_GITHUB_AUTH_STDIN',None)=='1':
            # Anonymous stdin pipe from the helper, never an argv/env token.
            GITHUB_TOKEN=json.loads(sys.stdin.readline(32768))['token']
            import ctypes
            ctypes.CDLL(None).prctl(4,0,0,0,0)  # PR_SET_DUMPABLE=0 on Linux.
        print(json.dumps(execute(pathlib.Path(sys.argv[1]).resolve(),sys.argv[2],sys.argv[3:])))
    except Exception as e:
        print(serialize(e,sys.argv[2] if len(sys.argv)>2 else 'project-runner',sys.argv[1] if len(sys.argv)>1 else '/', (GITHUB_TOKEN,)),file=sys.stderr); sys.exit(1)
