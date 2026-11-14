import unittest, importlib.util, pathlib, tempfile, copy
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('helper',pathlib.Path(__file__).resolve().parents[1]/'helper/helper.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)

class ProjectTests(unittest.TestCase):
    def setUp(self):
        # Fail on every platform if a fixture accidentally probes live helper
        # state. Python 3.14 exists() can suppress permission errors that 3.12
        # reports on the real, root-only Ubuntu installation.
        original_stat=pathlib.Path.stat
        def isolated_stat(path,*args,**kwargs):
            if '/var/lib/ubuntu-control-helper' in path.as_posix():raise AssertionError('Tests must use an isolated state_dir')
            return original_stat(path,*args,**kwargs)
        guard=patch.object(pathlib.Path,'stat',isolated_stat);guard.start();self.addCleanup(guard.stop)

    def test_folder_names_cannot_escape_project_base(self):
        for value in ('../etc','/etc','a/b','a\\b','.env','a;reboot',None,'a'*42):
            with self.assertRaises(ValueError): h.project_identifier(value)
        self.assertEqual(h.project_identifier('my-project-2'),'my-project-2')

    def test_create_multiple_projects_without_manual_config_and_reload(self):
        with tempfile.TemporaryDirectory() as base:
            cfg={'project_root':base,'state_dir':str(pathlib.Path(base)/'state')}
            registry={}
            def save(config,value): registry.clear();registry.update(copy.deepcopy(value))
            with patch.object(h,'read_project_registry',side_effect=lambda config:copy.deepcopy(registry)),patch.object(h,'write_project_registry',side_effect=save),patch.object(h,'make_project_directory',side_effect=lambda config,name:str(pathlib.Path(base)/name)) as mkdir:
                first=h.dispatch(cfg,'project-create',{'id':'project-one'})
                second=h.dispatch(cfg,'project-create',{'id':'project-two','repo':'https://github.com/org/repo.git'})
                self.assertNotEqual(first['root'],second['root']);self.assertEqual(mkdir.call_count,2)
                self.assertEqual(h.project(dict(cfg),'project-two')['repo'],'https://github.com/org/repo.git')
                self.assertEqual(len(h.dispatch(dict(cfg),'project-authorized',{})),2)
                self.assertEqual(h.create_project(cfg,{'id':'project-one'}),first)
                self.assertEqual(mkdir.call_count,2)

    def test_existing_static_projects_keep_their_configuration(self):
        with tempfile.TemporaryDirectory() as base:
            record={'root':str(pathlib.Path(base)/'old-project'),'service':'original','branch':'stable'}
            cfg={'project_root':base,'state_dir':str(pathlib.Path(base)/'state'),'projects':{'old-project':record}}
            with patch.object(h,'read_project_registry',return_value={}),patch.object(h,'make_project_directory') as mkdir:
                self.assertEqual(h.create_project(cfg,{'id':'old-project','service':'other'}),record)
                mkdir.assert_not_called()

    def test_invalid_settings_fail_before_creating_a_directory(self):
        with tempfile.TemporaryDirectory() as base,patch.object(h,'read_project_registry',return_value={}),patch.object(h,'make_project_directory') as mkdir:
            cfg={'state_dir':str(pathlib.Path(base)/'state')}
            for change in ({'repo':'https://token@github.com/a/b'},{'branch':'../main'},{'service':'ssh'},{'health_port':22},{'kind':'shell'}):
                with self.assertRaises(ValueError):h.create_project(cfg, {'id':'my-app',**change})
            mkdir.assert_not_called()

    def test_pending_recovery_blocks_creation_without_accessing_live_state(self):
        with tempfile.TemporaryDirectory() as base:
            state=pathlib.Path(base)/'state';pending=state/'runtime-transactions/my-app.json';pending.parent.mkdir(parents=True);pending.write_text('{}')
            with patch.object(h,'make_project_directory') as mkdir:
                with self.assertRaisesRegex(ValueError,'recovery is pending'):h.create_project({'state_dir':str(state)},{'id':'my-app'})
                mkdir.assert_not_called()

    def test_registry_root_outside_base_is_rejected(self):
        with tempfile.TemporaryDirectory() as base:
            cfg={'project_root':str(pathlib.Path(base)/'projects'),'state_dir':str(pathlib.Path(base)/'state')}
            with patch.object(h,'read_project_registry',return_value={'my-app':{'root':base}}):
                with self.assertRaises(ValueError):h.project(cfg,'my-app')

if __name__=='__main__':unittest.main()
