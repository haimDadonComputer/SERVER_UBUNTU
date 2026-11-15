import copy,json,os,pathlib,stat,sys,tempfile,unittest
from unittest.mock import Mock,patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'helper'))
from project_storage import Storage,configuration,configured_paths,discover,relative_path,copy_tree,directory,migrate_shared,systemd_state_path
from project_lifecycle import Lifecycle,validate_runtime
from runtime_launcher import node_options,runtime_exit_code

class StorageDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=pathlib.Path(self.tmp.name)
    def test_uploads_are_found_case_insensitively_at_all_application_depths(self):
        for path in ('upload','src/server/assets/UpLoAdS','web/public/UPLOAD','.cache/uploads','node_modules/vendor/uploads'):(self.root/path).mkdir(parents=True)
        self.assertEqual(set(discover(self.root)),{'upload','src/server/assets/UpLoAdS','web/public/UPLOAD','.cache/uploads'})
    def test_explicit_missing_data_directories_and_versioned_configuration(self):
        (self.root/'package.json').write_text(json.dumps({'ubuntuControl':{'storageDirectories':['data','runtime/cache']}}))
        (self.root/'.ubuntu-control.json').write_text(json.dumps({'storageDirectories':['public/Uploads']}))
        self.assertEqual(set(discover(self.root,configuration(self.root))),{'data','runtime/cache','public/Uploads'})
        self.assertFalse((self.root/'data').exists())
    def test_traversal_protected_paths_and_mount_option_injection_are_rejected(self):
        for value in ('../etc','/etc','a/../b','a//b','a\\b','a,b','current/files','node_modules/data','.env','.ssh/data','a:b','a\nb',''):
            with self.assertRaises(ValueError,msg=value):relative_path(value)
        (self.root/'data').write_text('not a directory')
        with self.assertRaises(ValueError):discover(self.root,['data'])
    @unittest.skipUnless(os.name=='posix','Symlink tests require POSIX')
    def test_symlink_upload_and_configured_ancestor_fail_closed(self):
        (self.root/'uploads').symlink_to(self.root,target_is_directory=True)
        with self.assertRaises(ValueError):discover(self.root)
        (self.root/'uploads').unlink();(self.root/'other').symlink_to(self.root,target_is_directory=True)
        with self.assertRaises(ValueError):discover(self.root,['other/data'])
    def test_outer_data_mapping_covers_nested_uploads(self):
        (self.root/'data/nested/uploads').mkdir(parents=True)
        self.assertEqual(discover(self.root,['data']),['data'])
    def test_conventional_data_is_prepared_without_manual_configuration(self):
        release=self.root/'release';release.mkdir()
        self.assertIn('data',configured_paths(self.root,release,[]))
        (release/'data').write_text('application code')
        self.assertNotIn('data',configured_paths(self.root,release,[]))
        self.assertIn('custom/cache',configured_paths(self.root,release,['custom/cache']))
    def test_systemd_state_alias_returns_private_target_not_the_symlink(self):
        normal=Mock();expected=self.root/'private/state'
        normal.is_symlink.return_value=True;normal.lstat.return_value=Mock(st_uid=0)
        normal.resolve.return_value=expected
        self.assertEqual(systemd_state_path(normal,expected),expected)
        normal.resolve.return_value=self.root/'other-project'
        with self.assertRaises(ValueError):systemd_state_path(normal,expected)
        normal.resolve.return_value=expected;normal.lstat.return_value=Mock(st_uid=997)
        with self.assertRaises(ValueError):systemd_state_path(normal,expected)
        normal.is_symlink.return_value=False
        self.assertIs(systemd_state_path(normal,expected),normal)
    def test_runtime_validation_and_module_policy_options(self):
        value=validate_runtime({'kind':'node','mode':'entry','entry':'index.mjs','health':'process','storageDirectories':['data']},{'entries':['index.mjs']})
        self.assertEqual(value['storageDirectories'],['data'])
        self.assertIn('--max-old-space-size=256',node_options('--max-old-space-size=256','/trusted/guard.cjs'))
        with self.assertRaises(ValueError):node_options('--require=/uploaded/x.cjs','/trusted/guard.cjs')
    def test_node_stop_does_not_wrap_sigterm_to_systemd_configuration_failure(self):
        import signal
        self.assertEqual(runtime_exit_code(-signal.SIGTERM,True),0)
        self.assertEqual(runtime_exit_code(128+signal.SIGTERM,True),0)
        self.assertEqual(runtime_exit_code(1,True),1)
        self.assertEqual(runtime_exit_code(0),0)
        self.assertEqual(runtime_exit_code(-signal.SIGTERM),128+signal.SIGTERM)
    def test_generated_unit_only_grants_scoped_storage_access(self):
        cfg={'state_dir':str(self.root/'state')}
        life=Lifecycle(cfg,{})
        p={'root':'/srv/ubuntu-projects/demo','release':'1-aaaaaaaaaa','runtime':{'kind':'node','autostart':False},'storage':{'version':1,'view':'/var/lib/ubuntu-control-code/key/view','directories':[{'path':'src/Uploads','source':'/var/lib/ubuntu-control-storage/key-data','state':'ubuntu-control-storage/key-data'}]}}
        text=life.unit_text('demo',p)
        self.assertIn('DynamicUser=true',text);self.assertIn('ProtectSystem=strict',text)
        self.assertIn('BindReadOnlyPaths="/var/lib/ubuntu-control-code/key/view":"/srv/ubuntu-projects/demo"',text)
        self.assertIn('BindPaths="/var/lib/ubuntu-control-storage/key-data":"/srv/ubuntu-projects/demo/.control-releases/1-aaaaaaaaaa/src/Uploads"',text)
        self.assertIn('NoExecPaths="/srv/ubuntu-projects/demo/.control-releases/1-aaaaaaaaaa/src/Uploads"',text)
        self.assertNotIn('ReadWritePaths="/srv/ubuntu-projects/demo/.control-releases"\n',text)

