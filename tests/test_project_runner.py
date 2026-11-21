import unittest, importlib.util, pathlib, tempfile, json,sys,shutil,subprocess
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

class StartupBuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=pathlib.Path(self.tmp.name);self.target=self.root/'.control-releases'/'123-aaaaaaaaaa';self.target.mkdir(parents=True)
        self.config={'kind':'node','mode':'npm','script':'start','dependencyInstall':'install','state_dir':str(self.root/'state')}
        self.config_patch=patch.object(r,'BUILD_CONFIG',self.config);self.config_patch.start();self.addCleanup(self.config_patch.stop)
    def package(self,scripts):
        text=json.dumps({'scripts':scripts,'type':'module','ubuntuControl':{'storageDirectories':['uploads']}})
        (self.root/'package.json').write_text(text);(self.target/'package.json').write_text(text)
        return text
    def test_reported_typescript_start_builds_once_and_only_release_is_changed(self):
        original=self.package({'start':'npm run build && node dist/index.js','build':'tsc','test':'must not run'})
        self.config['buildScript']='build'
        def command(target,argv,timeout):
            if argv[-1]=='build':
                (target/'dist').mkdir();(target/'dist/index.js').write_text('console.log("ready")')
        with patch.object(r,'command',side_effect=command) as run:r.build_target(self.root,self.target)
        self.assertEqual([call.args[1] for call in run.call_args_list],[['/usr/bin/env','npm','install'],['/usr/bin/env','npm','run','build']])
        self.assertTrue((self.target/'dist/index.js').is_file())
        prepared=json.loads((self.target/'package.json').read_text())
        self.assertEqual(prepared['scripts']['start'],'node dist/index.js')
        self.assertEqual(prepared['ubuntuControl'],{'storageDirectories':['uploads']})
        self.assertEqual((self.root/'package.json').read_text(),original)
    def test_infers_build_without_explicit_build_setting_and_preserves_runtime_arguments(self):
        self.package({'start':'npm run build && node "dist/my server.js" --name "$NAME"','build':'tsc'})
        with patch.object(r,'command') as run:r.build_target(self.root,self.target)
        self.assertEqual(run.call_args_list[-1].args[1],['/usr/bin/env','npm','run','build'])
        self.assertEqual(json.loads((self.target/'package.json').read_text())['scripts']['start'],'node "dist/my server.js" --name "$NAME"')
    def test_prestart_build_moves_but_other_hooks_remain(self):
        self.package({'start':'node dist/index.js','prestart':'npm run build','poststart':'node notify.js','build':'tsc'})
        with patch.object(r,'command'):r.build_target(self.root,self.target)
        scripts=json.loads((self.target/'package.json').read_text())['scripts']
        self.assertNotIn('prestart',scripts);self.assertEqual(scripts['poststart'],'node notify.js')
    def test_selected_script_and_build_prefix_order(self):
        self.config['script']='serve'
        self.package({'serve':'npm run build:server && node dist/index.js','preserve':'npm run build:assets && node prepare.js','build:server':'tsc','build:assets':'node assets.js','start':'unchanged'})
        with patch.object(r,'command') as run:r.build_target(self.root,self.target)
        self.assertEqual([call.args[1][-1] for call in run.call_args_list],['install','build:assets','build:server'])
        scripts=json.loads((self.target/'package.json').read_text())['scripts']
        self.assertEqual(scripts['preserve'],'node prepare.js');self.assertEqual(scripts['serve'],'node dist/index.js');self.assertEqual(scripts['start'],'unchanged')
    def test_failed_build_does_not_prepare_startup(self):
        original=self.package({'start':'npm run build && node dist/index.js','build':'tsc'})
        with patch.object(r,'command',side_effect=[None,ValueError('build failed')]):
            with self.assertRaises(ValueError):r.build_target(self.root,self.target)
        self.assertEqual((self.target/'package.json').read_text(),original)
    def test_real_npm_start_does_not_repeat_the_build(self):
        node=shutil.which('node');npm=shutil.which('npm')
        if not node or not npm:self.skipTest('Node/npm unavailable')
        npm_path=pathlib.Path(npm).resolve()
        candidates=[npm_path.parent/'node_modules/npm/bin/npm-cli.js',npm_path.parent.parent/'lib/node_modules/npm/bin/npm-cli.js',npm_path]
        cli=next((path for path in candidates if path.is_file() and path.suffix=='.js'),None)
        if cli is None:self.skipTest('npm JavaScript CLI unavailable')
        self.package({'start':'npm run build && node dist/index.cjs','prestart':'npm run build','build':'node build.cjs'})
        (self.target/'build.cjs').write_text('const fs=require("node:fs"); if(fs.existsSync("dist")) throw Error("Build ran during startup"); fs.mkdirSync("dist"); fs.writeFileSync("dist/index.cjs", '+json.dumps('console.log("ready")')+');')
        def command(target,argv,timeout):
            result=subprocess.run([node,str(cli),*argv[2:]],cwd=target,capture_output=True,text=True,timeout=timeout)
            self.assertEqual(result.returncode,0,result.stderr)
            return result.stdout
        with patch.object(r,'command',side_effect=command):r.build_target(self.root,self.target)
        # The build fails on any second invocation, including npm prestart.
        result=subprocess.run([node,str(cli),'run','start'],cwd=self.target,capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stderr);self.assertIn('ready',result.stdout)
        self.assertFalse((self.root/'package-lock.json').exists())
    def test_unrecognized_commands_and_non_npm_runtimes_are_preserved(self):
        for start in ('npm run build || node dist/index.js','npm run build -- --watch && node dist/index.js','npm run missing && node dist/index.js','npm run start && node dist/index.js','npm run build','tsc && node dist/index.js'):
            with self.subTest(start=start):
                original=self.package({'start':start,'build':'tsc'})
                with patch.object(r,'command') as run:r.build_target(self.root,self.target)
                self.assertEqual(run.call_count,1);self.assertEqual((self.target/'package.json').read_text(),original)
        for runtime in ({'kind':'docker'},{'kind':'node','mode':'entry'}):
            with patch.object(r,'BUILD_CONFIG',{**runtime,'state_dir':str(self.root/'state')}):self.assertEqual(r.startup_builds({'scripts':{'start':'npm run build && node dist/index.js','build':'tsc'}}),([],{}))

if __name__=='__main__':unittest.main()
