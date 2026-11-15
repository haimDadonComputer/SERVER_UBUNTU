import copy,pathlib,sys,tempfile,unittest
from unittest.mock import Mock,patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'helper'))
from project_ports import check_port
from project_lifecycle import Lifecycle
from helper import parse_ss

class PortTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        root=pathlib.Path(self.temp.name)/'demo';root.mkdir()
        cfg={'project_root':str(root.parent),'state_dir':str(root.parent/'state')}
        self.projects={'demo':{'root':str(root),'ownership':'managed','runtime':{'port':3000}}}
        self.run=Mock(return_value='')
        self.life=Lifecycle(cfg,{'project_identifier':lambda value:value,'all_projects':lambda _:copy.deepcopy(self.projects),'run':self.run,'parse_ss':parse_ss})
    def test_free_foreign_owned_and_address_specific_listeners(self):
        self.assertEqual(check_port(self.life,'demo',3000)['status'],'available')
        self.run.return_value='tcp LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=123,fd=20))'
        with patch.object(pathlib.Path,'read_text',return_value='0::/system.slice/foreign.service\n'):
            value=check_port(self.life,'demo',3000);self.assertEqual(value['status'],'occupied');self.assertEqual(value['listeners'][0]['pid'],123)
        with patch.object(pathlib.Path,'read_text',return_value='0::/system.slice/'+self.life.names('demo')['unit']+'\n'):
            self.assertEqual(check_port(self.life,'demo',3000)['status'],'owned')
        self.run.return_value=self.run.return_value.replace('127.0.0.1:3000','100.90.70.96%tailscale0:3000')
        self.assertEqual(check_port(self.life,'demo',3000)['status'],'available')
        self.assertEqual(check_port(self.life,'demo',3000,'0.0.0.0')['status'],'occupied')
        self.assertTrue(all(call.args[0][0]=='/usr/bin/ss' for call in self.run.call_args_list))
    def test_reservation_unknown_probe_and_validation(self):
        self.projects['other']={'lifecycle':'active','runtime':{'port':3000}}
        self.assertEqual(check_port(self.life,'demo',3000)['status'],'reserved');self.run.assert_not_called()
        self.projects.pop('other');self.run.side_effect=ValueError('ss unavailable')
        self.assertEqual(check_port(self.life,'demo',3000)['status'],'unknown')
        for port,listen in ((22,'127.0.0.1'),('3000','127.0.0.1'),(3000,'evil.test')):
            with self.assertRaises(ValueError):check_port(self.life,'demo',port,listen)
