"""Persistent project storage and a root-owned runtime view, never writable source."""
import contextlib
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import uuid
from project_secrets import atomic_private

UPLOAD_NAMES={'upload','uploads'}
MANIFEST='.ubuntu-control.json'
RESERVED={'.git','.control-releases','current','shared','node_modules','secrets','credentials'}

def relative_path(value):
    if not isinstance(value,str) or not value or len(value)>400 or '\\' in value or ':' in value or ',' in value or value.startswith('/'):
        raise ValueError('Storage paths must be relative project directories')
    parts=value.split('/')
    if any(not part or part in ('.','..') or part.casefold().startswith(('.control','.env')) or part.casefold() in ('.ssh','.gnupg') or any(ord(c)<32 for c in part) for part in parts):
        raise ValueError('Unsafe storage directory')
    if any(part.casefold() in RESERVED for part in parts):raise ValueError('Protected storage directory')
    return '/'.join(parts)

def validate_directories(values):
    if not isinstance(values,list) or len(values)>64:raise ValueError('At most 64 data directories are supported')
    return sorted(set(relative_path(value) for value in values))

def covers(parent,child):return child==parent or child.startswith(parent+'/')

def configuration(root):
    paths=[]
    for name,key in ((MANIFEST,'storageDirectories'),('package.json','ubuntuControl')):
        path=root/name
        if path.is_symlink():raise ValueError('Symlink project storage configuration prohibited')
        if not path.exists():continue
        if not path.is_file() or path.stat().st_size>1048576 or path.stat().st_nlink!=1:raise ValueError('Unsafe project storage configuration')
        if os.name=='posix':
            with directory(root) as parent:
                fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
                try:
                    info=os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>1048576:raise ValueError('Unsafe project storage configuration')
                    chunks=[];length=0
                    while True:
                        chunk=os.read(fd,65536)
                        if not chunk:break
                        chunks.append(chunk);length+=len(chunk)
                        if length>1048576:raise ValueError('Project storage configuration exceeds limit')
                    text=b''.join(chunks).decode('utf-8-sig')
                finally:os.close(fd)
        else:text=path.read_text(encoding='utf-8-sig')
        data=json.loads(text)
        if not isinstance(data,dict):raise ValueError('Project storage configuration must be an object')
        value=data.get(key,[] if name==MANIFEST else {})
        if name=='package.json':value=value.get('storageDirectories',[]) if isinstance(value,dict) else None
        paths+=validate_directories(value)
    return paths


def configured_paths(root,release,explicit):
    paths=validate_directories(explicit)+configuration(release)
    # A code file named data must remain code, not become a writable mount.
    if all(not (base/'data').exists() or (base/'data').is_dir() for base in (root,release)):
        paths.append('data')
    return paths

def discover(root,configured=()):
    """Do not follow symlinks; an outer writable directory covers its descendants."""
    found=set(validate_directories(list(configured)))
    scanned=0
    def walk(directory,parts=()):
        nonlocal scanned
        for entry in os.scandir(directory):
            scanned+=1
            if scanned>300000:raise ValueError('Storage discovery exceeded 300000 entries')
            name=entry.name;relative='/'.join((*parts,name))
            upload=name.casefold() in UPLOAD_NAMES
            if name in ('.git','.control-releases','current','shared','node_modules'):continue
            if entry.is_symlink():
                if upload or any(covers(relative,p) or covers(p,relative) for p in found):raise ValueError('Symlink storage path prohibited: '+relative)
                continue
            if upload:
                if not entry.is_dir(follow_symlinks=False):raise ValueError('Upload path is not a directory: '+relative)
                found.add(relative)
            if entry.is_dir(follow_symlinks=False) and not any(covers(p,relative) for p in found):
                if isinstance(directory,int):
                    child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
                    try:walk(child,(*parts,name))
                    finally:os.close(child)
                else:walk(entry.path,(*parts,name))
    if os.name=='posix':
        with directory(root) as fd:walk(fd)
    else:walk(root)
    ordered=sorted(found,key=lambda value:(len(value.split('/')),value))
    result=[]
    for path in ordered:
        if not any(covers(parent,path) for parent in result):result.append(path)
    if len(result)>64:raise ValueError('At most 64 writable directories are supported')
    # Configured missing directories are allowed, but existing ancestors must be directories.
    for value in result:
        cursor=root
        for part in value.split('/'):
            cursor=cursor/part
            if cursor.is_symlink() or cursor.exists() and not cursor.is_dir():raise ValueError('Unsafe storage ancestor: '+value)
    return result

