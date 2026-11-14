#!/usr/bin/python3
"""Operator-run Ubuntu integration smoke test; isolates all test-owned resources.

Run after upgrade: sudo python3 scripts/acceptance-runtime.py [--docker]
No existing web users, database, settings, firewall or projects are modified.
"""
import argparse,json,os,pathlib,shutil,socket,sys,tempfile,urllib.request,uuid

REQUIRED_HELPER_FILES=('helper.py','project_lifecycle.py','project_logs.py','project_secrets.py','runtime_launcher.py','project_runner.py')

def installed_helper_directory(directory=pathlib.Path('/opt/ubuntu-control/helper')):
    missing=[name for name in REQUIRED_HELPER_FILES if not (directory/name).is_file()]
    if missing:
        raise SystemExit('Runtime acceptance cannot start: installed helper files are missing: '+', '.join(missing)+'. The lifecycle upgrade has not completed. Run scripts/upgrade.sh from the source checkout and wait for "Upgrade complete" before retrying. No test resources were created; checkout modules will not be used as a fallback.')
    return directory

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--docker',action='store_true');args=parser.parse_args()
    if os.geteuid()!=0:sys.exit('Run with sudo on the upgraded Ubuntu server')
    if 'Ubuntu' not in pathlib.Path('/etc/os-release').read_text():sys.exit('Ubuntu is required')
    sys.path.insert(0,str(installed_helper_directory()))
    import pwd
    import helper as backend
    from project_lifecycle import Lifecycle
    from project_logs import ProjectLogHub
    from diagnostics import OperationError
    from project_secrets import read_values
    identifier='uc-accept-'+uuid.uuid4().hex[:10]
    state=pathlib.Path(tempfile.mkdtemp(prefix='acceptance-',dir='/var/lib/ubuntu-control-helper'))
    cfg={'project_root':'/srv/ubuntu-projects','state_dir':str(state),'env_dir':str(state/'env'),'projects':{},'services':[]}
    life=Lifecycle(cfg,vars(backend));created=False
    with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
    account=pwd.getpwnam('ubuntu-projects')
    source='''import http from 'node:http';import fs from 'node:fs';
const file=process.env.DATA_PATH||process.env.WWEBJS_DATA_PATH+'/../counter';
http.createServer((req,res)=>{if(req.url==='/touch'){fs.mkdirSync(file.substring(0,file.lastIndexOf('/')),{recursive:true});fs.writeFileSync(file,'retained');}
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
        secret='acceptance-private-'+uuid.uuid4().hex
        if args.docker:
            runtime.update(internalPort=3000,dataPath='/app/shared')
            write('Dockerfile','FROM node:24-alpine\nWORKDIR /app\nCOPY index.mjs .\nENV PORT=3000 DATA_PATH=/app/shared/counter\nCMD ["node", "index.mjs"]\n')
        life.configure(identifier,{'runtime':runtime});life.environment(identifier,{'set':{'API_KEY':secret}})
        life.control(identifier,'start');assert get()['version']=='one';get('/touch');get('/secret')
        life.control(identifier,'restart');assert get()['data']=='retained'
        version('two');life.deploy(identifier,{});assert get()['version']=='two';assert get()['data']=='retained'
        write('index.mjs','process.exit(1)')
        try:life.deploy(identifier,{})
        except OperationError:pass
        else:raise AssertionError('Broken runtime was reported healthy')
        assert get()['version']=='two';assert get()['data']=='retained'
        records=ProjectLogHub(cfg,vars(backend)).history(identifier);assert secret not in json.dumps(records)
        life.control(identifier,'stop');version('three');life.deploy(identifier,{})
        assert life.state(life.lookup(identifier))['active']!='active'
        life.archive(identifier,{'confirmName':identifier});life.restore(identifier)
        assert life.lookup(identifier)['updates']=='manual';assert life.lookup(identifier)['desired']=='stopped'
        assert read_values(life.env_path(identifier))['API_KEY']==secret
        life.control(identifier,'start');assert get()['version']=='three';assert get()['data']=='retained'
        print('PASS: '+('rootless Docker' if args.docker else 'DynamicUser Node')+' start/restart/local snapshot/health failure/rollback/env/data/archive/restore/redacted journal')
    finally:
        if created:
            try:
                p=life.lookup(identifier,True)
                if p.get('lifecycle','active')=='active':life.archive(identifier,{'confirmName':identifier})
                life.purge(identifier,{'confirmName':identifier})
            except Exception:
                print('Test cleanup incomplete. Inspect only '+identifier+'; registry: '+str(state),file=sys.stderr)
                raise
        # This root-created private temporary registry is the only recursive cleanup.
        shutil.rmtree(state)

if __name__=='__main__':main()
