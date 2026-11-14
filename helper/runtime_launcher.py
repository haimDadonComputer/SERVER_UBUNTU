#!/usr/bin/python3
"""Root-owned launcher executed as DynamicUser or the rootless Docker user."""
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import threading
from diagnostics import redact
from project_secrets import read_values

def launch():
    credentials=pathlib.Path(os.environ['CREDENTIALS_DIRECTORY'])
    config=json.loads((credentials/'launch').read_text())
    values=read_values(credentials/'environment')
    root=pathlib.Path(config['root']);release=(root/'current').resolve()
    if not release.is_relative_to((root/'.control-releases').resolve()) or not release.is_dir():raise ValueError('Invalid active release')
    runtime=config['runtime'];known=tuple(v for k,v in values.items() if k not in config.get('publicBuild',[]) and v)
    if runtime['kind']=='node':
        if runtime['mode']=='npm':argv=['/usr/bin/env','npm','run',runtime['script'],'--',*runtime['args']]
        else:
            entry=release/runtime['entry']
            if entry.is_symlink() or not entry.resolve().is_relative_to(release):raise ValueError('Unsafe entry file')
            argv=['/usr/bin/env','node',runtime['entry'],*runtime['args']]
        env=dict(os.environ,**values)
        env.pop('CREDENTIALS_DIRECTORY',None)
        if os.environ.get('STATE_DIRECTORY'):env['HOME']=os.environ['STATE_DIRECTORY'].split(':')[0]
        env.update(HOST='127.0.0.1',PORT=str(runtime.get('port') or 3000),WWEBJS_DATA_PATH=str(root/'shared/whatsapp'),NODE_ENV=values.get('NODE_ENV','production'))
        stdin=None
    else:
        uid=os.getuid();env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':os.environ['HOME'],'DOCKER_HOST':f'unix:///run/user/{uid}/docker.sock','XDG_RUNTIME_DIR':f'/run/user/{uid}'}
        image=config['image']
        if not re.fullmatch(r'uc-project-[a-f0-9]{16}:[0-9]+-[a-f0-9]{10}',image):raise ValueError('Invalid release image')
        argv=['/usr/bin/docker','run','--rm','--name',config['container'],'--label','ubuntu-control.project='+config['id'],'--cap-drop=ALL','--security-opt=no-new-privileges','--env-file=/dev/stdin','--mount','type=volume,src='+config['volume']+',dst='+runtime['dataPath']]
        if runtime.get('port'):argv+=['--publish',f"127.0.0.1:{runtime['port']}:{runtime['internalPort']}"]
        argv+=[image];stdin=''.join(k+'='+v+'\n' for k,v in values.items()).encode()
    process=subprocess.Popen(argv,cwd=release,env=env,stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    def forward(stream,target):
        # Drop oversize lines in full; never split a secret across output chunks.
        while True:
            line=stream.readline(1048577)
            if not line:break
            if len(line)>1048576 and not line.endswith(b'\n'):
                while line and not line.endswith(b'\n'):line=stream.readline(1048577)
                target.write('<3>[oversize log line omitted]\n');target.flush();continue
            target.write(('<3>' if target is sys.stderr else '<6>')+redact(line,known));target.flush()
    threads=[threading.Thread(target=forward,args=(process.stdout,sys.stdout),daemon=True),threading.Thread(target=forward,args=(process.stderr,sys.stderr),daemon=True)]
    for thread in threads:thread.start()
    signal.signal(signal.SIGTERM,lambda *_:process.terminate())
    if stdin is not None:
        try:process.stdin.write(stdin);process.stdin.close()
        except BrokenPipeError:pass
    status=process.wait()
    for thread in threads:thread.join(3)
    return status

if __name__=='__main__':
    try:sys.exit(launch())
    except Exception:print('Managed runtime launcher failed; inspect project configuration and credential availability.',file=sys.stderr);sys.exit(1)
