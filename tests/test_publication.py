import copy,json,pathlib,sys,tempfile,threading,unittest
from unittest.mock import Mock,patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'helper'))
from publication import Publication,dispatch_publication
from project_secrets import parse_import,patch_values,read_values

class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.base=pathlib.Path(self.tmp.name)
        self.cfg={'state_dir':str(self.base/'state'),'publication_dir':str(self.base/'nginx'),'publication_acme':str(self.base/'acme'),'project_root':str(self.base/'projects')}
        self.root=self.base/'projects/demo';self.root.mkdir(parents=True)
        self.run=Mock(side_effect=lambda argv,**kwargs:'certbot 5.4.0' if '--version' in argv else 'Status: inactive' if 'ufw' in argv[0] else '[]' if '-j' in argv else '')
        self.record={'root':str(self.root),'kind':'node','ownership':'managed','runtime':{'kind':'node','health':'http','port':3000,'listenAddress':'127.0.0.1'}}
        self.backend={'run':self.run,'parse_ss':lambda text:[],'all_projects':lambda _: {'demo':self.record},'project_identifier':lambda value:value,'FIREWALL_WORK':threading.Event()}
        self.pub=Publication(self.cfg,self.backend);self.pub.directory.mkdir();self.pub.acme.mkdir();(self.pub.acme/'prepared').touch()
        self.pub.save({**self.pub.read(),'ip':'8.8.8.8','domain':'control.example.com','email':'admin@example.com'})
    def test_plain_publication_and_disable_preserve_unrelated_files(self):
        unrelated=self.pub.directory/'operator.conf';unrelated.write_text('operator content')
        with patch.object(self.pub,'interfaces'):
            data=self.pub.publish('demo',{'enabled':True,'confirmed':True,'port':3000})
        self.assertEqual(data['projects']['demo']['url'],'http://8.8.8.8:3000/')
        text=self.pub.path('project-'+__import__('hashlib').sha256(b'demo').hexdigest()[:16]+'.conf').read_text()
        self.assertIn('listen 8.8.8.8:3000;',text);self.assertIn('proxy_pass http://127.0.0.1:3000;',text)
        self.pub.publish('demo',{'enabled':False,'confirmed':True})
        self.assertEqual(unrelated.read_text(),'operator content');self.assertEqual(self.pub.read()['projects'],{})
        self.assertFalse(self.pub.path('challenge.conf').exists())
    def test_proxy_validation_failure_restores_files_and_state(self):
        before=self.pub.read();self.pub.write('management.conf','old site')
        failed=False
        def run(argv,**kwargs):
            nonlocal failed
            if argv==['/usr/sbin/nginx','-t'] and not failed:failed=True;raise ValueError('invalid nginx')
            return 'Status: inactive' if 'ufw' in argv[0] else ''
        self.run.side_effect=run
        with self.assertRaises(ValueError):self.pub.transaction(before,{**before,'management':True},{'management.conf':'new site'})
        self.assertEqual(self.pub.path('management.conf').read_text(),'old site');self.assertEqual(self.pub.read(),before)
        self.assertFalse((self.pub.state/'pending.json').exists())
    def test_rejects_unconfirmed_wildcard_protected_port_and_path_escape(self):
        with self.assertRaises(ValueError):self.pub.publish('demo',{'enabled':True})
        with patch.object(self.pub,'interfaces'):
            with self.assertRaises(ValueError):self.pub.publish('demo',{'enabled':True,'confirmed':True,'port':3080})
            self.record['runtime']['listenAddress']='0.0.0.0'
            with self.assertRaises(ValueError):self.pub.publish('demo',{'enabled':True,'confirmed':True,'port':3000})
        with self.assertRaises(ValueError):self.pub.path('../operator.conf')
        with self.assertRaises(ValueError):self.pub.settings({'ip':'127.0.0.1'})
    def test_ip_certificate_uses_shortlived_profile_and_fixed_directories(self):
        self.pub.certificate('ip','8.8.8.8',self.pub.read(),True)
        command=self.run.call_args.args[0]
        self.assertIn('--dry-run',command);self.assertIn('shortlived',command);self.assertIn('--ip-address',command)
        self.assertNotIn('privkey.pem',json.dumps(self.pub.status()))
    def test_publication_never_proxies_an_unrelated_local_service(self):
        self.backend['parse_ss']=lambda _: [{'protocol':'tcp','port':3000,'address':'127.0.0.1','pid':9999}]
        with patch.object(self.pub,'interfaces'),patch.object(pathlib.Path,'read_text',return_value='0::/system.slice/unrelated.service\n'):
            # Read root settings before replacing the proc reader.
            with patch.object(self.pub,'read',return_value={**copy.deepcopy(__import__('publication').DEFAULT),'ip':'8.8.8.8','email':'admin@example.com'}):
                with self.assertRaisesRegex(ValueError,'does not belong'):self.pub.publish('demo',{'enabled':True,'confirmed':True,'port':4000})
    def test_wildcard_listener_cannot_bypass_https_using_another_public_port(self):
        self.backend['parse_ss']=lambda _: [{'protocol':'tcp','port':3000,'address':'0.0.0.0','pid':9999}]
        with patch.object(self.pub,'interfaces'):
            with self.assertRaisesRegex(ValueError,'all interfaces'):self.pub.publish('demo',{'enabled':True,'confirmed':True,'port':4000,'https':True})
    def test_active_ufw_requires_verified_network_and_preserves_existing_rule(self):
        self.run.side_effect=lambda argv,**kw:'Status: active\n8.8.8.8 3000/tcp ALLOW Anywhere'
        with self.assertRaises(ValueError):self.pub.fw_status()
        self.cfg['ufw_verified_host_network']=True
        before=self.pub.read();after={**before,'projects':{'demo':{'port':3000}}}
        with self.assertRaises(ValueError):self.pub.transaction(before,after,{'management.conf':'x'})
        self.assertFalse((self.pub.state/'pending.json').exists())
    def test_rootless_docker_listener_requires_project_label_image_and_binding(self):
        self.record.update(image='uc-project-test:release')
        self.record['runtime'].update(kind='docker',internalPort=3000)
        self.backend['parse_ss']=lambda _: [{'protocol':'tcp','port':3000,'address':'127.0.0.1','pid':9999}]
        container={'State':{'Running':True},'Config':{'Labels':{'ubuntu-control.project':'other'},'Image':self.record['image']},'NetworkSettings':{'Ports':{'3000/tcp':[{'HostIp':'127.0.0.1','HostPort':'3000'}]}}}
        with patch.object(self.pub,'interfaces'),patch('publication.Lifecycle.docker',side_effect=lambda *args,**kw:json.dumps(container)):
            with self.assertRaisesRegex(ValueError,'does not belong'):self.pub.publish('demo',{'enabled':True,'confirmed':True,'port':4000})
            container['Config']['Labels']['ubuntu-control.project']='demo'
            self.assertIn('demo',self.pub.publish('demo',{'enabled':True,'confirmed':True,'port':4000})['projects'])
    def test_staging_challenge_is_removed_after_failed_test(self):
        with patch.object(Publication,'interfaces'),patch.object(Publication,'certificate',side_effect=ValueError('challenge failed')):
            with self.assertRaises(ValueError):dispatch_publication(self.cfg,'network-certificate-test',{'kind':'ip','confirmed':True},self.backend)
        self.assertFalse(self.pub.path('challenge.conf').exists());self.assertFalse(self.backend['FIREWALL_WORK'].is_set())
    def test_failed_first_proxy_does_not_leave_challenge_public(self):
        checks=0
        def run(argv,**kw):
            nonlocal checks
            if argv==['/usr/sbin/nginx','-t']:
                checks+=1
                if checks==3:raise ValueError('invalid project proxy')
            return 'Status: inactive' if 'ufw' in argv[0] else ''
        self.run.side_effect=run
        with patch.object(self.pub,'interfaces'):
            with self.assertRaises(ValueError):self.pub.publish('demo',{'enabled':True,'confirmed':True,'port':3000})
        self.assertFalse(self.pub.path('challenge.conf').exists());self.assertEqual(self.pub.read()['projects'],{})
        self.assertFalse(self.pub.read().get('challengePending',False))
    def test_later_ufw_activation_does_not_grant_ownership_of_operator_rules(self):
        with patch.object(self.pub,'interfaces'):self.pub.publish('demo',{'enabled':True,'confirmed':True,'port':3000})
        self.assertEqual(self.pub.read()['firewallOwned'],[])
        self.cfg['ufw_verified_host_network']=True
        self.run.side_effect=lambda argv,**kw:'Status: active\n8.8.8.8 3000/tcp ALLOW Anywhere' if 'ufw' in argv[0] else ''
        self.run.reset_mock();self.pub.publish('demo',{'enabled':False,'confirmed':True})
        self.assertFalse(any('delete' in call.args[0] for call in self.run.call_args_list))