@contextlib.contextmanager
def directory(path,create=False):
    """Anchor every component without following links, including the final leaf."""
    if os.name!='posix':raise ValueError('Secure storage preparation requires Linux')
    path=pathlib.Path(path)
    if not path.is_absolute():raise ValueError('An absolute internal path is required')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            if create:
                try:os.mkdir(part,0o700,dir_fd=fd)
                except FileExistsError:pass
            next_fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=next_fd
        yield fd
    finally:os.close(fd)

def copy_tree(source,target,*,code=False,skip=(),group=None,preserve_existing=False):
    """Descriptor-anchored copy. Existing data is never overwritten or removed."""
    conflicts=[]
    with directory(source) as source_fd,directory(target,True) as target_fd:
        def copy(src,dst,parts=()):
            for entry in os.scandir(src):
                name=entry.name;rel='/'.join((*parts,name))
                if code and (name=='.git' or any(covers(p,rel) for p in skip)):continue
                info=os.stat(name,dir_fd=src,follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode):
                    if not code:raise ValueError('Symlink in persistent data: '+rel)
                    link=os.readlink(name,dir_fd=src)
                    if pathlib.PurePosixPath(link).is_absolute():raise ValueError('Absolute code symlink prohibited')
                    normalized=os.path.normpath(str(pathlib.PurePosixPath(rel).parent/link))
                    if normalized=='..' or normalized.startswith('../') or any(covers(p,normalized) for p in skip):raise ValueError('Code symlink escapes trusted code')
                    os.symlink(link,name,dir_fd=dst);continue
                if stat.S_ISDIR(info.st_mode):
                    owner=os.fstat(dst)
                    try:os.mkdir(name,0o750 if code else 0o700,dir_fd=dst);created=True
                    except FileExistsError:
                        created=False
                        existing=os.stat(name,dir_fd=dst,follow_symlinks=False)
                        if preserve_existing and stat.S_ISREG(existing.st_mode) and existing.st_nlink==1:
                            conflicts.append(rel);continue
                    a=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=src)
                    b=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=dst)
                    try:
                        if code:
                            os.fchmod(b,0o750)
                            if group is not None:os.fchown(b,0,group)
                        elif created:os.fchown(b,owner.st_uid,owner.st_gid)
                        copy(a,b,(*parts,name))
                    finally:os.close(a);os.close(b)
                elif stat.S_ISREG(info.st_mode):
                    if info.st_nlink!=1:raise ValueError('Hardlink in project storage/code: '+rel)
                    a=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=src)
                    try:
                        opened=os.fstat(a)
                        if (opened.st_ino,opened.st_dev)!=(info.st_ino,info.st_dev):raise ValueError('Source changed during preparation')
                        try:os.stat(name,dir_fd=dst,follow_symlinks=False);exists=True
                        except FileNotFoundError:exists=False
                        if exists:
                            # A backed-up legacy merge retains authoritative private data.
                            if preserve_existing and stat.S_ISDIR(os.stat(name,dir_fd=dst,follow_symlinks=False).st_mode):
                                conflicts.append(rel);continue
                            existing=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=dst)
                            try:
                                existing_info=os.fstat(existing)
                                if not stat.S_ISREG(existing_info.st_mode) or existing_info.st_nlink!=1:raise ValueError('Unsafe existing data: '+rel)
                                while True:
                                    left=os.read(a,1048576);right=os.read(existing,1048576)
                                    if left!=right:
                                        if preserve_existing:conflicts.append(rel);break
                                        raise ValueError('Persistent data migration conflict; originals preserved: '+rel)
                                    if not left:break
                            finally:os.close(existing)
                        else:
                            temporary='.uc-copy-'+uuid.uuid4().hex
                            b=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=dst)
                            try:
                                while True:
                                    chunk=os.read(a,1048576)
                                    if not chunk:break
                                    remaining=memoryview(chunk)
                                    while remaining:remaining=remaining[os.write(b,remaining):]
                                os.fsync(b)
                                if code:
                                    os.fchmod(b,0o750 if info.st_mode&0o111 else 0o640)
                                    if group is not None:os.fchown(b,0,group)
                                else:
                                    owner=os.fstat(dst);os.fchown(b,owner.st_uid,owner.st_gid)
                                after=os.fstat(a)
                                if (after.st_size,after.st_mtime_ns)!=(opened.st_size,opened.st_mtime_ns):raise ValueError('Source changed during preparation')
                                # Publish complete files only, without replacing a concurrently
                                # created destination. A failed copy cannot become private data.
                                os.link(temporary,name,src_dir_fd=dst,dst_dir_fd=dst,follow_symlinks=False)
                                os.fsync(dst)
                            finally:
                                os.close(b);os.unlink(temporary,dir_fd=dst)
                        after=os.fstat(a)
                        if (after.st_size,after.st_mtime_ns)!=(opened.st_size,opened.st_mtime_ns):raise ValueError('Source changed during preparation')
                    finally:os.close(a)
                else:raise ValueError('Special file in project storage/code: '+rel)
        copy(source_fd,target_fd)
    return conflicts


