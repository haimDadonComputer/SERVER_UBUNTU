import importlib.util,pathlib,tempfile,unittest

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

if __name__=='__main__':unittest.main()
