#!/usr/bin/python3
"""Operator-run Ubuntu integration smoke test; isolates all test-owned resources.

Run after upgrade: sudo python3 scripts/acceptance-runtime.py [--docker]
No existing web users, database, settings, firewall or projects are modified.
"""
import argparse,json,os,pathlib,re,shutil,socket,sys,tempfile,urllib.request,uuid

REQUIRED_HELPER_FILES=('helper.py','project_lifecycle.py','project_logs.py','project_secrets.py','runtime_launcher.py','project_runner.py','project_storage.py','storage_guard.cjs')

def installed_helper_directory(directory=pathlib.Path('/opt/ubuntu-control/helper')):
    missing=[name for name in REQUIRED_HELPER_FILES if not (directory/name).is_file()]
    if missing:
        raise SystemExit('Runtime acceptance cannot start: installed helper files are missing: '+', '.join(missing)+'. The lifecycle upgrade has not completed. Run scripts/upgrade.sh from the source checkout and wait for "Upgrade complete" before retrying. No test resources were created; checkout modules will not be used as a fallback.')
    return directory

def report_failure(error,stage,state,identifier,secrets=()):
    from diagnostics import clean,redact
    from project_secrets import atomic_private
    report={'project':identifier,'stage':stage,'error':redact(str(error),secrets)[:1200],'details':clean(getattr(error,'details',{}),secrets)}
    print(json.dumps(report,ensure_ascii=False,indent=2),file=sys.stderr)
    try:atomic_private(state/('acceptance-'+stage+'-failure.json'),json.dumps(report,ensure_ascii=False,indent=2))
    except OSError:print('Could not persist the diagnostic report; use the redacted output above.',file=sys.stderr)

def cleanup_test(life,identifier):
    if life.transaction_path(identifier).exists():raise RuntimeError('Recovery is pending; test resources were preserved. Use --cleanup-state with this acceptance directory after inspecting the original failure.')
    p=life.lookup(identifier,True)
    if p.get('lifecycle','active')=='active':life.archive(identifier,{'confirmName':identifier})
    life.purge(identifier,{'confirmName':identifier})

