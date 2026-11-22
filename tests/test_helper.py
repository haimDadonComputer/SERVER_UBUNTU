import unittest, importlib.util, pathlib, tempfile, json, time
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('helper',pathlib.Path(__file__).resolve().parents[1]/'helper/helper.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)

class HelperTests(unittest.TestCase):
    def test_escaped_env_wire_limit_is_scoped_to_env_import(self):
        text='\n'.join('K'+str(index)+'='+'\x01'*8192 for index in range(100))
        self.assertEqual(len(h.parse_import(text)),100)
        wire=json.dumps({'action':'project-env-import','args':{'project':'demo','text':text}}).encode()
        self.assertGreater(len(wire),2200000)
        self.assertEqual(h.decode_request(wire)['args']['text'],text)
        with self.assertRaises(ValueError):h.decode_request(wire.replace(b'project-env-import',b'project-env-patch'))
        with self.assertRaises(ValueError):h.decode_request(b' '* (7*1024*1024+1))
    def test_ss_ipv4_ipv6_udp(self):
        rows=h.parse_ss('tcp LISTEN 0 128 127.0.0.1:3080 0.0.0.0:* users:(("node",pid=42,fd=5))\nudp UNCONN 0 0 [::]:53 [::]:*\ntcp LISTEN 0 128 [::1]:6379 [::]:*')
        self.assertEqual(len(rows),3);self.assertEqual(rows[0]['pid'],42)
        self.assertEqual(rows[0]['exposure'],'local');self.assertEqual(rows[1]['exposure'],'unknown');self.assertEqual(rows[2]['exposure'],'local')
    def test_allowlist_rejects_injected_units(self):
        with self.assertRaises(ValueError):h.service({'services':[]},'ssh.service')
        with self.assertRaises(ValueError):h.service({'services':[{'id':'x','kind':'systemd','name':'a;touch /tmp/x'}]},'x')
        self.assertEqual(h.service({'services':[{'id':'web','kind':'systemd','name':'web.service'}]},'web')['kind'],'systemd')
    def test_management_service_cannot_be_stopped(self):
        with self.assertRaises(ValueError):h.service_action({'services':[{'id':'ssh','kind':'systemd','name':'ssh.service'}]},{'service':'ssh','operation':'stop','confirmed':True})
    def test_firewall_validates_cidr_sensitive_ports_and_confirmation(self):
        args={'port':3000,'protocol':'tcp','source':'203.0.113.2/32','operation':'allow','confirmed':True,'worldConfirmed':False}
        self.assertEqual(h.validate_firewall({},args),(3000,'203.0.113.2/32'))
        for change in ({'port':22},{'source':'0.0.0.0/0'},{'source':'::/0'},{'source':'1.2.3.4;reboot'},{'port':65536},{'protocol':'tcp;shutdown'},{'confirmed':False}):
            with self.assertRaises(ValueError):h.validate_firewall({},{**args,**change})
        self.assertEqual(h.validate_firewall({},{**args,'source':'::/0','worldConfirmed':True})[1],'::/0')
    def test_ufw_never_activated_automatically(self):
        with tempfile.TemporaryDirectory() as d,patch.object(h,'run',return_value='Status: inactive') as run:
            with self.assertRaises(ValueError):h.firewall_change({'state_dir':d},{'port':3000,'protocol':'tcp','source':'203.0.113.2/32','operation':'allow','confirmed':True})
            self.assertEqual(run.call_count,1)
    def test_failed_service_start_is_not_success(self):
        cfg={'services':[{'id':'web','kind':'systemd','name':'web.service'}]}
        with patch.object(h,'run',side_effect=['','failed\n']):
            with self.assertRaises(ValueError):h.service_action(cfg,{'service':'web','operation':'start','confirmed':True})
    def test_rollback_restores_both_ip_families_and_cloud(self):
        with tempfile.TemporaryDirectory() as d:
            tx='a'*32;state=pathlib.Path(d);(state/'pending.json').write_text(json.dumps({'id':tx,'cloud':[{'direction':'in'}]}))
            with patch.object(h.shutil,'copy2') as copy,patch.object(h,'run') as run,patch.object(h,'cloud_rules') as cloud:
                h.rollback({'state_dir':d},tx)
                self.assertEqual(copy.call_count,2);run.assert_called_once_with(['/usr/sbin/ufw','reload']);cloud.assert_called_once();self.assertFalse((state/'pending.json').exists())
    def test_unknown_actions_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):h.dispatch({'state_dir':d},'exec',{'command':'reboot'})

if __name__=='__main__':unittest.main()
