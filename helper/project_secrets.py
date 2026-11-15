"""Private, atomic project environment files. No secret values in public metadata."""
import json
import os
import pathlib
import re
import tempfile

NAME=re.compile(r'[A-Z][A-Z0-9_]{0,63}')

def read_values(filename):
    p=pathlib.Path(filename)
    if not p.exists():return {}
    if p.is_symlink() or not p.is_file() or p.stat().st_nlink!=1:raise ValueError('Unsafe environment file')
    values={}
    for line in p.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):continue
        key,sep,value=line.partition('=')
        if not sep or not NAME.fullmatch(key):raise ValueError('Invalid environment file format')
        try:values[key]=json.loads(value)
        except ValueError:values[key]=value
        if not isinstance(values[key],str):raise ValueError('Environment values must be strings')
    return values

def atomic_private(filename,content):
    p=pathlib.Path(filename);p.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    if p.is_symlink():raise ValueError('Symlink configuration is prohibited')
    fd,temp=tempfile.mkstemp(prefix='.save-',dir=p.parent)
    try:
        os.fchmod(fd,0o600) if hasattr(os,'fchmod') else None
        with os.fdopen(fd,'w',encoding='utf8') as stream:stream.write(content);stream.flush();os.fsync(stream.fileno())
        os.replace(temp,p)
        if os.name=='posix':
            directory=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(directory)
            finally:os.close(directory)
    finally:
        if os.path.exists(temp):os.unlink(temp)

def parse_import(text):
    if not isinstance(text,str) or len(text.encode('utf8'))>1048576:raise ValueError('ENV file exceeds 1 MiB')
    values={}
    for number,line in enumerate(text.lstrip('\ufeff').splitlines(),1):
        line=line.strip()
        if not line or line.startswith('#'):continue
        if line.startswith('export '):line=line[7:].lstrip()
        key,sep,value=line.partition('=');key=key.strip();value=value.strip()
        def invalid():raise ValueError('Invalid ENV declaration at line '+str(number))
        if not sep or not NAME.fullmatch(key) or key in values:invalid()
        if value.startswith(('"',"'")):
            quote=value[0];end=1;parts=[]
            while end<len(value) and value[end]!=quote:
                if quote=='"' and value[end]=='\\' and end+1<len(value):
                    end+=1
                    if value[end] in ('n','r'):invalid()
                    if value[end] not in ('"','\\'):parts.append('\\')
                parts.append(value[end]);end+=1
            if end<0 or value[end+1:].strip() and not value[end+1:].lstrip().startswith('#'):invalid()
            if end>=len(value):invalid()
            value=''.join(parts)
        else:value=value.split('#',1)[0].rstrip()
        if len(value)>8192 or any(c in value for c in ('\0','\n','\r','`')) or re.search(r'\$(?:\{|\(|[A-Za-z_])',value):invalid()
        if key.startswith(('LD_','PYTHON','GIT_','UC_','DOCKER_','SYSTEMD_','XDG_')) or key in ('PATH','HOME','CREDENTIALS_DIRECTORY'):invalid()
        values[key]=value
        if len(values)>100:invalid()
    if not values:raise ValueError('ENV file contains no variables')
    return values

def patch_values(filename,updates,unset=None,public=None,allow_empty=False):
    unset=[] if unset is None else unset;public=[] if public is None else public
    if not isinstance(updates,dict) or len(updates)>100:raise ValueError('Invalid environment update')
    if not isinstance(unset,list) or not isinstance(public,list):raise ValueError('Invalid environment metadata')
    for key,value in updates.items():
        if not isinstance(key,str) or not NAME.fullmatch(key) or not isinstance(value,str) or len(value)>8192 or any(c in value for c in ('\0','\n','\r')):raise ValueError('Invalid environment key/value')
    for key in [*unset,*public]:
        if not isinstance(key,str) or not NAME.fullmatch(key):raise ValueError('Invalid environment name')
    if set(unset)&set(updates):raise ValueError('Cannot update and delete the same environment key')
    values=read_values(filename)
    values.update({k:v for k,v in updates.items() if v!='' or allow_empty})
    for key in unset:values.pop(key,None)
    if len(values)>100:raise ValueError('At most 100 environment variables are supported')
    if not set(public)<=values.keys():raise ValueError('Public build keys must already exist')
    # Runtime-loader/client security controls are never user-overridable.
    if any(k.startswith(('LD_','PYTHON','GIT_','UC_','DOCKER_','SYSTEMD_','XDG_')) or k in ('PATH','HOME','CREDENTIALS_DIRECTORY') for k in values):raise ValueError('Reserved runtime environment name')
    atomic_private(filename,''.join(k+'='+json.dumps(v,ensure_ascii=False)+'\n' for k,v in sorted(values.items())))
    return {'keys':sorted(values),'publicBuild':sorted(set(public)),'restartRequired':True}
