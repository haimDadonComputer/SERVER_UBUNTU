import copy,json,pathlib,sys,tempfile,threading,unittest
from unittest.mock import Mock,patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'helper'))
from publication import Publication,dispatch_publication
from project_secrets import parse_import,patch_values,read_values

class PublicationTests(unittest.TestCase):
    def test_project_domain_shares_https_with_management_and_survives_storage_refresh(self):
        with patch.object(self.pub,'interfaces'),patch('publication.socket.getaddrinfo',return_value=[(2,1,6,'',('8.8.8.8',443))]):
            self.pub.publish(None,{'enabled':True,'confirmed':True})
            management=self.pub.path('management.conf').read_text()
            data=self.pub.publish('demo',{'enabled':True,'confirmed':True,'domain':'forms.example.com'})
        item=data['projects']['demo'];self.assertEqual(item['url'],'https://forms.example.com/');self.assertEqual(item['port'],443)
        self.assertTrue(item['https']);self.assertNotEqual(item['certificate'],'management')
        path=self.pub.path('project-'+__import__('hashlib').sha256(b'demo').hexdigest()[:16]+'.conf')
        text=path.read_text();self.assertIn('server_name forms.example.com;',text)
        self.assertIn('if ($host != forms.example.com)',text);self.assertIn(str(self.pub.cert_path(item['certificate'])/'fullchain.pem'),text)
        self.assertIn('proxy_set_header Host $http_host;',text);self.assertIn('proxy_set_header X-Forwarded-Host $http_host;',text)
        self.assertEqual(self.pub.path('management.conf').read_text(),management)
        self.assertIn('return 308 https://forms.example.com',self.pub.path('challenge.conf').read_text())
        self.pub.refresh_storage('demo',{**self.record,'writableDirectories':['data']})
        self.assertIn(str(self.pub.cert_path(item['certificate'])/'fullchain.pem'),path.read_text());self.assertIn('server_name forms.example.com',path.read_text())
        self.pub.publish('demo',{'enabled':False,'confirmed':True})
        self.assertNotIn('forms.example.com',self.pub.path('challenge.conf').read_text())
        self.assertEqual(self.pub.path('management.conf').read_text(),management)
    def test_project_domain_rejects_management_aliases_injection_and_bad_dns(self):
        before=self.pub.read()
        with patch.object(self.pub,'interfaces'):
            for domain in ('control.example.com','child.control.example.com','https://forms.example.com','forms.example.com;return 200','../etc'):
                with self.assertRaises(ValueError):self.pub.publish('demo',{'enabled':True,'confirmed':True,'domain':domain})
            with patch('publication.socket.getaddrinfo',return_value=[(2,1,6,'',('1.1.1.1',443))]):
                with self.assertRaises(ValueError) as caught:self.pub.publish('demo',{'enabled':True,'confirmed':True,'domain':'forms.example.com'})
                self.assertEqual(caught.exception.details['code'],'PROJECT_DNS_IP_MISMATCH')
        self.assertEqual(self.pub.read(),before)
    def test_domain_change_validation_failure_keeps_old_domain_certificate_and_proxy(self):
        with patch.object(self.pub,'interfaces'),patch('publication.socket.getaddrinfo',return_value=[(2,1,6,'',('8.8.8.8',443))]):
            self.pub.publish('demo',{'enabled':True,'confirmed':True,'domain':'forms.example.com'})
            before=self.pub.read();cert=before['projects']['demo']['certificate'];failed=False
            path=self.pub.path('project-'+__import__('hashlib').sha256(b'demo').hexdigest()[:16]+'.conf');old=path.read_text()
            def run(argv,**kw):
                nonlocal failed
                if argv==['/usr/sbin/nginx','-t'] and 'server_name next.example.com' in path.read_text() and not failed:
                    failed=True;raise ValueError('invalid domain proxy')
                return 'certbot 5.4.0' if '--version' in argv else 'Status: inactive' if 'ufw' in argv[0] else ''
            self.run.side_effect=run
            with self.assertRaises(ValueError):self.pub.publish('demo',{'enabled':True,'confirmed':True,'domain':'next.example.com'})
        self.assertEqual(self.pub.read(),before);self.assertEqual(path.read_text(),old)
        cert_calls=[call.args[0] for call in self.run.call_args_list if 'certonly' in call.args[0]]
        self.assertNotEqual(cert_calls[-1][cert_calls[-1].index('--cert-name')+1],cert)
    def test_domain_publication_does_not_take_over_an_existing_nginx_host(self):
        self.run.side_effect=lambda argv,**kw:'server_name forms.example.com;' if '-T' in argv else 'Status: inactive' if 'ufw' in argv[0] else ''
        with patch.object(self.pub,'interfaces'),patch('publication.socket.getaddrinfo',return_value=[(2,1,6,'',('8.8.8.8',443))]):
            with self.assertRaises(ValueError):self.pub.publish('demo',{'enabled':True,'confirmed':True,'domain':'forms.example.com'})
        self.assertEqual(self.pub.read()['projects'],{})
    def test_privileged_bind_capability_is_scoped_to_publication_helper(self):
        root=pathlib.Path(__file__).resolve().parents[1]
        settings=(root/'deploy/publication-helper.conf').read_text().splitlines()
        self.assertEqual([line for line in settings if line.startswith('CapabilityBoundingSet=')],['CapabilityBoundingSet=CAP_NET_BIND_SERVICE'])
        self.assertNotIn('AmbientCapabilities=', '\n'.join(settings))
        self.assertIn('CapabilityBoundingSet=',(root/'deploy/ubuntu-control.service').read_text().splitlines())
    def test_management_redirect_keeps_acme_path_and_requires_valid_tls(self):
        data=self.pub.read();data['management']=True
        challenge=self.pub.challenge(data)
        self.assertIn('location ^~ /.well-known/acme-challenge/',challenge)
        self.assertIn('return 308 https://control.example.com$request_uri',challenge)
        self.assertNotIn('return 308',self.pub.challenge({**data,'management':False}))
        self.assertIn('listen 8.8.8.8:443 ssl;',self.pub.proxy(data,443,3080,True,True))
        with patch.object(self.pub,'interfaces'),patch('publication.socket.getaddrinfo',return_value=[(2,1,6,'',('8.8.8.8',443))]),patch.object(self.pub,'certificate',side_effect=ValueError('certificate denied')):
            with self.assertRaises(ValueError):self.pub.publish(None,{'enabled':True,'confirmed':True})
        self.assertFalse(self.pub.read()['management']);self.assertFalse(self.pub.path('management.conf').exists())
    def test_proxy_blocks_storage_paths_but_keeps_management_upload_api_available(self):
        text=self.pub.proxy(self.pub.read(),3000,3000,False,storage=['data','runtime/cache'])
        self.assertIn('uploads?',text);self.assertIn('^/data(?:/|$)',text);self.assertIn('^/runtime/cache(?:/|$)',text)
        management=self.pub.proxy(self.pub.read(),443,3080,True,True)
        self.assertNotIn('uploads?',management)
    def test_management_dns_failures_are_actionable_and_do_not_modify_publication(self):
        import socket
        from diagnostics import OperationError
        before=self.pub.read()
        cases=[(socket.gaierror(socket.EAI_NONAME,'Name or service not known'),'MANAGEMENT_DNS_UNRESOLVED'),([(socket.AF_INET,socket.SOCK_STREAM,6,'',('1.1.1.1',443))],'MANAGEMENT_DNS_IP_MISMATCH')]
        for response,code in cases:
            with patch.object(self.pub,'interfaces'),patch('publication.socket.getaddrinfo',side_effect=response if isinstance(response,Exception) else None,return_value=response):
                with self.assertRaises(OperationError) as caught:self.pub.publish(None,{'enabled':True,'confirmed':True})
            self.assertEqual(caught.exception.details['code'],code)
            self.assertEqual(caught.exception.details['stage'],'dns-resolution')
            self.assertIn('control.example.com',caught.exception.details['stderr']);self.assertIn('8.8.8.8',caught.exception.details['stderr'])
            self.assertEqual(self.pub.read(),before);self.assertFalse(self.pub.path('challenge.conf').exists())
    def test_tailscale_https_does_not_conflict_with_public_ip_but_wildcards_do(self):
        from helper import parse_ss
        self.backend['parse_ss']=parse_ss
        tail='tcp LISTEN 0 4096 100.90.70.96%tailscale0:443 0.0.0.0:* users:(("tailscaled",pid=7992,fd=26))\ntcp LISTEN 0 4096 [fd7a:115c:a1e0::9401:46f0]%tailscale0:443 [::]:* users:(("tailscaled",pid=7992,fd=28))'
        self.run.side_effect=None;self.run.return_value=tail
        self.pub.listeners('8.8.8.8',443);self.pub.listeners('8.8.8.8',80)
        for endpoint in ('0.0.0.0:443','[::]:443','8.8.8.8:443'):
            self.run.return_value='tcp LISTEN 0 4096 '+endpoint+' 0.0.0.0:* users:(("other",pid=9999,fd=26))'
            with self.assertRaises(ValueError):self.pub.listeners('8.8.8.8',443)
        script=(pathlib.Path(__file__).resolve().parents[1]/'scripts/setup-publication.sh').read_text(encoding='utf8')
        self.assertNotIn('Ports 80/443 are occupied',script)
        self.assertIn('systemctl mask --runtime nginx.service',script)
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