def cleanup_state(name,backend,Lifecycle):
    # Only a single test project from a root-private acceptance registry is in
    # scope. No client-controlled project paths or main registry are accepted.
    if not re.fullmatch(r'acceptance-[A-Za-z0-9_-]+',name):raise ValueError('Expected an acceptance directory basename')
    state=pathlib.Path('/var/lib/ubuntu-control-helper')/name
    if state.is_symlink() or not state.is_dir() or state.stat().st_uid!=0 or state.stat().st_mode&0o077:raise ValueError('Acceptance directory must be root-owned and private')
    cfg={'project_root':'/srv/ubuntu-projects','state_dir':str(state),'env_dir':str(state/'env'),'projects':{},'services':[]}
    records=backend.read_project_registry(cfg)
    if len(records)!=1:raise ValueError('Acceptance cleanup requires exactly one test record')
    identifier,p=next(iter(records.items()))
    if not re.fullmatch(r'uc-accept-[a-f0-9]{10}',identifier) or p.get('root')!='/srv/ubuntu-projects/'+identifier:raise ValueError('Acceptance project scope does not match')
    life=Lifecycle(cfg,vars(backend))
    from project_lifecycle import recover_transactions
    recover_transactions(cfg,vars(backend))
    if backend.read_project_registry(cfg)[identifier].get('lifecycle')!='deleted':cleanup_test(life,identifier)
    if life.transaction_path(identifier).exists():raise RuntimeError('Recovery is still pending; no state directory was removed')
    shutil.rmtree(state)
    print('CLEANED: '+identifier)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--docker',action='store_true');parser.add_argument('--cleanup-state');args=parser.parse_args()
    if os.geteuid()!=0:sys.exit('Run with sudo on the upgraded Ubuntu server')
    if 'Ubuntu' not in pathlib.Path('/etc/os-release').read_text():sys.exit('Ubuntu is required')
    sys.path.insert(0,str(installed_helper_directory()))
    import pwd
    import helper as backend
    from project_lifecycle import Lifecycle
    from project_logs import ProjectLogHub
    from diagnostics import OperationError
    from project_secrets import read_values
    if args.cleanup_state:
        cleanup_state(args.cleanup_state,backend,Lifecycle);return
    identifier='uc-accept-'+uuid.uuid4().hex[:10]
    state=pathlib.Path(tempfile.mkdtemp(prefix='acceptance-',dir='/var/lib/ubuntu-control-helper'))
    cfg={'project_root':'/srv/ubuntu-projects','state_dir':str(state),'env_dir':str(state/'env'),'projects':{},'services':[]}
    life=Lifecycle(cfg,vars(backend));created=False;failure=None;cleanup_error=None;secret=None;stage='prepare'
    with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
    account=pwd.getpwnam('ubuntu-projects')
    # Match the production helper, so 0700 code-view regressions cannot hide
    # behind the operator shell's more permissive default umask.
    if not args.docker:os.umask(0o077)
    source='''import http from 'node:http';import fs from 'node:fs';import {spawnSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
const file=process.env.DATA_PATH||process.env.WWEBJS_DATA_PATH+'/../counter';
const stores=fs.existsSync('public/nested/Uploads')?['public/nested/Uploads','assets/Upload','data']:[];
for(const directory of stores)fs.mkdirSync(directory,{recursive:true});
http.createServer(async(req,res)=>{if(req.url==='/touch'){fs.mkdirSync(file.substring(0,file.lastIndexOf('/')),{recursive:true});fs.writeFileSync(file,'retained');for(const directory of stores)fs.writeFileSync(directory+'/persisted','retained');}
if(req.url==='/storage-probe'){
let codeReadOnly=false,moduleBlocked=false;try{fs.writeFileSync('index.mjs','unexpected')}catch(error){codeReadOnly=['EROFS','EACCES','EPERM'].includes(error.code)}
fs.copyFileSync('/bin/true','public/nested/Uploads/native');fs.chmodSync('public/nested/Uploads/native',0o755);
const native=spawnSync('./public/nested/Uploads/native');
fs.writeFileSync('public/nested/Uploads/uploaded.mjs','throw Error("uploaded code executed")');
try{await import(pathToFileURL(process.cwd()+'/public/nested/Uploads/uploaded.mjs'))}catch(error){moduleBlocked=error.code==='UC_STORAGE_CODE_BLOCKED'}
res.end(JSON.stringify({codeReadOnly,moduleBlocked,nativeBlocked:native.error?.code==='EACCES',retained:stores.every(directory=>fs.readFileSync(directory+'/persisted','utf8')==='retained')}));return;}
if(req.url==='/secret')console.error(process.env.API_KEY);
res.end(JSON.stringify({version:'VERSION',data:fs.existsSync(file)?fs.readFileSync(file,'utf8'):null}));}).listen(Number(process.env.PORT),'BIND');
'''
    def write(name,text):
        file=pathlib.Path(project['root'])/name;file.write_text(text);os.chown(file,account.pw_uid,account.pw_gid);file.chmod(0o640)
    def version(value):write('index.mjs',source.replace('VERSION',value).replace('BIND','0.0.0.0' if args.docker else '127.0.0.1'))
    def get(path='/'):
        with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=5) as response:return json.load(response)
    try:
        project=backend.create_project(cfg,{'id':identifier});created=True;version('one')
        runtime={'kind':'docker' if args.docker else 'node','mode':'entry','entry':'index.mjs','args':[],'health':'http','port':port,'healthPath':'/','autostart':False}
        if not args.docker:
            for relative in ('public','public/nested','public/nested/Uploads'):
                directory=pathlib.Path(project['root'])/relative;directory.mkdir(exist_ok=True);os.chown(directory,account.pw_uid,account.pw_gid);directory.chmod(0o750)
            runtime['storageDirectories']=['assets/Upload']
        secret='acceptance-private-'+uuid.uuid4().hex
        if args.docker:
            runtime.update(internalPort=3000,dataPath='/app/shared')
            write('Dockerfile','FROM node:24-alpine\nWORKDIR /app\nCOPY index.mjs .\nENV PORT=3000 DATA_PATH=/app/shared/counter\nCMD ["node", "index.mjs"]\n')
        life.configure(identifier,{'runtime':runtime});life.environment(identifier,{'set':{'API_KEY':secret}})
        stage='initial-start';life.control(identifier,'start');assert get()['version']=='one';get('/touch');get('/secret')
        stage='restart'
        life.control(identifier,'restart');assert get()['data']=='retained'
        if not args.docker:
            stage='storage-sandbox';assert all(get('/storage-probe').values())
        stage='update';version('two');life.deploy(identifier,{});assert get()['version']=='two';assert get()['data']=='retained'
        stage='rollback'
        write('index.mjs','process.exit(1)')
        try:life.deploy(identifier,{})
        except OperationError:pass
        else:raise AssertionError('Broken runtime was reported healthy')
        assert get()['version']=='two';assert get()['data']=='retained'
        if not args.docker:assert all(get('/storage-probe').values())
        stage='journal';records=ProjectLogHub(cfg,vars(backend)).history(identifier);assert secret not in json.dumps(records)
        stage='stopped-update'
        life.control(identifier,'stop');version('three');life.deploy(identifier,{})
        assert life.state(life.lookup(identifier))['active']!='active'
        stage='archive-restore';life.archive(identifier,{'confirmName':identifier});life.restore(identifier)
        assert life.lookup(identifier)['updates']=='manual';assert life.lookup(identifier)['desired']=='stopped'
        assert read_values(life.env_path(identifier))['API_KEY']==secret
        stage='restored-start';life.control(identifier,'start');assert get()['version']=='three';assert get()['data']=='retained'
        if not args.docker:assert all(get('/storage-probe').values())
    except Exception as error:
        failure=error;report_failure(error,stage,state,identifier,(secret,))
    finally:
        if created:
            try:
                cleanup_test(life,identifier)
            except Exception as error:
                cleanup_error=error;report_failure(error,'cleanup',state,identifier,(secret,))
                print('Test cleanup incomplete. Inspect only '+identifier+'; registry: '+str(state),file=sys.stderr)
        # This root-created private temporary registry is the only recursive cleanup.
        if failure is None and cleanup_error is None:shutil.rmtree(state)
    if failure is not None or cleanup_error is not None:
        print('FAIL: diagnostics retained in '+str(state),file=sys.stderr);raise SystemExit(1)
    print('PASS: '+('rootless Docker' if args.docker else 'DynamicUser Node')+' start/restart/local snapshot/health failure/rollback/env/data/archive/restore/redacted journal')

if __name__=='__main__':main()
