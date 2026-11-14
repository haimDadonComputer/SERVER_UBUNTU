import unittest,importlib.util,pathlib,tempfile,json,time,base64,types,urllib.error,io,sys,os,shutil,subprocess
from unittest.mock import patch,Mock
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'helper'))
import github_app as g
from git_credentials import answer,credentials
import project_runner as runner
import helper as h

def repository(identifier=7):
    return {'id':identifier,'name':'repo-'+str(identifier),'full_name':'owner/repo-'+str(identifier),'private':True,'description':'A private repository','default_branch':'stable','updated_at':'2026-11-14T00:00:00Z'}

class GitHubTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.key=pathlib.Path(self.tmp.name)/'app.pem';self.key.write_text('PRIVATE KEY CONTENT MUST NOT LEAK')
        self.key_patch=patch.object(g,'PEM_PATH',str(self.key));self.key_patch.start();self.addCleanup(self.key_patch.stop)
        self.calls=[];self.now=1800000000
        self.app=g.GitHubApp(pathlib.Path(self.tmp.name)/'state',request=self.request,signer=lambda value:'fake-signed-jwt',clock=lambda:self.now)
        self.app.configure({'appId':'123','installationId':'456','pemPath':str(self.key)})
    def request(self,method,path,bearer,body=None):
        self.calls.append((method,path,bearer,body))
        if method=='DELETE':return {}
        if path.endswith('/access_tokens'):return {'token':'ghs_SECRET_'+str(len(self.calls)), 'expires_at':'2027-01-15T09:00:00Z'}
        if path.startswith('/installation/repositories'):return {'repositories':[repository()]}
        raise AssertionError(path)
    def test_rs256_jwt_claims_signing_without_key_output(self):
        with patch.object(g.pathlib.Path,'is_file',return_value=True),patch.object(g.pathlib.Path,'is_symlink',return_value=False),patch.object(g.pathlib.Path,'stat',return_value=types.SimpleNamespace(st_uid=0,st_mode=0o640)),patch.object(g.subprocess,'run',return_value=types.SimpleNamespace(stdout=b'RSA-signature')) as command:
            jwt=g.sign_jwt('123',key_path=str(self.key),now=1000)
        decode=lambda x:json.loads(base64.urlsafe_b64decode(x+'='*(-len(x)%4)))
        header,payload,_=jwt.split('.')
        self.assertEqual(decode(header)['alg'],'RS256');self.assertEqual(decode(payload),{'iat':940,'exp':1540,'iss':'123'})
        self.assertIn('-sha256',command.call_args.args[0]);self.assertNotIn(self.key.read_text(),jwt)
    def test_status_and_saved_state_never_include_tokens_or_pem(self):
        self.app.check();self.app.dispatch('repository-token',{'repositoryId':7})
        public=json.dumps(self.app.status())
        disk=''.join(p.read_text() for p in self.app.state.glob('*.json'))
        for value in ('ghs_SECRET','PRIVATE KEY CONTENT','fake-signed-jwt'):
            self.assertNotIn(value,public);self.assertNotIn(value,disk)
        self.app.config['privateKey']='INJECTED-PRIVATE-KEY';self.app.last['token']='INJECTED-TOKEN'
        self.assertNotIn('INJECTED',json.dumps(self.app.status()))
    @unittest.skipUnless(os.name=='posix' and shutil.which('git'),'Real Git askpass requires POSIX Git')
    def test_real_git_credential_fill_uses_memory_socket_and_leaves_no_files(self):
        expected='https://github.com/owner/repo.git'
        askpass=pathlib.Path(self.tmp.name)/'askpass'
        content=(pathlib.Path(__file__).resolve().parents[1]/'helper/github-askpass').read_text()
        askpass.write_text(content.replace('#!/usr/bin/python3','#!'+sys.executable));askpass.chmod(0o700)
        with credentials(expected,'EPHEMERAL-TEST-SECRET') as env:
            socket_path=env['UC_GIT_CREDENTIAL_SOCKET'];env={**os.environ,**env,'GIT_ASKPASS':str(askpass)}
            p=subprocess.run(['git','-c','credential.helper=','-c','credential.username=x-access-token','-c','credential.useHttpPath=true','credential','fill'],input='url='+expected+'\n\n',text=True,capture_output=True,env=env,cwd=self.tmp.name,timeout=10)
            self.assertEqual(p.returncode,0,p.stderr);self.assertIn('password=EPHEMERAL-TEST-SECRET',p.stdout)
        self.assertFalse(os.path.exists(socket_path))
    def test_listing_paginates_and_projects_get_read_only_scoped_tokens(self):
        def api(method,path,bearer,body=None):
            if path.startswith('/installation/repositories'):
                return {'repositories':[repository(i) for i in range(1,101)] if path.endswith('&page=1') else [repository(101)]}
            return self.request(method,path,bearer,body)
        self.app.request=api
        self.assertEqual(len(self.app.repositories()),101)
        self.app.dispatch('repository-token',{'repositoryId':7})
        body=[c[3] for c in self.calls if c[0]=='POST'][-1]
        self.assertEqual(body,{'repository_ids':[7],'permissions':{'contents':'read','metadata':'read'}})
    def test_repository_outside_installation_cannot_receive_token(self):
        with self.assertRaises(g.GitHubError):self.app.dispatch('repository-token',{'repositoryId':999})
        self.assertFalse(any(c[3] and c[3].get('repository_ids')==[999] for c in self.calls))
    def test_head_uses_scoped_token_sha_media_type_etag_and_encoded_branch(self):
        requests=[]
        def api(method,path,bearer,body=None,headers=None):
            if path.startswith('/repos/'):
                requests.append((path,headers,bearer))
                return {'notModified':True} if headers.get('If-None-Match') else {'sha':'a'*40,'etag':'"version-one"'}
            return self.request(method,path,bearer,body)
        self.app.request=api
        args={'repositoryId':7,'fullName':'owner/repo-7','branch':'feature/test'}
        result=self.app.dispatch('head',args);self.assertEqual(result['sha'],'a'*40)
        self.assertTrue(self.app.dispatch('head',{**args,'etag':result['etag']})['notModified'])
        self.assertIn('feature%2Ftest',requests[0][0]);self.assertEqual(requests[0][1]['Accept'],'application/vnd.github.sha')
        self.assertEqual(requests[1][1]['If-None-Match'],'"version-one"')
        self.assertEqual([c[3] for c in self.calls if c[0]=='POST'][-1]['repository_ids'],[7])
        self.assertFalse(any(c[1].startswith('/installation/repositories') for c in self.calls))
    def test_token_is_reused_then_refreshed_before_expiry(self):
        first=self.app.token(7);self.assertEqual(self.app.token(7),first)
        self.app.tokens['7']['expires']=self.now+250
        self.assertNotEqual(self.app.token(7),first)
    def test_401_listing_refreshes_token_once(self):
        failed=[False]
        def api(method,path,bearer,body=None):
            if path.startswith('/installation/repositories') and not failed[0]:failed[0]=True;raise g.GitHubError(401)
            return self.request(method,path,bearer,body)
        self.app.request=api;self.assertEqual(len(self.app.repositories()),1)
        self.assertEqual(len([c for c in self.calls if c[0]=='POST']),2)
    def test_disconnect_revokes_and_blocks_future_tokens(self):
        self.app.token();self.app.token(7);self.app.disconnect()
        self.assertEqual(len([c for c in self.calls if c[0]=='DELETE']),2)
        with self.assertRaises(ValueError):self.app.token(7)
        self.assertFalse(self.app.tokens)
    def test_key_rotation_invalidates_cached_tokens(self):
        old=self.app.token(7);self.key.write_text('REPLACED KEY')
        self.assertNotEqual(self.app.token(7),old)
        self.assertTrue(any(c[0]=='DELETE' for c in self.calls))
    def test_arbitrary_key_path_and_unknown_configuration_rejected(self):
        for body in ({'pemPath':'/etc/shadow'},{'privateKey':'secret'}):
            with self.assertRaises(ValueError):self.app.configure({'appId':'123','installationId':'456',**body})
    def test_http_errors_do_not_disclose_github_error_body(self):
        for code in (401,403,404,429):
            error=urllib.error.HTTPError('https://api.github.com',code,'token=SECRET',{'Retry-After':'60'},io.BytesIO(b'PRIVATE KEY CONTENT'))
            with patch.object(g.urllib.request,'build_opener',return_value=Mock(open=Mock(side_effect=error))):
                with self.assertRaises(g.GitHubError) as caught:g.http_request('GET','/installation/repositories','SECRET')
            self.assertEqual(caught.exception.status,code);self.assertNotIn('SECRET',str(caught.exception))
    def test_credentials_are_bound_to_exact_host_and_repository(self):
        expected='https://github.com/owner/repo.git'
        self.assertEqual(answer("Username for 'https://github.com/owner/repo.git': ",expected,'SECRET'),'x-access-token')
        self.assertEqual(answer("Password for 'https://x-access-token@github.com/owner/repo.git': ",expected,'SECRET'),'SECRET')
        for url in ('https://evil.test/owner/repo.git','https://github.com/owner/other.git','https://github.com:444/owner/repo.git','http://github.com/owner/repo.git'):
            self.assertEqual(answer("Password for '"+url+"': ",expected,'SECRET'),'')
    def test_app_token_is_in_stdin_only_not_arguments_or_environment(self):
        p={'root':'/srv/ubuntu-projects/example','repo':'https://github.com/owner/repo.git','branch':'main','auth':'github-app','github_repository_id':7}
        with patch.object(h,'github_broker',return_value={'repository':{'clone_url':p['repo']},'token':'SECRET'}),patch.object(h,'run',return_value='{}') as run:
            h.project_run({},p,['clone',p['repo'],'main'])
        self.assertNotIn('SECRET',str(run.call_args.args));self.assertIn('SECRET',run.call_args.kwargs['input_text'])
    def test_deploy_key_projects_do_not_call_github_broker(self):
        with patch.object(h,'github_broker') as broker,patch.object(h,'run',return_value='{}') as run:
            h.project_run({}, {'root':'/srv/ubuntu-projects/old','repo':'git@github.com:owner/repo.git','branch':'main'}, ['preview'])
            broker.assert_not_called();self.assertIsNone(run.call_args.kwargs['input_text'])
    def test_git_environment_and_arguments_never_contain_token(self):
        runner.GITHUB_TOKEN='SECRET'
        self.addCleanup(setattr,runner,'GITHUB_TOKEN',None)
        with patch.dict(os.environ,{'UC_EXPECTED_REPO':'https://github.com/owner/repo.git'}),patch.object(runner,'credentials') as context,patch.object(runner.subprocess,'run',return_value=types.SimpleNamespace(returncode=0,stdout='ok')) as run:
            context.return_value.__enter__.return_value={'GIT_ASKPASS':'/fixed/askpass','UC_GIT_CREDENTIAL_SOCKET':'/tmp/test.sock'}
            runner.network_command(pathlib.Path('.'),['/usr/bin/git','fetch','origin'])
            self.assertNotIn('SECRET',str(run.call_args));self.assertIn('credential.helper=',run.call_args.args[0]);self.assertIn('http.followRedirects=false',run.call_args.args[0])

if __name__=='__main__':unittest.main()
