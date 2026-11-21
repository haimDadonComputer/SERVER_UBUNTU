#!/usr/bin/python3
"""Unprivileged, fixed Git/release workflow; invoked only by the helper."""
import os, sys, json, subprocess, pathlib, re, time,shutil,hashlib
from git_credentials import credentials
from diagnostics import failure,exception_details,serialize,OperationError
from job_progress import PREFIX
from project_storage import discover,configuration,configured_paths,MANIFEST

GITHUB_TOKEN=None
BUILD_ENV={}
BUILD_CONFIG={}

def readable_release(releases,target):
    # Runtime identities share only the project group; source is mounted read-only.
    releases.chmod(0o2750)
    for directory,dirs,files in os.walk(target,followlinks=False):
        pathlib.Path(directory).chmod(0o2750)
        for name in files:
            path=pathlib.Path(directory)/name
            if not path.is_symlink():path.chmod(0o750 if path.stat().st_mode & 0o111 else 0o640)

def command(root, argv, timeout=240,env_override=None):
    env = dict(os.environ, **BUILD_ENV, GIT_TERMINAL_PROMPT='0', GIT_ALLOW_PROTOCOL='https:ssh', GIT_SSH_COMMAND='/usr/bin/ssh -oBatchMode=yes -oStrictHostKeyChecking=yes', npm_config_audit='false')
    if env_override:env.update(env_override)
    name=pathlib.Path(argv[0]).name
    if name=='git':stage='git-'+next((x for x in argv[1:] if x in ('clone','fetch','remote','status','rev-parse','for-each-ref','log','branch','merge','worktree')),'command')
    elif name=='env' and len(argv)>2 and argv[1]=='npm':stage='npm-'+(argv[3] if argv[2]=='run' and len(argv)>3 else argv[2])
    else:stage=' '.join(argv[:3])
    try:
        if os.environ.get('UC_PROGRESS')=='1':
            from diagnostics import redact
            import threading
            def event(text=''):print(PREFIX+json.dumps({'stage':stage,'text':redact(text,(GITHUB_TOKEN,))}),file=sys.stderr,flush=True)
            event()
            proc=subprocess.Popen(argv,cwd=root,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            output=[[],[]]
            def consume(stream,index):
                while True:
                    line=stream.readline(16384)
                    if not line:break
                    output[index].append(line)
                    if len(output[index])>2000:output[index].pop(0)
                    event(line)
                stream.close()
            readers=[threading.Thread(target=consume,args=(stream,i),daemon=True) for i,stream in enumerate((proc.stdout,proc.stderr))]
            for reader in readers:reader.start()
            try:proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.kill();proc.wait();raise
            finally:
                for reader in readers:reader.join(timeout=5)
            p=subprocess.CompletedProcess(argv,proc.returncode,''.join(output[0]),''.join(output[1]))
        else:p = subprocess.run(argv,cwd=root,env=env,capture_output=True,text=True,timeout=timeout)
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
        return command(root,argv,240,env_override=env)

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
    storage=discover(root,configured_paths(root,root,BUILD_CONFIG.get('storageDirectories',[])) if BUILD_CONFIG.get('kind','node')=='node' else configuration(root)+BUILD_CONFIG.get('storageDirectories',[]))
    dirty=bool(git(root,'status','--porcelain','--','.',':(exclude)current',':(exclude).control*',':(exclude)shared',*[':(exclude)'+path for path in storage]))
    upstream=git(root,'for-each-ref','--format=%(objectname)','refs/remotes/origin/'+branch)
    return {'repo':remote,'branch':branch,'commit':current,'dirty':dirty,'remoteCommit':upstream or None,'remoteChecked':False}

def options(root):
    package=json.loads((root/'package.json').read_text()) if (root/'package.json').is_file() else {}
    entries=[]
    for directory,dirs,files in os.walk(root,followlinks=False):
        dirs[:]=[d for d in dirs if not d.startswith('.') and d not in ('node_modules','shared','current','data') and not (pathlib.Path(directory)/d).is_symlink()]
        if len(pathlib.Path(directory).relative_to(root).parts)>7:dirs[:]=[];continue
        for name in files:
            f=pathlib.Path(directory)/name
            if f.suffix in ('.js','.mjs','.cjs') and not f.is_symlink():entries.append(f.relative_to(root).as_posix())
            if len(entries)>=800:break
        if len(entries)>=800:break
    return {'scripts':sorted(k for k in package.get('scripts',{}) if re.fullmatch(r'[A-Za-z0-9:_-]{1,80}',k)),'entries':sorted(entries),'dockerfile':(root/'Dockerfile').is_file() and not (root/'Dockerfile').is_symlink(),'git':(root/'.git').exists(),'lockfiles':[name for name in ('package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','bun.lock','bun.lockb') if (root/name).is_file() and not (root/name).is_symlink()]}

def startup_builds(package):
    """Move only literal npm build prefixes out of the selected launch script.

    Never parse/evaluate shell text. The remaining package script is preserved
    verbatim and still runs through npm as the unprivileged runtime identity.
    """
    if BUILD_CONFIG.get('kind')!='node' or BUILD_CONFIG.get('mode')!='npm':return [],{}
    selected=BUILD_CONFIG.get('script','start');scripts=package.get('scripts',{})
    builds=[];updates={}
    for name in ('pre'+selected,selected):
        original=scripts.get(name)
        if not isinstance(original,str):continue
        remaining=original
        while True:
            match=re.fullmatch(r'\s*npm\s+run\s+([A-Za-z0-9:_-]{1,80})\s*(?:&&\s*(.+))?',remaining,flags=re.DOTALL)
            if not match:break
            build,tail=match.groups()
            if build==selected or build not in scripts or not (re.fullmatch(r'build(?::[A-Za-z0-9:_-]+)?',build) or build==BUILD_CONFIG.get('buildScript')):break
            # A launch script must keep its server command. A pure pre hook may
            # disappear once its build has completed in the release builder.
            if tail is None and name==selected:break
            if build not in builds:builds.append(build)
            remaining=tail or ''
            if not remaining:break
        if remaining!=original:updates[name]=remaining
    return builds,updates

def build_target(root,target):
    kind=BUILD_CONFIG.get('kind')
    if kind=='docker' and BUILD_CONFIG.get('skipDocker'):return
    if (target/'package.json').exists() and kind!='docker':
        if any((target/name).is_symlink() for name in ('package-lock.json','npm-shrinkwrap.json')):raise ValueError('Symlink lockfiles are prohibited')
        locked=any((target/name).is_file() for name in ('package-lock.json','npm-shrinkwrap.json'))
        policy=BUILD_CONFIG.get('dependencyInstall','locked')
        if not locked and policy not in ('allow-install','install'):
            raise OperationError('חסר קובץ נעילת תלויות של npm',{'code':'NPM_LOCKFILE_MISSING','stage':'dependency-install','cwd':str(target),'stderr':'Node projects require package-lock.json or npm-shrinkwrap.json for npm ci','hint':'הוסיפו package-lock.json למאגר, או בחרו במפורש בהגדרות ההפעלה npm install כאשר אין קובץ נעילה. אם הפרויקט משתמש ב־pnpm/yarn/bun, השתמשו ב־Dockerfile מתאים במקום להחליף מנהל חבילות אוטומטית.'})
        command(target,['/usr/bin/env','npm','install' if policy=='install' or not locked else 'ci'],300)
        package=json.loads((target/'package.json').read_text())
        startup,updates=startup_builds(package)
        scripts=([BUILD_CONFIG.get('testScript'),BUILD_CONFIG.get('buildScript')] if BUILD_CONFIG else ['test','build'])
        scripts += [script for script in startup if script not in scripts]
        for script in scripts:
            if script and BUILD_CONFIG and script not in package.get('scripts',{}):raise ValueError('Configured build/test script is missing in the new release')
            if script and script in package.get('scripts',{}):command(target,['/usr/bin/env','npm','run',script],300)
        if updates:
            # Modify only the disposable release, after every build succeeds.
            # Source checkout, lockfiles and runtime write permissions stay intact.
            manifest=target/'package.json'
            if target.resolve()==root.resolve() or manifest.is_symlink() or manifest.stat().st_nlink!=1:raise ValueError('Startup preparation requires a private release package.json')
            for name,value in updates.items():
                if value:package['scripts'][name]=value
                else:package['scripts'].pop(name,None)
            manifest.write_text(json.dumps(package,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    elif not (target/'Dockerfile').exists() and not (BUILD_CONFIG.get('mode')=='entry'):raise ValueError('Expected Node package.json or Dockerfile')
    if (target/'Dockerfile').exists() and (kind=='docker' or not BUILD_CONFIG):
        image='ubuntu-project-'+root.name+':'+target.name
        command(target,['/usr/bin/docker','build','-t',image,'.'],300)
        (target/'.control-image').write_text(image)

def snapshot(root):
    global GITHUB_TOKEN
    GITHUB_TOKEN=None
    releases=root/'.control-releases';releases.mkdir(exist_ok=True)
    staging=releases/('snapshot-'+str(time.time_ns()));staging.mkdir()
    digest=hashlib.sha256()
    storage=discover(root,configured_paths(root,root,BUILD_CONFIG.get('storageDirectories',[])) if BUILD_CONFIG.get('kind','node')=='node' else configuration(root)+BUILD_CONFIG.get('storageDirectories',[]))
    def copy(directory,relative=pathlib.Path()):
        for entry in sorted(directory.iterdir()):
            if entry.name.startswith('.') and entry.name!=MANIFEST or entry.name in ('node_modules','shared','current','data','secrets','credentials') or entry.is_symlink() or entry.suffix.lower() in ('.env','.pem','.key','.sqlite','.db'):continue
            rel=relative/entry.name;dest=staging/rel
            if rel.as_posix() in storage:dest.mkdir(exist_ok=True);continue
            if entry.is_dir():dest.mkdir();copy(entry,rel)
            elif entry.is_file():
                shutil.copy2(entry,dest);digest.update(str(rel).encode());digest.update(dest.read_bytes())
    copy(root)
    commit=digest.hexdigest()[:40];release=str(int(time.time()))+'-'+commit[:10];target=releases/release
    if target.exists():release=str(time.time_ns())+'-'+commit[:10];target=releases/release
    staging.rename(target);build_target(root,target);readable_release(releases,target)
    current=root/'current';previous=os.readlink(current) if current.is_symlink() else None
    if current.exists() and not current.is_symlink():raise ValueError('current must be a managed symlink')
    (releases/(release+'.json')).write_text(json.dumps({'previous':previous,'commit':'local-'+commit}))
    tmp=root/'.control-current';tmp.unlink(missing_ok=True);tmp.symlink_to(target);tmp.replace(current)
    return {'release':release,'commit':'local-'+commit,'rollbackAvailable':previous is not None}

def execute(root,action,args):
    global GITHUB_TOKEN
    if action=='options':return options(root)
    if action=='snapshot':return snapshot(root)
    if action=='clear-current':
        current=root/'current'
        if current.is_symlink():current.unlink()
        elif current.exists():raise ValueError('current is not a managed symlink')
        return {'cleared':True}
    if action=='select-release':
        release=args[0]
        if not re.fullmatch(r'\d+-[a-f0-9]{10}',release):raise ValueError('Invalid release')
        target=root/'.control-releases'/release
        if target.is_symlink() or not target.is_dir():raise ValueError('Invalid release directory')
        tmp=root/'.control-current';tmp.unlink(missing_ok=True);tmp.symlink_to(target);tmp.replace(root/'current')
        return {'selected':release}
    if action=='head':
        repo=repository(git(root,'remote','get-url','origin'));branch=git(root,'branch','--show-current')
        if os.environ.get('UC_EXPECTED_REPO') and repo!=os.environ['UC_EXPECTED_REPO']:raise ValueError('Repository differs from the authorized configuration')
        if os.environ.get('UC_EXPECTED_BRANCH') and branch!=os.environ['UC_EXPECTED_BRANCH']:raise ValueError('Branch differs from the authorized configuration')
        output=network_command(root,['/usr/bin/git','ls-remote','--exit-code','--heads',repo,'refs/heads/'+branch])
        found=re.fullmatch(r'([a-f0-9]{40})\s+refs/heads/'+re.escape(branch),output)
        if not found:raise ValueError('Remote branch was not found')
        return {'sha':found[1],'notModified':False}
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
        release=str(time.time_ns())+'-'+expected[:10]
        target=releases/release
        previous=os.readlink(current) if current.is_symlink() else None
        if previous and not pathlib.Path(previous).resolve().is_relative_to(releases.resolve()): raise ValueError('Current release is outside the managed release directory')
        if current.exists() and not current.is_symlink(): raise ValueError('current must be a managed symlink')
        git(root,'worktree','add','--detach',str(target),expected)
        try:
            build_target(root,target)
            readable_release(releases,target)
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
        prior=pathlib.Path(previous)
        metadata=json.loads((releases/(prior.name+'.json')).read_text())
        return {'restored':True,'release':prior.name,'commit':metadata['commit']}
    raise ValueError('Unsupported project operation')

if __name__=='__main__':
    try:
        BUILD_CONFIG=json.loads(os.environ.pop('UC_RUNTIME_BUILD','{}'))
        has_token=os.environ.pop('UC_GITHUB_AUTH_STDIN',None)=='1'
        has_input=os.environ.pop('UC_RUNNER_INPUT',None)=='1'
        if has_token or has_input:
            # Anonymous stdin pipe from the helper, never an argv/env token.
            body=json.loads(sys.stdin.readline(1048576));GITHUB_TOKEN=body.get('token');BUILD_ENV=body.get('build_env',{})
            import ctypes
            ctypes.CDLL(None).prctl(4,0,0,0,0)  # PR_SET_DUMPABLE=0 on Linux.
        print(json.dumps(execute(pathlib.Path(sys.argv[1]).resolve(),sys.argv[2],sys.argv[3:])))
    except Exception as e:
        print(serialize(e,sys.argv[2] if len(sys.argv)>2 else 'project-runner',sys.argv[1] if len(sys.argv)>1 else '/', (GITHUB_TOKEN,)),file=sys.stderr); sys.exit(1)