@unittest.skipUnless(os.name=='posix','Descriptor-anchored copy requires POSIX')
class StorageCopyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.base=pathlib.Path(self.tmp.name);self.source=self.base/'source';self.source.mkdir();self.target=self.base/'target'
    def test_copy_preserves_originals_and_refuses_conflicting_data(self):
        (self.source/'nested').mkdir();(self.source/'nested/image').write_bytes(b'keep')
        copy_tree(self.source,self.target);copy_tree(self.source,self.target)
        (self.source/'nested/image').write_bytes(b'changed')
        with self.assertRaises(ValueError):copy_tree(self.source,self.target)
        self.assertEqual((self.target/'nested/image').read_bytes(),b'keep');self.assertEqual((self.source/'nested/image').read_bytes(),b'changed')
    def test_code_directories_are_group_readable_under_private_helper_umask(self):
        (self.source/'server/nested').mkdir(parents=True)
        (self.source/'server/nested/index.js').write_text('code')
        previous=os.umask(0o077)
        try:
            with patch('project_storage.os.fchown'):
                copy_tree(self.source,self.target,code=True,group=os.getgid())
        finally:os.umask(previous)
        self.assertEqual((self.target/'server').stat().st_mode&0o777,0o750)
        self.assertEqual((self.target/'server/nested').stat().st_mode&0o777,0o750)
        self.assertEqual((self.target/'server/nested/index.js').stat().st_mode&0o777,0o640)
    def test_legacy_shared_merges_without_overwriting_or_losing_conflicts(self):
        (self.source/'conflict').write_text('source original')
        (self.source/'new').write_text('imported')
        self.target.mkdir();(self.target/'conflict').write_text('active private value')
        (self.target/'private-only').write_text('retained')
        result=migrate_shared(self.source,self.target,self.base/'state','demo')
        self.assertEqual(result['conflicts'],1)
        self.assertEqual((pathlib.Path(result['backup'])/'conflict').read_text(),'source original')
        self.assertEqual((self.source/'conflict').read_text(),'source original')
        self.assertEqual((self.target/'conflict').read_text(),'active private value')
        self.assertEqual((self.target/'private-only').read_text(),'retained')
        self.assertEqual((self.target/'new').read_text(),'imported')
        (self.target/'new').unlink()
        self.assertEqual(migrate_shared(self.source,self.target,self.base/'state','demo'),result)
        self.assertFalse((self.target/'new').exists(),'Restart must not resurrect deleted application data')
    def test_shared_migration_uses_verified_private_state_after_systemd_migration(self):
        self.target.mkdir();alias=self.base/'public-state';alias.symlink_to(self.target,target_is_directory=True)
        (self.source/'new').write_text('retained original')
        # Emulate PID1's root ownership while allowing the upgrade suite to run
        # unprivileged. Path traversal/copy uses actual POSIX descriptors.
        original=pathlib.Path.lstat
        def lstat(path,*args,**kwargs):
            return Mock(st_uid=0,st_mode=stat.S_IFLNK) if path==alias else original(path,*args,**kwargs)
        with patch.object(pathlib.Path,'lstat',lstat):
            target=systemd_state_path(alias,self.target)
        with self.assertRaises(OSError):
            with directory(alias):pass
        migrate_shared(self.source,target,self.base/'state','demo')
        self.assertEqual((self.target/'new').read_text(),'retained original')
        self.assertTrue(alias.is_symlink());self.assertEqual((self.source/'new').read_text(),'retained original')
    def test_failed_shared_backup_does_not_mutate_private_data(self):
        self.target.mkdir();(self.source/'secret-link').symlink_to('/etc')
        with self.assertRaises(ValueError):migrate_shared(self.source,self.target,self.base/'state','demo')
        self.assertEqual(list(self.target.iterdir()),[])
        self.assertFalse((self.base/'state/storage-migrations/demo.json').exists())
    def test_interrupted_copy_never_publishes_a_partial_destination(self):
        (self.source/'file').write_text('complete original')
        with patch('project_storage.os.write',side_effect=OSError('disk full')):
            with self.assertRaises(OSError):copy_tree(self.source,self.target)
        self.assertEqual(list(self.target.iterdir()),[])
        copy_tree(self.source,self.target)
        self.assertEqual((self.target/'file').read_text(),'complete original')
    def test_copy_rejects_links_special_files_and_swapped_destination(self):
        (self.source/'a').write_text('private');os.link(self.source/'a',self.source/'b')
        with self.assertRaises(ValueError):copy_tree(self.source,self.target)
        (self.source/'b').unlink();(self.source/'link').symlink_to('/etc')
        with self.assertRaises(ValueError):copy_tree(self.source,self.target)
        (self.source/'link').unlink();self.target.mkdir(exist_ok=True);(self.target/'a').unlink(missing_ok=True);(self.target/'a').symlink_to(self.source/'a')
        with self.assertRaises(OSError):copy_tree(self.source,self.target)
        self.assertEqual((self.source/'a').read_text(),'private')

