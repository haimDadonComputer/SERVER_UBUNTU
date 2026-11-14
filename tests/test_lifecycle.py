import copy,json,pathlib,queue,sys,tempfile,unittest,os,shutil,subprocess
from unittest.mock import Mock,patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'helper'))
from project_lifecycle import Lifecycle,validate_runtime,project_lock,dispatch_lifecycle,recover_transactions,rehydrate
from project_secrets import patch_values,read_values
from project_logs import Follower,journal_record,valid_cursor
from diagnostics import OperationError
import project_runner as runner
import helper as helper_backend

class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.base=pathlib.Path(self.tmp.name);self.root=self.base/'projects'/'demo';self.root.mkdir(parents=True)
        self.cfg={'project_root':str(self.root.parent),'env_dir':str(self.base/'env'),'state_dir':str(self.base/'state'),'unit_dir':str(self.base/'units')}
        self.registry={'demo':{'root':str(self.root),'kind':'node','repo':'https://github.com/owner/repo.git','branch':'main'}}
        self.run=Mock(return_value='ActiveState=inactive\nMainPID=0\nNRestarts=0')
        self.runner=Mock(return_value=json.dumps({'scripts':['start','build'],'entries':['index.mjs'],'dockerfile':True,'git':True}))
        def write(cfg,value):self.registry=copy.deepcopy(value)
        def identifier(value):
            if not isinstance(value,str) or not __import__('re').fullmatch('[a-z][a-z0-9-]{1,40}',value):raise ValueError('Invalid ID')
            return value
        self.backend={'all_projects':lambda _:copy.deepcopy(self.registry),'read_project_registry':lambda _:copy.deepcopy(self.registry),'write_project_registry':write,'project_identifier':identifier,'run':self.run,'project_run':self.runner,'service':lambda _,id:{'name':'external.service','kind':'systemd'},'service_action':Mock(),'ENV':{}}
        self.life=Lifecycle(self.cfg,self.backend)
        self.runtime={'kind':'node','mode':'npm','script':'start','args':[],'health':'http','port':3000,'healthPath':'/','autostart':False}
    def managed(self):
        self.life.configure('demo',{'runtime':self.runtime});return self.registry['demo']
    def test_runtime_requires_typed_existing_entry_and_scripts(self):
        options={'scripts':['start'],'entries':['index.mjs'],'dockerfile':True}
        for update in ({'script':'start;sudo reboot'},{'args':'npm start'},{'args':['x\nreboot']},{'entry':'../../etc/shadow','mode':'entry'},{'healthPath':'//evil.test'},{'port':22}):
            with self.assertRaises(ValueError):validate_runtime({**self.runtime,**update},options)
        self.assertEqual(validate_runtime({**self.runtime,'args':['--name','a b']},options)['args'],['--name','a b'])
    def test_env_patch_returns_names_only_blank_preserves_and_delete_is_explicit(self):
        self.managed();self.life.environment('demo',{'set':{'API_KEY':'private-random-value','PUBLIC_URL':'https://example.test'},'publicBuild':['PUBLIC_URL']})
        result=self.life.environment('demo',{'set':{'API_KEY':''},'unset':[]})
        self.assertEqual(read_values(self.life.env_path('demo'))['API_KEY'],'private-random-value')
        self.assertNotIn('private-random-value',json.dumps(result));self.assertEqual(self.life.metadata_values(self.registry['demo']),{'PUBLIC_URL':'https://example.test'})
        self.assertEqual(self.life.redact('demo','bare private-random-value'),'bare [REDACTED]')
        self.life.environment('demo',{'set':{},'unset':['API_KEY']});self.assertNotIn('API_KEY',self.life.metadata('demo')['keys'])
        self.life.environment('demo',{'unset':['PUBLIC_URL']});self.assertEqual(self.life.metadata('demo')['publicBuild'],[])
    def test_invalid_env_never_replaces_saved_values(self):
        file=self.base/'env'/'demo.env';patch_values(file,{'API_KEY':'original'})
        for updates in ({'LD_PRELOAD':'/tmp/x'},{'HOME':'/root'},{'API_KEY':'a\nb'},{'BAD-NAME':'v'}):
            with self.assertRaises(ValueError):patch_values(file,updates)
            self.assertEqual(read_values(file),{'API_KEY':'original'})
        with self.assertRaises(ValueError):patch_values(file,{},public=['MISSING'])
    def test_legacy_project_identifier_may_differ_from_directory_name(self):
        self.registry['alias']=self.registry.pop('demo');self.life.configure('alias',{'runtime':self.runtime})
        self.life.environment('alias',{'set':{'PUBLIC_URL':'public-value'},'publicBuild':['PUBLIC_URL']})
        self.assertEqual(self.life.metadata_values(self.registry['alias']),{'PUBLIC_URL':'public-value'})
    def test_units_keep_values_outside_configuration_and_use_private_identity(self):
        p=self.managed();self.life.environment('demo',{'set':{'API_KEY':'private-random-value'}})
        unit=self.life.unit_text('demo',p)
        for required in ('DynamicUser=true','LoadCredential=environment:','ProtectSystem=strict','StateDirectory=','ReadOnlyPaths=','SupplementaryGroups=ubuntu-projects'):self.assertIn(required,unit)
        self.assertNotIn('Environment=',unit);self.assertNotIn('private-random-value',unit);self.assertNotIn('User=root',unit)
        self.assertIn('WorkingDirectory='+str(self.root/'current')+'\n',unit)
        self.assertNotIn('WorkingDirectory="',unit)
    def test_unit_scalar_paths_preserve_spaces_and_escape_specifiers(self):
        p=self.managed();p['root']='/srv/project 100% code'
        text=self.life.unit_text('demo',p)
        self.assertIn('WorkingDirectory='+str(pathlib.Path(p['root'])/'current').replace('%','%%')+'\n',text)
        self.assertIn('ReadOnlyPaths="/srv/project 100%% code"',text)
    @unittest.skipUnless(sys.platform=='linux' and shutil.which('systemd-analyze'),'Real systemd parser requires Linux')
    def test_generated_unit_passes_actual_systemd_parser(self):
        p=self.managed();directory=self.base/'verify';directory.mkdir()
        unit=directory/self.life.names('demo')['unit']
        unit.write_text(self.life.unit_text('demo',p).replace('ExecStart=/usr/bin/python3 /opt/ubuntu-control/helper/runtime_launcher.py','ExecStart=/usr/bin/true'))
        (directory/'ubuntu-control-helper.service').write_text('[Service]\nExecStart=/usr/bin/true\n')
        env={**os.environ,'SYSTEMD_UNIT_PATH':str(directory)+':/usr/lib/systemd/system:/lib/systemd/system','SYSTEMD_LOG_COLOR':'0'}
        result=subprocess.run(['systemd-analyze','verify',str(unit)],capture_output=True,text=True,env=env,timeout=30)
        self.assertEqual(result.returncode,0,result.stderr)
    def test_invalid_first_unit_is_confirmed_inactive_without_hiding_original_failure(self):
        self.managed()
        def release(id,p,expected):p.update(preparedCommit='a'*40,release='1-aaaaaaaaaa');return {'release':p['release'],'commit':p['preparedCommit']}
        self.runner.return_value=json.dumps({'restored':False})
        def run(argv,**kwargs):
            if 'stop' in argv:raise OperationError('bad unit',{'stderr':'unit has bad setting'})
            return 'LoadState=bad-setting\nActiveState=inactive\n'
        self.run.side_effect=run
        with patch.object(self.life,'release',side_effect=release),patch.object(self.life,'provision',side_effect=OperationError('original failure',{'stderr':'WorkingDirectory path is not absolute'})):
            with self.assertRaises(OperationError) as error:self.life.deploy('demo',{})
        self.assertIn('WorkingDirectory',error.exception.details['stderr']);self.assertFalse(self.life.transaction_path('demo').exists())
    def test_failed_stop_of_an_active_first_unit_keeps_recovery_pending(self):
        self.managed()
        def release(id,p,expected):p.update(preparedCommit='a'*40,release='1-aaaaaaaaaa');return {'release':p['release'],'commit':p['preparedCommit']}
        self.runner.return_value=json.dumps({'restored':False})
        def run(argv,**kwargs):
            if 'stop' in argv:raise ValueError('stop failed')
            return 'LoadState=loaded\nActiveState=active\n'
        self.run.side_effect=run
        with patch.object(self.life,'release',side_effect=release),patch.object(self.life,'provision',side_effect=ValueError('original failure')):
            with self.assertRaises(OperationError):self.life.deploy('demo',{})
        self.assertTrue(self.life.transaction_path('demo').exists())
    def test_read_only_records_hide_credentials_and_internal_archive_paths(self):
        self.managed();self.registry['demo'].update(archive={'code':'SECRET-PATH'},publicBuild=['PUBLIC_URL'])
        self.assertNotIn('SECRET-PATH',json.dumps(dispatch_lifecycle(self.cfg,'project-records',{},self.backend)))
    def test_project_lock_rejects_duplicate_work(self):
        with project_lock('demo'):
            with self.assertRaises(OperationError):
                with project_lock('demo'):pass
    def test_firewall_changes_and_project_mutations_cannot_overlap(self):
        with project_lock('demo'),patch.object(helper_backend,'firewall_change') as change:
            with self.assertRaises(ValueError):helper_backend.dispatch(self.cfg,'firewall-change',{})
            change.assert_not_called()
        event=__import__('threading').Event();event.set();self.backend['FIREWALL_WORK']=event
        with self.assertRaises(ValueError):dispatch_lifecycle(self.cfg,'project-env-patch',{'project':'demo','set':{'API_KEY':'value'}},self.backend)
        self.assertFalse(self.life.env_path('demo').exists())
    def test_builds_are_scoped_transient_units_and_credentials_stay_in_stdin(self):
        unit='uc-build-'+'a'*16+'-source.service'
        with patch.object(helper_backend,'run',return_value='{}') as run:
            helper_backend.build_run(unit,'ubuntu-projects','ubuntu-projects',['/usr/bin/python3','runner.py'],1200,input_text='private-stdin-value')
            argv=run.call_args.args[0]
            for value in ('--pipe','--wait','--collect','--property=KillMode=control-group','--property=User=ubuntu-projects','--property=RuntimeMaxSec=1200'):self.assertIn(value,argv)
            self.assertNotIn('private-stdin-value',' '.join(argv));self.assertEqual(run.call_args.kwargs['input_text'],'private-stdin-value')
            with self.assertRaises(ValueError):helper_backend.build_run('arbitrary.service','root','root',[],1)
    def test_stopped_update_prepares_without_start_and_does_not_modify_env(self):
        self.managed();self.life.environment('demo',{'set':{'API_KEY':'keep'}})
        def release(id,p,expected):p.update(preparedCommit='a'*40,release='1-aaaaaaaaaa');return {'release':p['release'],'commit':p['preparedCommit']}
        with patch.object(self.life,'release',side_effect=release),patch.object(self.life,'provision'),patch.object(self.life,'health') as health:
            result=self.life.deploy('demo',{'expected':'a'*40})
        self.assertEqual(result['deployment'],'prepared-stopped');health.assert_not_called();self.run.assert_not_called()
        self.assertEqual(read_values(self.life.env_path('demo'))['API_KEY'],'keep')
    def test_health_failure_restores_previous_release_and_checks_recovery(self):
        self.managed();self.registry['demo'].update(desired='running',release='1-bbbbbbbbbb',preparedCommit='b'*40,activeCommit='b'*40)
        def release(id,p,expected):p.update(preparedCommit='a'*40,release='2-aaaaaaaaaa');return {'release':p['release'],'commit':p['preparedCommit']}
        self.runner.return_value=json.dumps({'restored':True,'release':'1-bbbbbbbbbb','commit':'b'*40})
        with patch.object(self.life,'release',side_effect=release),patch.object(self.life,'provision'),patch.object(self.life,'health',side_effect=[ValueError('health failed'),None]) as health:
            with self.assertRaises(OperationError):self.life.deploy('demo',{'expected':'a'*40})
        self.assertEqual(health.call_count,2);self.assertEqual(self.registry['demo']['activeCommit'],'b'*40);self.assertEqual(self.registry['demo']['failedCommit'],'a'*40)
        self.assertEqual(self.registry['demo']['deployment'],'failed-rolled-back')
    def test_build_failure_keeps_running_version(self):
        self.managed();self.registry['demo'].update(desired='running',release='1-bbbbbbbbbb',activeCommit='b'*40)
        with patch.object(self.life,'release',side_effect=ValueError('build failed')),patch.object(self.life,'provision') as provision:
            with self.assertRaises(OperationError):self.life.deploy('demo',{'expected':'a'*40})
        provision.assert_not_called();self.assertEqual(self.registry['demo']['release'],'1-bbbbbbbbbb')
    def test_restart_recovers_an_interrupted_deployment_from_root_journal(self):
        self.managed();self.registry['demo'].update(desired='running',release='1-bbbbbbbbbb',activeCommit='b'*40)
        self.life.begin('demo',self.registry['demo'],'deploy',expected='a'*40)
        with patch.object(Lifecycle,'provision'),patch.object(Lifecycle,'health') as health:recover_transactions(self.cfg,self.backend)
        self.assertEqual(self.registry['demo']['deployment'],'interrupted-rolled-back');self.assertEqual(self.registry['demo']['failedCommit'],'a'*40)
        self.assertFalse(self.life.transaction_path('demo').exists());health.assert_called_once();self.assertIn('select-release',self.runner.call_args.args[2])
    def test_committed_journal_is_cleaned_without_restarting_a_healthy_app(self):
        self.managed();self.life.begin('demo',self.registry['demo'],'deploy');self.registry['demo']['operationId']=self.life.transaction
        with patch.object(Lifecycle,'provision') as provision:recover_transactions(self.cfg,self.backend)
        provision.assert_not_called();self.assertFalse(self.life.transaction_path('demo').exists())
    def test_pending_recovery_blocks_new_mutations_but_records_remain_readable(self):
        self.managed();self.life.begin('demo',self.registry['demo'],'deploy')
        with self.assertRaises(OperationError):dispatch_lifecycle(self.cfg,'project-stop',{'project':'demo'},self.backend)
        self.assertTrue(dispatch_lifecycle(self.cfg,'project-records',{},self.backend)[0]['recoveryPending'])
    def test_process_health_requires_full_twenty_second_stability(self):
        p=self.managed();p['runtime']['health']='process'
        with patch.object(self.life,'state',return_value={'active':'active','restarts':'0'}),patch('project_lifecycle.time.monotonic',side_effect=[0,10,20]),patch('project_lifecycle.time.sleep') as sleep:
            self.life.health('demo',p)
        sleep.assert_called_once_with(1)
        with patch.object(self.life,'state',side_effect=[{'active':'active','restarts':'0'},{'active':'active','restarts':'1'}]):
            with self.assertRaises(ValueError):self.life.health('demo',p)
    def test_http_success_from_an_unrelated_process_is_not_healthy(self):
        p=self.managed();response=Mock();response.__enter__=Mock(return_value=Mock(status=200));response.__exit__=Mock(return_value=False)
        with patch.object(self.life,'state',return_value={'active':'active','restarts':'0'}),patch.object(self.life,'http_owned',return_value=False),patch('project_lifecycle.urllib.request.build_opener',return_value=Mock(open=Mock(return_value=response))),patch('project_lifecycle.time.monotonic',side_effect=[0,46]):
            with self.assertRaises(ValueError):self.life.health('demo',p)
    def test_rehydration_preserves_stopped_state_on_restart_and_obeys_boot_setting(self):
        self.managed();self.registry['demo'].update(release='1-bbbbbbbbbb',desired='stopped')
        original=pathlib.Path.read_text
        def read(path,*args,**kwargs):
            return 'test-boot' if path.as_posix().endswith('/proc/sys/kernel/random/boot_id') else original(path,*args,**kwargs)
        with patch.object(pathlib.Path,'read_text',read),patch.object(Lifecycle,'provision'):
            rehydrate(self.cfg,self.backend);self.run.assert_not_called()
            self.registry['demo']['runtime']['autostart']=True;rehydrate(self.cfg,self.backend);self.run.assert_not_called()
            (pathlib.Path(self.cfg['state_dir'])/'runtime-boot-id').unlink();rehydrate(self.cfg,self.backend)
        self.assertEqual(self.registry['demo']['desired'],'running');self.run.assert_called_once()
    @unittest.skipUnless(os.name=='posix','Archive ownership checks require POSIX')
    def test_archive_restore_keeps_code_env_data_and_starts_manual_stopped(self):
        self.managed();self.registry['demo'].update(updates='auto',desired='running');(self.root/'source.txt').write_text('code');(self.root/'shared').mkdir();(self.root/'shared'/'database.txt').write_text('data')
        self.life.environment('demo',{'set':{'API_KEY':'preserve'}})
        self.life.archive('demo',{'confirmName':'demo'});self.assertFalse(self.root.exists());self.assertEqual(self.registry['demo']['lifecycle'],'archived')
        result=self.life.restore('demo');self.assertEqual(result['desired'],'stopped');self.assertEqual(result['updates'],'manual')
        self.assertEqual((self.root/'shared'/'database.txt').read_text(),'data');self.assertEqual(read_values(self.life.env_path('demo'))['API_KEY'],'preserve')
    def test_shared_external_service_and_wrong_confirmation_block_archive(self):
        self.registry['demo']['service']='external';self.registry['other']={**self.registry['demo'],'service':'alias-of-external','root':str(self.root.parent/'other')}
        for name in ('wrong','demo'):
            with self.assertRaises(ValueError):self.life.archive('demo',{'confirmName':name})
        self.assertTrue(self.root.exists());self.backend['service_action'].assert_not_called()
    @unittest.skipUnless(os.name=='posix','Archive ownership checks require POSIX')
    def test_restore_refuses_to_overwrite_existing_directory(self):
        self.life.archive('demo',{'confirmName':'demo'});self.root.mkdir();(self.root/'existing').write_text('keep')
        with self.assertRaises(ValueError):self.life.restore('demo')
        self.assertEqual((self.root/'existing').read_text(),'keep')
    @unittest.skipUnless(os.name=='posix','Archive ownership checks require POSIX')
    def test_purge_checks_scope_and_requires_archived_project(self):
        with self.assertRaises(ValueError):self.life.purge('demo',{'confirmName':'demo'})
        self.life.archive('demo',{'confirmName':'demo'});self.registry['demo']['archive']['code']=str(self.base)
        with self.assertRaises(ValueError):self.life.purge('demo',{'confirmName':'demo'})
        self.assertTrue(self.base.exists())
    def test_docker_rejects_dangerous_mount_paths_and_validates_rootless(self):
        for path in ('/etc','/run/docker.sock','/app/../etc','/app/shared,src=/etc'):
            with self.assertRaises(ValueError):validate_runtime({**self.runtime,'kind':'docker','dataPath':path},{'dockerfile':True})
        self.managed();p=self.registry['demo'];p['runtime']={**p['runtime'],'kind':'docker'}
        with patch.object(self.life,'docker',return_value='["name=seccomp"]'):
            with self.assertRaises(ValueError):self.life.provision('demo',p)
    def test_slow_console_is_bounded_and_reports_gaps(self):
        follower=Follower(None,'demo','unit.service',None);subscriber=queue.Queue(maxsize=250);follower.subscribers.add(subscriber)
        for i in range(800):follower.publish({'type':'project-log','cursor':str(i),'text':'line'})
        self.assertEqual(len(follower.ring),500);self.assertLessEqual(subscriber.qsize(),250)
        self.assertTrue(any(r['type']=='project-log-gap' for r in list(subscriber.queue)))
    def test_journal_sanitizes_before_truncating_and_cursor_cannot_inject_flags(self):
        r=journal_record({'MESSAGE':'x'*20000+'MY_PRIVATE_VALUE','__CURSOR':'s=one;i=two','__REALTIME_TIMESTAMP':'1000000','PRIORITY':'3'},lambda text:text.replace('MY_PRIVATE_VALUE','[REDACTED]'))
        self.assertNotIn('MY_PRIVATE_VALUE',r['text']);self.assertEqual(r['level'],'error');self.assertLessEqual(len(r['text']),16000)
        for cursor in ('--unit=ssh\n','x\ny','x'*1025):
            with self.assertRaises(ValueError):valid_cursor(cursor)
    def test_entry_only_project_does_not_require_npm(self):
        with patch.object(runner,'BUILD_CONFIG',{'kind':'node','mode':'entry'}),patch.object(runner,'command') as command:
            runner.build_target(self.root,self.root);command.assert_not_called()
    @unittest.skipUnless(os.name=='posix','Runtime symlinks require POSIX')
    def test_local_snapshot_builds_isolated_code_and_preserves_private_files(self):
        (self.root/'index.mjs').write_text('console.log("hello")');(self.root/'.env').write_text('secret');(self.root/'shared').mkdir();(self.root/'shared'/'data').write_text('keep')
        with patch.object(runner,'BUILD_CONFIG',{'kind':'node','mode':'entry'}):result=runner.snapshot(self.root)
        release=self.root/'.control-releases'/result['release']
        self.assertTrue((release/'index.mjs').exists());self.assertFalse((release/'.env').exists());self.assertFalse((release/'shared').exists())
        self.assertEqual((release/'index.mjs').stat().st_mode&0o777,0o640);self.assertEqual((self.root/'shared'/'data').read_text(),'keep')

if __name__=='__main__':unittest.main()
