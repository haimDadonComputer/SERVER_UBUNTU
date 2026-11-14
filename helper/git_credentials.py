"""Memory-only, repository-bound askpass endpoint for one Git network command."""
import contextlib
import json
import os
import pathlib
import re
import socket
import tempfile
import threading
import urllib.parse

def answer(prompt,expected,token):
    match=re.search(r"(?:Username|Password) for '([^']+)'",prompt)
    if not match:return ''
    url=urllib.parse.urlsplit(match[1])
    want=urllib.parse.urlsplit(expected)
    if url.scheme!='https' or url.hostname!='github.com' or url.port is not None or url.path!=want.path or url.query or url.fragment or url.username not in (None,'x-access-token'):return ''
    return 'x-access-token' if prompt.startswith('Username') else token

@contextlib.contextmanager
def credentials(expected,token):
    with tempfile.TemporaryDirectory(prefix='uc-git-') as directory:
        os.chmod(directory,0o700)
        filename=str(pathlib.Path(directory)/'askpass.sock')
        server=socket.socket(socket.AF_UNIX);server.bind(filename);os.chmod(filename,0o600);server.listen(4);server.settimeout(.2)
        stopped=threading.Event()
        def respond():
            while not stopped.is_set():
                try:conn,_=server.accept()
                except socket.timeout:continue
                except OSError:break
                with conn:
                    conn.settimeout(2)
                    try:
                        data=conn.recv(8192).decode();value=answer(data,expected,token)
                        conn.sendall(value.encode())
                    except (OSError,ValueError):pass
        thread=threading.Thread(target=respond,daemon=True);thread.start()
        try:yield {'UC_GIT_CREDENTIAL_SOCKET':filename,'GIT_ASKPASS':'/opt/ubuntu-control/helper/github-askpass','GIT_TERMINAL_PROMPT':'0','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_ALLOW_PROTOCOL':'https','GIT_TRACE':'0','GIT_TRACE_CURL':'0','GIT_CURL_VERBOSE':'0'}
        finally:stopped.set();thread.join(3);server.close()