@unittest.skipUnless(os.name=='posix' and getattr(os,'geteuid',lambda:1)()==0,'Full root-owned runtime projection requires a root Linux acceptance environment')
class StorageProjectionTests(unittest.TestCase):
    def test_restart_new_release_and_rollback_reuse_data_and_hide_source_changes(self):
        import grp
        with tempfile.TemporaryDirectory() as base:
            base=pathlib.Path(base);root=base/'projects/demo';release=root/'.control-releases/1-aaaaaaaaaa';release.mkdir(parents=True)
            (release/'index.mjs').write_text('initial code');(release/'public/Uploads').mkdir(parents=True);(release/'public/Uploads/photo').write_text('original')
            cfg={'state_dir':str(base/'state'),'storage_dir':str(base/'storage'),'runtime_code_dir':str(base/'code'),'project_group':grp.getgrgid(os.getgid()).gr_name}
            life=Lifecycle(cfg,{});manager=Storage(life,'demo');p={'root':str(root),'release':release.name,'runtime':{'kind':'node','mode':'entry','entry':'index.mjs','storageDirectories':['data']}}
            previous=os.umask(0o077)
            try:first=manager.prepare(p)
            finally:os.umask(previous)
            for path in (pathlib.Path(first['view']),pathlib.Path(first['view'])/'.control-releases'/release.name):
                self.assertEqual(path.stat().st_mode&0o777,0o750)
            store=next(e for e in first['directories'] if e['path']=='public/Uploads')['source']
            pathlib.Path(store,'photo').write_text('edited');pathlib.Path(store,'new').write_text('new data')
            again=manager.prepare(p);self.assertEqual(first['view'],again['view'])
            second=root/'.control-releases/2-bbbbbbbbbb';second.mkdir();(second/'index.mjs').write_text('updated code');(second/'public/Uploads').mkdir(parents=True)
            p['release']=second.name;updated=manager.prepare(p)
            self.assertEqual(next(e['source'] for e in updated['directories'] if e['path']=='public/Uploads'),store)
            p['release']=release.name;rolled_back=manager.prepare(p);self.assertEqual(first['view'],rolled_back['view']);self.assertEqual(pathlib.Path(store,'photo').read_text(),'edited')
            self.assertEqual((release/'public/Uploads/photo').read_text(),'original')
            self.assertTrue((pathlib.Path(first['view'])/'.control-releases'/release.name/'data').is_dir())
            self.assertFalse((pathlib.Path(first['view'])/'.control-releases'/release.name/'public/Uploads/photo').exists())
            manager.purge();self.assertFalse(pathlib.Path(store).exists());self.assertTrue(root.exists())
