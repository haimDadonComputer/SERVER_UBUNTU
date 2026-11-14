import importlib.util,pathlib,tempfile,unittest,sys,io,json
from unittest.mock import Mock,patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'helper'))
from diagnostics import OperationError

spec=importlib.util.spec_from_file_location('acceptance_runtime',pathlib.Path(__file__).resolve().parents[1]/'scripts/acceptance-runtime.py')
acceptance=importlib.util.module_from_spec(spec);spec.loader.exec_module(acceptance)

class AcceptancePreflightTests(unittest.TestCase):
    def test_old_installation_fails_before_imports_or_creating_resources(self):
        with tempfile.TemporaryDirectory() as base:
            directory=pathlib.Path(base);(directory/'helper.py').write_text('raise AssertionError("must not import old helper")')
            before=list(directory.iterdir())
            with self.assertRaises(SystemExit) as error:acceptance.installed_helper_directory(directory)
            self.assertIn('project_lifecycle.py',str(error.exception));self.assertIn('Upgrade complete',str(error.exception));self.assertEqual(list(directory.iterdir()),before)

    def test_complete_installation_passes_without_importing_checkout_code(self):
        with tempfile.TemporaryDirectory() as base:
            directory=pathlib.Path(base)
            for name in acceptance.REQUIRED_HELPER_FILES:(directory/name).write_text('raise AssertionError("preflight must not execute modules")')
            self.assertEqual(acceptance.installed_helper_directory(directory),directory)
    def test_failure_report_keeps_command_stderr_and_redacts_known_secrets(self):
        with tempfile.TemporaryDirectory() as base:
            error=OperationError('failed opaque-value',{'command':['systemctl','restart','test.service'],'stderr':'invalid path opaque-value','code':'COMMAND_FAILED'})
            output=io.StringIO()
            with patch.object(acceptance.sys,'stderr',output):acceptance.report_failure(error,'initial-start',pathlib.Path(base),'uc-accept-1234567890',('opaque-value',))
            report=json.loads((pathlib.Path(base)/'acceptance-initial-start-failure.json').read_text())
            self.assertEqual(report['details']['command'][0],'systemctl');self.assertIn('invalid path',report['details']['stderr']);self.assertNotIn('opaque-value',output.getvalue());self.assertNotIn('opaque-value',json.dumps(report))
    def test_pending_recovery_skips_archive_and_preserves_resources(self):
        life=Mock();life.transaction_path.return_value.exists.return_value=True
        with self.assertRaisesRegex(RuntimeError,'Recovery is pending'):acceptance.cleanup_test(life,'uc-accept-1234567890')
        life.archive.assert_not_called();life.purge.assert_not_called()
    def test_cleanup_rejects_paths_outside_private_acceptance_scope(self):
        for name in ('../projects','/var/lib/ubuntu-control-helper','acceptance-../x','normal-project'):
            with self.assertRaises(ValueError):acceptance.cleanup_state(name,Mock(),Mock())

if __name__=='__main__':unittest.main()
