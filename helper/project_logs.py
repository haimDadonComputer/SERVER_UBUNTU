"""One bounded journal follower per project, shared by authenticated socket peers."""
import collections
import datetime
import json
import os
import queue
import re
import select
import socket
import subprocess
import threading
import time
import hashlib
from project_lifecycle import Lifecycle

def valid_cursor(value):
    if value is not None and (not isinstance(value,str) or len(value)>1024 or not re.fullmatch(r'[A-Za-z0-9;=:_\-.]+',value)):raise ValueError('Invalid journal cursor')
    return value

def journal_record(item,redact):
    message=item.get('MESSAGE','')
    if isinstance(message,list):message=bytes(message).decode('utf8','replace')
    priority=int(item.get('PRIORITY',6))
    return {'type':'project-log','cursor':item.get('__CURSOR'),'time':datetime.datetime.fromtimestamp(int(item.get('__REALTIME_TIMESTAMP',0))/1000000,datetime.timezone.utc).isoformat(),'level':'error' if priority<=3 else 'warning' if priority==4 else 'info','text':redact(message)[-16000:]}

class Follower:
    def __init__(self,owner,identifier,unit,cursor):
        self.owner=owner;self.identifier=identifier;self.unit=unit;self.cursor=cursor
        self.ring=collections.deque(maxlen=500);self.subscribers=set();self.lock=threading.RLock();self.stop=threading.Event();self.process=None
        self.thread=threading.Thread(target=self.read,daemon=True)
    def publish(self,record):
        with self.lock:
            if record.get('type')=='project-log':self.ring.append(record)
            for subscriber in list(self.subscribers):
                if subscriber.full():
                    while subscriber.qsize()>200:
                        try:subscriber.get_nowait()
                        except queue.Empty:break
                    subscriber.put_nowait({'type':'project-log-gap','text':'הצופה אינו עומד בקצב; חלק מההודעות דולגו.'})
                try:subscriber.put_nowait(record)
                except queue.Full:pass
    def read(self):
        cursor=self.cursor;retry=True
        while not self.stop.is_set():
            argv=['/usr/bin/journalctl','--follow','--no-pager','--output=json','--unit='+self.unit]
            argv+=['--after-cursor='+cursor] if cursor else ['--lines=200']
            try:
                self.process=subprocess.Popen(argv,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=self.owner.env)
                while not self.stop.is_set():
                    line=self.process.stdout.readline(65537)
                    if not line:break
                    if len(line)>65536:
                        while line and not line.endswith(b'\n'):line=self.process.stdout.readline(65537)
                        self.publish({'type':'project-log-gap','text':'הודעת לוג גדולה מדי הושמטה.'});continue
                    try:self.publish(journal_record(json.loads(line),lambda text:self.owner.scrub(self.identifier,text)))
                    except (ValueError,TypeError,OverflowError):continue
                if self.stop.is_set():break
                if cursor and retry:
                    cursor=None;retry=False;self.publish({'type':'project-log-gap','text':'סמן הלוג הקודם אינו זמין; מוצגת היסטוריה עדכנית.'});continue
                self.publish({'type':'project-log-error','error':'מקור הלוגים נסגר. בדקו את שירות הפרויקט.'});break
            except OSError:
                self.publish({'type':'project-log-error','error':'journalctl אינו זמין לקריאת לוגי הפרויקט.'});break
    def close(self):
        self.stop.set()
        if self.process:
            self.process.terminate()
            try:self.process.wait(3)
            except subprocess.TimeoutExpired:self.process.kill()
        self.thread.join(4)

