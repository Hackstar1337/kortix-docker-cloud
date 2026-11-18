#!/usr/bin/env python3
"""Plan by default; apply only to an explicitly selected self-host instance."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request
from verify import ROOT, verify


def command(args, *, data=None):
    completed=subprocess.run(args,input=data,capture_output=True,text=True)
    if completed.returncode:
        # Provider/compose diagnostics may contain sensitive data: never echo them.
        raise RuntimeError('Command failed: '+args[0]+' '+args[1]+' (diagnostics withheld to protect secrets)')
    return completed.stdout


def inspect(name):
    try:return json.loads(command(['docker','inspect',name]))[0]
    except RuntimeError:return None


def parse_credentials(path):
    values={}
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        key,sep,value=line.partition('=')
        if sep and key in ('DOCKER_CLOUD_USERNAME','DOCKER_CLOUD_PAT'):
            values[key]=value.strip().strip('"').strip("'")
    if not all(values.get(k) for k in ('DOCKER_CLOUD_USERNAME','DOCKER_CLOUD_PAT')):
        raise ValueError('Credential file needs Docker ID and Cloud-enabled PAT')
    if any('\n' in v or '\r' in v for v in values.values()):raise ValueError('Invalid credential format')
    return values


def private_write(path, content):
    path.write_text(content,encoding='utf-8');os.chmod(path,0o600)


def healthy(url):
    try:
        with urllib.request.urlopen(url,timeout=10) as response:return response.status==200
    except Exception:return False


def restore(backup):
    metadata=json.loads((backup/'deployment.json').read_text())
    instance=Path(metadata['instance'])
    rollback=backup/'rollback-compose.json'
    command(['docker','compose','--project-name',metadata['project'],'--env-file',str(instance/'.env'),'-f',str(instance/'docker-compose.yml'),'-f',str(rollback),'up','-d','--no-deps','kortix-api'])
    updater=metadata.get('updater')
    if updater:
        command(['docker','update','--restart='+updater['restart'],updater['name']])
        if updater['running']:command(['docker','start',updater['name']])
    print('Original API restored. Database, retained Cloud volumes and user storage were not deleted.')


def deploy(args):
    verify()
    instance=args.instance_dir.resolve()
    if not (instance/'docker-compose.yml').is_file() or not (instance/'.env').is_file():
        raise ValueError('Select an existing self-host instance with docker-compose.yml and .env')
    if instance.is_symlink():raise ValueError('Instance directory must not be a symlink')
    api_name=args.project+'-kortix-api-1';db_name=args.project+'-supabase-db-1'
    api=inspect(api_name)
    if not api or not inspect(db_name):raise ValueError('Expected API/database containers are missing')
    if args.expected_base_image and api['Image']!=args.expected_base_image:raise ValueError('Live base image does not match the expected image ID')
    image=json.loads(command(['docker','image','inspect',args.image]))[0]
    if image.get('Os')!='linux' or image.get('Architecture')!='amd64':raise ValueError('Only Linux amd64 has been tested')
    updater_name=args.project+'-kortix-updater-1';updater=inspect(updater_name)
    env=dict(v.split('=',1) for v in api['Config']['Env'])
    allowed=[p.strip() for p in env.get('ALLOWED_SANDBOX_PROVIDERS','platinum').split(',') if p.strip()]
    providers=list(dict.fromkeys((allowed or ['platinum'])+['docker-cloud']))
    plan={'apply':args.apply,'project':args.project,'image':args.image,'provider_order':providers,'changes':['private credential file','additive provider enum','API-only compose overlay','pause stock updater','health verification with rollback'],'deletes_user_data':False}
    print(json.dumps(plan,indent=2))
    if not args.apply:return
    if not args.credentials:raise ValueError('--apply requires --credentials; never pass the PAT as a command argument')
    credentials=parse_credentials(args.credentials)
    if updater and not args.stop_updater:raise ValueError('Custom API fork requires explicit --stop-updater acknowledgment')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup=instance/'docker-cloud-backups'/stamp;backup.mkdir(parents=True,mode=0o700);os.chmod(backup.parent,0o700)
    shutil.copyfile(instance/'docker-compose.yml',backup/'docker-compose.yml')
    shutil.copyfile(instance/'.env',backup/'original.env');os.chmod(backup/'original.env',0o600)
    metadata={'instance':str(instance),'project':args.project,'original_image':api['Image'],'updater':({'name':updater_name,'restart':updater['HostConfig']['RestartPolicy']['Name'],'running':updater['State']['Running']} if updater else None)}
    private_write(backup/'deployment.json',json.dumps(metadata,indent=2))
    private_write(backup/'rollback-compose.json',json.dumps({'services':{'kortix-api':{'image':api['Image'],'pull_policy':'never'}}},indent=2))
    creds=instance/'.docker-cloud.env'
    private_write(creds,''.join(k+'='+v+'\n' for k,v in credentials.items()))
    overlay=instance/'docker-compose.docker-cloud.json'
    private_write(overlay,json.dumps({'services':{'kortix-api':{'image':args.image,'pull_policy':'never','env_file':[str(creds)],'environment':{'ALLOWED_SANDBOX_PROVIDERS':','.join(providers),'DOCKER_CLOUD_LIFETIME_MINUTES':'60','DOCKER_CLOUD_RENEW_BEFORE_MINUTES':'20'}}}},indent=2))
    compose=['docker','compose','--project-name',args.project,'--env-file',str(instance/'.env'),'-f',str(instance/'docker-compose.yml'),'-f',str(overlay)]
    changed=False
    try:
        command(compose+['config','--quiet'])
        sql=(ROOT/'overlay/packages/db/migrations/20261117221000000_sandbox_provider_add_docker_cloud.sql').read_text()
        command(['docker','exec','-i',db_name,'psql','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],data=sql)
        changed=True
        if updater:
            command(['docker','update','--restart=no',updater_name]);command(['docker','stop',updater_name])
        command(compose+['up','-d','--no-deps','kortix-api'])
        for _ in range(60):
            current=inspect(api_name)
            if current and current['State'].get('Health',{}).get('Status')=='healthy' and healthy(args.api_url) and healthy(args.frontend_url):
                print('API overlay healthy. Private rollback backup: '+str(backup));return
            time.sleep(2)
        raise RuntimeError('API/frontend health gate did not pass')
    except Exception:
        if changed:restore(backup)
        raise


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--instance-dir',type=Path)
    parser.add_argument('--project')
    parser.add_argument('--image')
    parser.add_argument('--expected-base-image',help='Optional exact live image ID guard')
    parser.add_argument('--credentials',type=Path,help='Private backend Docker credential file')
    parser.add_argument('--api-url',default='http://localhost:13738/v1/health')
    parser.add_argument('--frontend-url',default='http://localhost:13737/')
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--stop-updater',action='store_true')
    parser.add_argument('--rollback',type=Path,help='Private backup directory; stop Cloud sessions before rollback')
    args=parser.parse_args()
    try:
        if args.rollback:restore(args.rollback.resolve());return
        if not all((args.instance_dir,args.project,args.image)):parser.error('select --instance-dir, --project and --image explicitly')
        deploy(args)
    except (ValueError,RuntimeError,OSError) as error:
        print('Deployment refused/failed: '+str(error),file=sys.stderr);sys.exit(1)

if __name__=='__main__':main()
