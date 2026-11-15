import unittest, importlib.util, pathlib, tempfile, json,sys
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'helper'))
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
        with tempfile.TemporaryDirectory() as d,patch.object(r,'status',return_value={'dirty':False,'branch':'main'}),patch.object(r,'fetch'),patch.object(r,'git',return_value='b'*40),patch.object(r,'command') as command:
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
    def test_pull_keeps_backup_ref_and_only_fast_forwards(self):
        states=[{'dirty':False,'branch':'main','commit':'a'*40},{'dirty':False,'branch':'main','commit':'b'*40}]
        with tempfile.TemporaryDirectory() as d,patch.object(r,'status',side_effect=states),patch.object(r,'fetch') as fetch,patch.object(r,'git') as git:
            result=r.execute(pathlib.Path(d),'pull',[])
            fetch.assert_called_once_with(pathlib.Path(d),'origin')
            self.assertEqual(git.call_args_list[0].args[1],'branch')
            self.assertEqual(git.call_args_list[1].args[1:],('merge','--ff-only','refs/remotes/origin/main'))
            self.assertTrue(result['codeOnly'])
    def test_dirty_pull_does_not_fetch_or_modify_files(self):
        with tempfile.TemporaryDirectory() as d,patch.object(r,'status',return_value={'dirty':True}),patch.object(r,'fetch') as fetch:
            with self.assertRaises(ValueError):r.execute(pathlib.Path(d),'pull',[])
            fetch.assert_not_called()
    def test_missing_lockfile_has_actionable_diagnostic_without_installing(self):
        with tempfile.TemporaryDirectory() as d,patch.object(r,'BUILD_CONFIG',{'kind':'node'}),patch.object(r,'command') as command:
            root=pathlib.Path(d);(root/'package.json').write_text('{"scripts":{}}')
            with self.assertRaises(r.OperationError) as error:r.build_target(root,root)
            self.assertEqual(error.exception.details['code'],'NPM_LOCKFILE_MISSING');command.assert_not_called()
    def test_explicit_install_fallback_only_changes_release_and_locked_projects_keep_ci(self):
        with tempfile.TemporaryDirectory() as d,patch.object(r,'BUILD_CONFIG',{'kind':'node','dependencyInstall':'allow-install'}),patch.object(r,'command') as command:
            root=pathlib.Path(d);target=root/'release';target.mkdir();(target/'package.json').write_text('{"scripts":{}}')
            r.build_target(root,target);self.assertEqual(command.call_args.args[:2],(target,['/usr/bin/env','npm','install']));self.assertFalse((root/'package-lock.json').exists())
            (target/'npm-shrinkwrap.json').write_text('{}');r.build_target(root,target);self.assertEqual(command.call_args.args[1],['/usr/bin/env','npm','ci'])
    def test_install_policy_uses_install_even_with_a_lockfile(self):
        with tempfile.TemporaryDirectory() as d,patch.object(r,'BUILD_CONFIG',{'kind':'node','dependencyInstall':'install'}),patch.object(r,'command') as command:
            root=pathlib.Path(d);(root/'package.json').write_text('{"scripts":{}}');(root/'package-lock.json').write_text('{}')
            r.build_target(root,root);self.assertEqual(command.call_args.args[1],['/usr/bin/env','npm','install'])

if __name__=='__main__':unittest.main()