class ProjectLogHub:
    def __init__(self,cfg,backend):self.cfg=cfg;self.backend=backend;self.env=backend['ENV'];self.followers={};self.lock=threading.RLock();self.secrets={}
    def unit(self,identifier):
        life=Lifecycle(self.cfg,self.backend);p=life.lookup(identifier,True)
        if not p.get('service'):raise ValueError('הפרויקט טרם הוגדר להפעלה. ניתן להגדיר שירות במסך הפרויקט.')
        unit=life.names(identifier)['unit'] if p.get('ownership')=='managed' else self.backend['service'](self.cfg,p['service'])['name']
        if p.get('ownership')!='managed' and self.backend['service'](self.cfg,p['service'])['kind']!='systemd':return None,p
        return unit,p
    def scrub(self,identifier,text):
        life=Lifecycle(self.cfg,self.backend);cached=self.secrets.setdefault(identifier,{'time':0,'values':set()})
        if time.monotonic()-cached['time']>1:
            try:cached['values'].update(life.secret_values(identifier))
            except (ValueError,OSError):pass
            cached['time']=time.monotonic()
        from diagnostics import redact
        return redact(text,tuple(cached['values']))
    def history(self,identifier,cursor=None):
        unit,p=self.unit(identifier);cursor=valid_cursor(cursor)
        if unit is None:return self.legacy_history(identifier,p,cursor)
        argv=['/usr/bin/journalctl','--no-pager','--output=json','--lines=250','--unit='+unit]
        if cursor:argv+=['--after-cursor='+cursor]
        process=subprocess.Popen(argv,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=self.env)
        expired=threading.Event()
        def timeout():expired.set();process.kill()
        timer=threading.Timer(15,timeout);timer.daemon=True;timer.start()
        records=[]
        try:
            while True:
                line=process.stdout.readline(65537)
                if not line:break
                if len(line)>65536:
                    while line and not line.endswith(b'\n'):line=process.stdout.readline(65537)
                    continue
                try:records.append(journal_record(json.loads(line),lambda text:self.scrub(identifier,text)))
                except (ValueError,TypeError,OverflowError):continue
                if len(records)>250:records.pop(0)
            if process.wait()!=0 or expired.is_set():raise ValueError('קריאת היסטוריית הפרויקט נכשלה; ייתכן שהלוגים או הסמן אינם זמינים.')
            return records
        finally:
            timer.cancel()
            if process.poll() is None:process.kill();process.wait()
            process.stdout.close()
    def legacy_history(self,identifier,p,cursor=None):
        # Existing Docker/PM2 adapters already restrict names and redact credentials.
        text=self.backend['logs'](self.cfg,{'service':p['service']});records=[]
        for line in text.splitlines()[-250:]:
            digest=hashlib.sha256(line.encode()).hexdigest()
            records.append({'type':'project-log','cursor':'legacy='+digest,'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'level':'info','text':self.scrub(identifier,line)[-16000:]})
        offset=next((i+1 for i,r in enumerate(records) if r['cursor']==cursor),0)
        return records[offset:]
    def serve(self,conn,args):
        identifier=self.backend['project_identifier'](args.get('project'));unit,p=self.unit(identifier);cursor=valid_cursor(args.get('cursor'))
        if p.get('lifecycle','active')!='active':raise ValueError('פרויקט בארכיון זמין להיסטוריה בלבד.')
        subscriber=queue.Queue(maxsize=250)
        with self.lock:
            follower=self.followers.get(identifier)
            if not follower:
                follower=(Follower if unit else LegacyFollower)(self,identifier,unit,cursor);self.followers[identifier]=follower
                follower.subscribers.add(subscriber);follower.thread.start()
            else:
                with follower.lock:
                    records=list(follower.ring);offset=next((i+1 for i,r in enumerate(records) if r.get('cursor')==cursor),None) if cursor else 0
                    if cursor and offset is None:subscriber.put({'type':'project-log-gap','text':'חלק מההיסטוריה כבר אינו בזיכרון.'});offset=max(0,len(records)-200)
                    for record in records[(offset or 0):][-200:]:subscriber.put(record)
                    follower.subscribers.add(subscriber)
        conn.settimeout(2)
        checked=0
        try:
            while True:
                if select.select([conn],[],[],0)[0] and conn.recv(1,socket.MSG_PEEK)==b'':break
                if time.monotonic()-checked>2:
                    if Lifecycle(self.cfg,self.backend).lookup(identifier,True).get('lifecycle','active')!='active':break
                    checked=time.monotonic()
                try:record=subscriber.get(timeout=.5)
                except queue.Empty:continue
                conn.sendall((json.dumps(record)+'\n').encode())
        except OSError:pass
        finally:
            with self.lock:
                with follower.lock:follower.subscribers.discard(subscriber)
                if not follower.subscribers:
                    self.followers.pop(identifier,None);follower.close();self.secrets.pop(identifier,None)

class LegacyFollower(Follower):
    """One shared bounded poller for legacy adapters that have no journal unit."""
    def read(self):
        cursor=self.cursor
        while not self.stop.is_set():
            try:
                _,p=self.owner.unit(self.identifier)
                records=self.owner.legacy_history(self.identifier,p,cursor)
                if cursor and records and not self.ring:
                    # The legacy adapter may have rotated its bounded history.
                    if len(records)>=250:self.publish({'type':'project-log-gap','text':'היסטוריית שירות ותיק הסתובבה; מוצגות ההודעות הזמינות.'})
                for record in records:self.publish(record);cursor=record['cursor']
            except Exception:
                self.publish({'type':'project-log-error','error':'קריאת לוגי השירות החיצוני נכשלה.'});break
            self.stop.wait(1)
