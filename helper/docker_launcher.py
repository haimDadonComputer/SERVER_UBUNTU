#!/usr/bin/python3
"""Run from a rootless Docker systemd service as ubuntu-projects, never root."""
import os, pathlib, re, sys
root=pathlib.Path(sys.argv[1]).resolve()
image=(root/'current/.control-image').read_text().strip()
if not re.fullmatch(r'ubuntu-project-[a-z0-9-]+:\d+-[a-f0-9]{10}',image): raise ValueError('Invalid release image')
port=int(sys.argv[2]);internal=int(sys.argv[3])
if not (1024<=port<=65535 and 1<=internal<=65535): raise ValueError('Invalid port')
os.execv('/usr/bin/docker',['docker','run','--rm','--name','uc-'+root.name,'--cap-drop=ALL','--security-opt=no-new-privileges','-p',f'127.0.0.1:{port}:{internal}','--mount',f'type=bind,src={root}/shared,dst=/app/shared',image])
