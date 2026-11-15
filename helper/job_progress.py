"""Per-request progress; bounded output and no credentials in progress frames."""
import json
import subprocess
import threading
from diagnostics import redact

LOCAL=threading.local()
PREFIX='UC_PROGRESS_V1:'

def emit(stage,text='',secrets=()):
    callback=getattr(LOCAL,'callback',None)
    if callback:callback({'stage':redact(stage,secrets)[:100],'text':redact(text,secrets)[-2000:]})

def execute(argv,**kwargs):
    """Stream runner stderr frames, preserving the final stdout/diagnostic protocol."""
    timeout=kwargs.pop('timeout');input_text=kwargs.pop('input',None)
    kwargs.pop('capture_output',None)
    p=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs)
    callback=getattr(LOCAL,'callback',None);secret_values=getattr(LOCAL,'secrets',())
    outputs=[[],[]];sizes=[0,0]
    def read(stream,index):
        while True:
            line=stream.readline(131072)
            if not line:break
            if index==1 and line.startswith(PREFIX):
                try:
                    event=json.loads(line[len(PREFIX):])
                    if callback:callback({'stage':redact(str(event.get('stage','')),secret_values)[:100],'text':redact(str(event.get('text','')),secret_values)[-2000:]})
                except (ValueError,TypeError):pass
            else:
                outputs[index].append(line);sizes[index]+=len(line)
                while sizes[index]>4000000 and len(outputs[index])>1:sizes[index]-=len(outputs[index].pop(0))
        stream.close()
    threads=[threading.Thread(target=read,args=(stream,i),daemon=True) for i,stream in enumerate((p.stdout,p.stderr))]
    for thread in threads:thread.start()
    try:
        if input_text:p.stdin.write(input_text)
        p.stdin.close();p.wait(timeout=timeout)
    except BaseException:
        p.kill();p.wait();raise
    finally:
        for thread in threads:thread.join(timeout=5)
    return subprocess.CompletedProcess(argv,p.returncode,''.join(outputs[0]),''.join(outputs[1]))
