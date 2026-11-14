import sys,pathlib,unittest,json,subprocess,tempfile,types
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'helper'))
import diagnostics as d
import helper as h
import project_runner as r

class DiagnosticTests(unittest.TestCase):
    def test_sensitive_material_is_removed_before_output_truncation(self):
        text='ghs_123.jwt.payload Bearer abcdef password="two word secret" https://user:pass@github.com/a/b opaque-credential\n-----BEGIN RSA PRIVATE KEY-----\nKEY CONTENT\n-----END RSA PRIVATE KEY-----'
        result=d.redact(text,('opaque-credential',))
        for value in ('ghs_123','abcdef','two word secret','user:pass','opaque-credential','KEY CONTENT'):self.assertNotIn(value,result)
        details=d.clean({'stderr':'x'*20000+text,'token':'NEVER-RETURN','unknown':'private'},('opaque-credential',))
        self.assertLessEqual(len(details['stderr']),12000);self.assertNotIn('token',details);self.assertNotIn('unknown',details)
    def test_git_failure_keeps_stage_command_exit_and_sanitized_output(self):
        r.GITHUB_TOKEN='opaque-credential';self.addCleanup(setattr,r,'GITHUB_TOKEN',None)
        with patch.dict(r.os.environ,{'UC_EXPECTED_REPO':'https://github.com/owner/repo.git'}),patch.object(r,'credentials') as context,patch.object(r.subprocess,'run',return_value=types.SimpleNamespace(returncode=128,stdout='',stderr='fatal: Authentication failed password="two word secret" opaque-credential')):
            context.return_value.__enter__.return_value={}
            with self.assertRaises(d.OperationError) as caught:r.network_command(pathlib.Path('/project'),['/usr/bin/git','clone','--branch','main','--','https://github.com/owner/repo.git','.'])
        details=caught.exception.details
        self.assertEqual(details['code'],'GIT_AUTH_FAILED');self.assertEqual(details['stage'],'git-clone');self.assertEqual(details['exitCode'],128)
        self.assertIn('clone',details['command']);self.assertNotIn('two word secret',json.dumps(details));self.assertNotIn('opaque-credential',json.dumps(details))
    def test_runner_protocol_survives_runuser_and_keeps_original_failure(self):
        error=d.failure(['/usr/bin/git','clone'],'/srv/project','git-clone',returncode=128,stderr='fatal: Authentication failed opaque-credential',secrets=('opaque-credential',))
        output='PAM warning\n'+d.serialize(error,'clone','/srv/project')+'\n'
        with patch.object(h.subprocess,'run',return_value=types.SimpleNamespace(returncode=1,stdout='',stderr=output)):
            with self.assertRaises(d.OperationError) as caught:h.run(['/usr/sbin/runuser','-u','ubuntu-projects'],input_text=json.dumps({'token':'opaque-credential'}))
        self.assertEqual(caught.exception.details['exitCode'],128);self.assertEqual(caught.exception.details['launcher']['exitCode'],1)
        self.assertNotIn('opaque-credential',json.dumps(caught.exception.details))
    def test_launch_failure_has_diagnostic_instead_of_generic_runuser(self):
        with patch.object(h.subprocess,'run',return_value=types.SimpleNamespace(returncode=1,stdout='',stderr='runuser: cannot set groups: Operation not permitted')):
            with self.assertRaises(d.OperationError) as caught:h.run(['/usr/sbin/runuser'])
        self.assertEqual(caught.exception.details['code'],'RUNUSER_IDENTITY');self.assertIn('cannot set groups',caught.exception.details['stderr'])
    def test_timeout_and_missing_executable_are_detailed(self):
        for error,expected in ((FileNotFoundError('No such file: git'),'EXECUTION_PATH'),(subprocess.TimeoutExpired(['/usr/bin/git'],25,stderr=b'network waiting'),'COMMAND_TIMEOUT')):
            with patch.object(h.subprocess,'run',side_effect=error):
                with self.assertRaises(d.OperationError) as caught:h.run(['/usr/bin/git'])
            self.assertEqual(caught.exception.details['code'],expected)
    def test_untrusted_protocol_fields_and_secrets_are_not_forwarded(self):
        text=d.PREFIX+json.dumps({'message':'failure opaque-credential','details':{'code':'X','stderr':'opaque-credential','privateKey':'DO NOT RETURN','token':'DO NOT RETURN'}})
        error=d.decode(text,('opaque-credential',))
        self.assertNotIn('opaque-credential',str(error));self.assertNotIn('DO NOT RETURN',json.dumps(error.details))

if __name__=='__main__':unittest.main()