def migrate_shared(source,target,state_dir,identifier):
    """One-time legacy merge: back up first, keep private values, retain originals."""
    state=pathlib.Path(state_dir)/'storage-migrations'
    marker=state/(identifier+'.json')
    if marker.is_symlink():raise ValueError('Untrusted shared migration record')
    if marker.exists():return json.loads(marker.read_text())
    with directory(source) as fd:
        if not os.listdir(fd):return None
    backup=state/identifier/uuid.uuid4().hex
    copy_tree(source,backup)
    conflicts=copy_tree(backup,target,preserve_existing=True)
    result={'backup':str(backup),'conflicts':len(conflicts),'completed':True}
    atomic_private(marker,json.dumps(result))
    return result

def storage_child(store,relative):
    with directory(store) as parent:
        fd=os.dup(parent)
        try:
            for part in pathlib.PurePosixPath(relative).parts:
                owner=os.fstat(fd)
                try:os.mkdir(part,0o700,dir_fd=fd);created=True
                except FileExistsError:created=False
                child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                if created:os.fchown(child,owner.st_uid,owner.st_gid)
                os.close(fd);fd=child
        finally:os.close(fd)

class Storage:
    def __init__(self,life,identifier):
        self.life=life;self.id=identifier;self.key=life.names(identifier)['key'];self.cfg=life.cfg
        self.metadata=pathlib.Path(self.cfg.get('state_dir','/var/lib/ubuntu-control-helper'))/'storage'/(identifier+'.json')
        self.code=pathlib.Path(self.cfg.get('runtime_code_dir','/var/lib/ubuntu-control-code'))/self.key
        self.base=pathlib.Path(self.cfg.get('storage_dir','/var/lib/ubuntu-control-storage'))
    def catalog(self):
        if self.metadata.is_symlink():raise ValueError('Untrusted storage catalog')
        return json.loads(self.metadata.read_text()) if self.metadata.exists() else {'paths':{},'initialized':[]}
    def state_name(self,path):return 'ubuntu-control-storage/'+self.key+'-'+hashlib.sha256(path.encode()).hexdigest()[:20]
    def state_path(self,path):
        name=self.state_name(path).split('/',1)[1];normal=self.base/name
        if normal.is_symlink():
            expected=pathlib.Path('/var/lib/private/ubuntu-control-storage')/name
            if normal.lstat().st_uid!=0 or normal.resolve()!=expected:raise ValueError('Untrusted storage state link')
            return expected
        return normal
    def prepare(self,p):
        root=pathlib.Path(p['root']);release=root/'.control-releases'/p['release']
        if not re.fullmatch(r'\d+-[a-f0-9]{10}',p['release']) or release.is_symlink():raise ValueError('Invalid storage release')
        configured=configured_paths(root,release,p['runtime'].get('storageDirectories',[]))
        # Local project configuration also identifies Git-ignored missing runtime directories.
        paths=discover(release,configured)
        paths=sorted(set(paths+discover(root,configured)),key=lambda v:(len(v.split('/')),v))
        paths=[v for i,v in enumerate(paths) if not any(covers(parent,v) for parent in paths[:i])]
        for path in paths:relative_path(path)
        if len(paths)>64:raise ValueError('Too many storage directories')
        if p['runtime']['kind']!='node':raise ValueError('Managed writable directory mapping is supported for Node projects')
        import grp
        group=grp.getgrnam(self.cfg.get('project_group','ubuntu-projects')).gr_gid
        catalog=self.catalog();entries=[]
        if catalog.get('backend','node')!='node' and catalog['paths']:raise ValueError('Explicit storage migration is required before changing runtime backend')
        catalog['backend']='node'
        self.base.mkdir(mode=0o755,parents=True,exist_ok=True)
        if self.base.is_symlink() or self.base.stat().st_uid!=0 or self.base.stat().st_mode&0o022:raise ValueError('Unsafe storage root')
        for path in paths:
            parent=next((old for old in sorted(catalog['paths'],key=len) if covers(old,path)),path)
            owner=catalog['paths'].get(parent,parent)
            store=self.state_path(owner);store.mkdir(mode=0o700,parents=True,exist_ok=True)
            target=store/pathlib.PurePosixPath(path).relative_to(owner)
            storage_child(store,pathlib.PurePosixPath(path).relative_to(owner))
            if owner not in catalog['initialized']:
                for origin in (root/path,release/path):
                    if origin.exists():copy_tree(origin,target)
                # A new outer data directory may absorb older nested upload mappings.
                for old,old_owner in list(catalog['paths'].items()):
                    if covers(path,old) and old!=path:
                        old_data=self.state_path(old_owner)/pathlib.PurePosixPath(old).relative_to(old_owner)
                        if old_data.exists():copy_tree(old_data,target/pathlib.PurePosixPath(old).relative_to(path))
                        catalog['paths'][old]=owner
                catalog['initialized'].append(owner)
            catalog['paths'][path]=owner
            entries.append({'path':path,'owner':owner,'state':self.state_name(owner),'source':str(self.base/self.state_name(owner).split('/',1)[1]/pathlib.PurePosixPath(path).relative_to(owner))})
        # Root-owned projection replaces the app's view of the editable project.
        # All mount targets are created here, never below application-writable ancestors.
        self.code.mkdir(mode=0o750,parents=True,exist_ok=True)
        if self.code.is_symlink() or self.code.stat().st_uid!=0 or self.code.stat().st_mode&0o022:raise ValueError('Unsafe runtime code root')
        os.chown(self.code,0,group);self.code.chmod(0o750)
        # Rebuild pre-fix views on explicit activation; their 0700 directories
        # were created under the helper's restrictive umask.
        signature=hashlib.sha256(json.dumps({'projectionVersion':2,'paths':entries,'runtime':p['runtime']},sort_keys=True).encode()).hexdigest()[:20]
        view=self.code/(p['release']+'-'+signature)
        if view.exists():
            if view.is_symlink() or view.stat().st_uid!=0 or view.stat().st_mode&0o022:raise ValueError('Unsafe existing runtime view')
            atomic_private(self.metadata,json.dumps(catalog))
            return {'version':1,'view':str(view),'directories':entries}
        view.mkdir(mode=0o750);os.chown(view,0,group);view.chmod(0o750)
        target=view/'.control-releases'/p['release'];target.mkdir(mode=0o750,parents=True)
        os.chown(target.parent,0,group);os.chown(target,0,group);target.parent.chmod(0o750);target.chmod(0o750)
        try:
            copy_tree(release,target,code=True,skip=paths,group=group)
            for path in paths:
                # Also map absolute project-relative paths, without granting source writes.
                for destination in (target/path,view/path):
                    with directory(destination,True) as fd:os.fchown(fd,0,group);os.fchmod(fd,0o750)
                    for parent in destination.parents:
                        if parent==view:break
                        os.chown(parent,0,group);parent.chmod(0o750)
            (view/'shared').mkdir(mode=0o750);os.chown(view/'shared',0,group);(view/'shared').chmod(0o750)
            (view/'current').symlink_to(pathlib.Path('.control-releases')/p['release'])
            # Verify preserved dependency symlinks only after copying the whole tree.
            for directory_path,dirs,files in os.walk(target,followlinks=False):
                for name in (*dirs,*files):
                    link=pathlib.Path(directory_path)/name
                    if link.is_symlink() and not link.resolve().is_relative_to(target):raise ValueError('Code symlink escapes sealed release')
            entry=p['runtime'].get('entry','')
            if entry and any(covers(path,entry) for path in paths):raise ValueError('Application entry cannot be inside writable storage')
            atomic_private(self.metadata,json.dumps(catalog))
            return {'version':1,'view':str(view),'directories':entries}
        except Exception:
            shutil.rmtree(view);raise
    def purge(self):
        if not shutil.rmtree.avoids_symlink_attacks:raise ValueError('Safe storage removal requires Linux')
        catalog=self.catalog()
        for owner in catalog['initialized']:
            relative_path(owner)
            path=self.state_path(owner);normal=self.base/self.state_name(owner).split('/',1)[1];link=normal if normal.is_symlink() else None
            if path.exists():
                with directory(path.parent) as fd:shutil.rmtree(path.name,dir_fd=fd)
            if link:link.unlink()
        if self.code.exists():
            if self.code.is_symlink():raise ValueError('Untrusted runtime code path')
            with directory(self.code.parent) as fd:shutil.rmtree(self.code.name,dir_fd=fd)
        self.metadata.unlink(missing_ok=True)