class EnvImportTests(unittest.TestCase):
    def test_progress_transport_preserves_final_output_and_redacts_before_callback(self):
        from job_progress import LOCAL,execute
        events=[];LOCAL.callback=events.append;LOCAL.secrets=('opaque-sensitive-value',)
        try:
            code='import sys,json; print("UC_PROGRESS_V1:"+json.dumps({"stage":"npm-install","text":"opaque-sensitive-value"}),file=sys.stderr); print("final-result")'
            result=execute([sys.executable,'-c',code],capture_output=True,text=True,timeout=10)
            self.assertEqual(result.stdout.strip(),'final-result');self.assertEqual(result.stderr,'')
            self.assertEqual(events,[{'stage':'npm-install','text':'[REDACTED]'}])
        finally:LOCAL.callback=None;LOCAL.secrets=()
    def test_supported_import_and_explicit_empty_values_merge_privately(self):
        values=parse_import('\ufeff# comment\nexport API_KEY="private value"\nEMPTY=\nURL=example#comment\nQUOTE="a\\\"b"\n')
        self.assertEqual(values,{'API_KEY':'private value','EMPTY':'','URL':'example','QUOTE':'a"b'})
        with tempfile.TemporaryDirectory() as directory:
            path=pathlib.Path(directory)/'env';patch_values(path,{'KEEP':'old','EMPTY':'before'})
            result=patch_values(path,values,allow_empty=True)
            self.assertEqual(read_values(path)['EMPTY'],'');self.assertEqual(read_values(path)['KEEP'],'old')
            self.assertNotIn('private value',json.dumps(result));self.assertEqual(result['publicBuild'],[])
    def test_invalid_file_errors_only_identify_line(self):
        for text in ('API_KEY=x\nAPI_KEY=secret','API_KEY="secret','PATH=/evil','A=$(secret)','A=${SECRET}','A=`secret`','A="line\\nsecret"','BAD-NAME=secret'):
            with self.assertRaises(ValueError) as error:parse_import(text)
            self.assertNotIn('secret',str(error.exception));self.assertIn('line',str(error.exception))
        with self.assertRaises(ValueError):parse_import('A='+'x'*1048576)
