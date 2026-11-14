import unittest, importlib.util, pathlib, tempfile, json
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('runner',pathlib.Path(__file__).resolve().parents[1]/'helper/project_runner.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)

class RunnerTests(unittest.TestCase):
    def test_repositories_must_not_include_credentials_or_custom_transports(self):
        for repo in ('https://user:token@github.com/a/b','ext::evil','file:///etc','https://evil.test/a/b','git@github.com:a/b;reboot'):
            with self.assertRaises(ValueError):r.repository(repo)
        self.assertEqual(r.repository('git@github.com:org/repo.git'),'git@github.com:org/repo.git')
    def test_dirty_worktree_stops_deployment_before_fetch_or_build(self):
        with tempfile.TemporaryDirectory() as d,patch.object(r,'status',return_value={'dirty':True}),patch.object(r,'git') as git:
            with self.assertRaises(ValueError):r.execute(pathlib.Path(d),'deploy',['a'*40])
            git.assert_not_called()
    def test_changed_remote_requires_new_preview(self):
        with tempfile.TemporaryDirectory() as d,patch.object(r,'status',return_value={'dirty':False,'branch':'main'}),patch.object(r,'git',side_effect=['','b'*40]),patch.object(r,'command') as command:
            with self.assertRaises(ValueError):r.execute(pathlib.Path(d),'deploy',['a'*40])
            command.assert_not_called();self.assertFalse((pathlib.Path(d)/'current').exists())
    def test_qr_is_expiring_and_size_limited(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);f=root/'shared/whatsapp/qr.json';f.parent.mkdir(parents=True)
            f.write_text(json.dumps({'qr':'private','expires':0}))
            with self.assertRaises(ValueError):r.execute(root,'qr',[])
    def test_unknown_command_and_invalid_rollback_identifier(self):
        with tempfile.TemporaryDirectory() as d:
            for action,args in [('exec',['reboot']),('rollback',['../../etc/passwd'])]:
                with self.assertRaises(ValueError):r.execute(pathlib.Path(d),action,args)

if __name__=='__main__':unittest.main()
