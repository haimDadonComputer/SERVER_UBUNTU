import copy,json,os,pathlib,stat,sys,tempfile,unittest
from unittest.mock import Mock,patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'helper'))
from project_storage import Storage,configuration,discover,relative_path,copy_tree,directory
from project_lifecycle import Lifecycle,validate_runtime
from runtime_launcher import node_options

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
    def test_runtime_validation_and_module_policy_options(self):
        value=validate_runtime({'kind':'node','mode':'entry','entry':'index.mjs','health':'process','storageDirectories':['data']},{'entries':['index.mjs']})
        self.assertEqual(value['storageDirectories'],['data'])
        self.assertIn('--max-old-space-size=256',node_options('--max-old-space-size=256','/trusted/guard.cjs'))
        with self.assertRaises(ValueError):node_options('--require=/uploaded/x.cjs','/trusted/guard.cjs')
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
            first=manager.prepare(p);store=next(e for e in first['directories'] if e['path']=='public/Uploads')['source']
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
