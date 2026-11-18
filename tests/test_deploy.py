import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import deploy

class DeploymentSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        (self.root/'docker-compose.yml').write_text('services: {}\n')
        (self.root/'.env').write_text('SYNTHETIC=fixture\n')
        self.args=SimpleNamespace(instance_dir=self.root,project='synthetic-project',image='synthetic-image',expected_base_image=None,apply=False,credentials=None,stop_updater=False)
        self.api={'Image':'sha256:synthetic','Config':{'Env':['ALLOWED_SANDBOX_PROVIDERS=platinum,daytona']}}

    def inspection(self,name):
        if name.endswith('kortix-api-1'):return self.api
        if name.endswith('supabase-db-1'):return {'State':{'Running':True}}
        return None

    def test_dry_run_creates_no_credentials_or_backup(self):
        with patch.object(deploy,'inspect',side_effect=self.inspection),patch.object(deploy,'command',return_value=json.dumps([{'Os':'linux','Architecture':'amd64'}])) as cmd,contextlib.redirect_stdout(io.StringIO()):deploy.deploy(self.args)
        self.assertFalse((self.root/'.docker-cloud.env').exists())
        self.assertFalse((self.root/'docker-cloud-backups').exists())
        self.assertEqual(cmd.call_count,1)

    def test_apply_requires_private_credential_file(self):
        self.args.apply=True
        with patch.object(deploy,'inspect',side_effect=self.inspection),patch.object(deploy,'command',return_value=json.dumps([{'Os':'linux','Architecture':'amd64'}])),contextlib.redirect_stdout(io.StringIO()),self.assertRaises(ValueError):deploy.deploy(self.args)
        self.assertFalse((self.root/'docker-cloud-backups').exists())

    def test_expected_base_image_mismatch_is_refused(self):
        self.args.expected_base_image='sha256:other'
        with patch.object(deploy,'inspect',side_effect=self.inspection),self.assertRaises(ValueError):deploy.deploy(self.args)

    def test_parser_only_reads_backend_credentials(self):
        p=self.root/'synthetic.env';p.write_text('DOCKER_CLOUD_USERNAME=synthetic\nDOCKER_CLOUD_PAT=synthetic-pat\nOTHER_SECRET=unused\n')
        self.assertEqual(set(deploy.parse_credentials(p)),{'DOCKER_CLOUD_USERNAME','DOCKER_CLOUD_PAT'})

    def test_missing_pat_is_refused(self):
        p=self.root/'synthetic.env';p.write_text('DOCKER_CLOUD_USERNAME=synthetic\n')
        with self.assertRaises(ValueError):deploy.parse_credentials(p)

    def test_provider_error_diagnostics_are_not_echoed(self):
        result=SimpleNamespace(returncode=1,stdout='synthetic-private-diagnostic',stderr='synthetic-private-diagnostic')
        with patch.object(deploy.subprocess,'run',return_value=result),self.assertRaises(RuntimeError) as error:deploy.command(['docker','inspect','synthetic'])
        self.assertNotIn('synthetic-private-diagnostic',str(error.exception))

if __name__=='__main__':unittest.main()
