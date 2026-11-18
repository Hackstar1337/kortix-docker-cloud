"""No Docker credentials, cloud resource creation or live deployment needed."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from verify import ROOT, verify, safe_relative
from prepare import prepare

class IntegrityTests(unittest.TestCase):
    def test_published_payload(self):
        self.assertGreaterEqual(verify()['overlay_files'], 30)

    def test_path_traversal(self):
        for value in ('../secret', '/etc/passwd', 'apps/../../secret', 'apps\\api\\evil', 'unexpected/file'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                safe_relative(value)

    def test_allowed_paths(self):
        for value in ('apps/api/src/file.ts', 'packages/db/src/file.ts', 'pnpm-lock.yaml'):
            self.assertEqual(str(safe_relative(value)), value)

    def test_manifest_has_fixed_versions(self):
        m=json.loads((ROOT/'integration.json').read_text())
        self.assertEqual(m['docker_sdk_version'],'0.53.0')
        self.assertEqual(len(m['upstream_revision']),40)

    def test_license_is_not_replaced_with_mit(self):
        self.assertIn('Elastic License 2.0',(ROOT/'LICENSE').read_text())

    def test_no_private_environment_files(self):
        for p in ROOT.rglob('*'):
            if any(s in ('.git','.work','__pycache__') for s in p.parts):continue
            self.assertFalse(p.is_file() and p.name.endswith('.env'))

    def test_overlay_includes_runtime_and_migration(self):
        paths={v['path'] for v in json.loads((ROOT/'integration.json').read_text())['files']}
        self.assertIn('apps/api/src/platform/providers/docker-cloud.ts',paths)
        self.assertTrue(any(p.endswith('_sandbox_provider_add_docker_cloud.sql') for p in paths))

class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name);self.target=self.base/'checkout';self.target.mkdir()
        self.git('init');self.file=self.target/'apps/api/file.ts';self.file.parent.mkdir(parents=True)
        self.file.write_text('old\n');self.git('add','.');self.git('-c','user.name=Synthetic Fixture','-c','user.email=fixture@invalid.example','commit','-m','fixture')
        revision=self.git('rev-parse','HEAD');self.file.write_text('new\n');patch=self.git('diff')+'\n';self.git('checkout','--','.')
        self.kit=self.base/'kit';(self.kit/'overlay/apps/api').mkdir(parents=True);(self.kit/'patches').mkdir()
        (self.kit/'overlay/apps/api/file.ts').write_text('new\n');(self.kit/'patches/payload.patch').write_text(patch)
        (self.kit/'LICENSE').write_text('Elastic License 2.0\n')
        sha=lambda b:hashlib.sha256(b).hexdigest()
        m={'upstream_repository':'https://github.com/kortix-ai/CompanyOS.git','upstream_revision':revision,'patch':'patches/payload.patch','patch_sha256':sha(patch.encode()),'files':[{'path':'apps/api/file.ts','sha256':sha(b'new\n')}]}
        (self.kit/'integration.json').write_text(json.dumps(m))

    def git(self,*args):
        return subprocess.run(['git','-c','core.autocrlf=false','-C',str(self.target),*args],capture_output=True,text=True,check=True).stdout.strip()

    def test_prepare_applies_reviewed_patch(self):
        prepare(self.target,self.kit);self.assertEqual(self.file.read_text(),'new\n')

    def test_prepare_is_idempotent(self):
        prepare(self.target,self.kit);prepare(self.target,self.kit)

    def test_dirty_checkout_is_refused(self):
        self.file.write_text('user change\n')
        with self.assertRaises(ValueError):prepare(self.target,self.kit)
        self.assertEqual(self.file.read_text(),'user change\n')

    def test_wrong_revision_is_refused(self):
        (self.target/'other.txt').write_text('fixture\n');self.git('add','.');self.git('-c','user.name=Synthetic Fixture','-c','user.email=fixture@invalid.example','commit','-m','another fixture')
        with self.assertRaises(ValueError):prepare(self.target,self.kit)

    def test_tampered_patch_is_refused(self):
        (self.kit/'patches/payload.patch').write_text('tampered\n')
        with self.assertRaises(ValueError):prepare(self.target,self.kit)

    def test_private_env_is_refused(self):
        (self.kit/'.env').write_text('SYNTHETIC=fixture\n')
        with self.assertRaises(ValueError):verify(self.kit)

    def test_credential_like_payload_is_refused(self):
        (self.kit/'example.txt').write_text('ghp_'+'A'*40)
        with self.assertRaises(ValueError):verify(self.kit)

    def test_modified_prepared_source_is_refused(self):
        prepare(self.target,self.kit);self.file.write_text('changed after prepare\n')
        with self.assertRaises(ValueError):prepare(self.target,self.kit)

if __name__=='__main__':unittest.main()
