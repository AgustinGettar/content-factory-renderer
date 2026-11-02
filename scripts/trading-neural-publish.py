#!/usr/bin/env python3
"""Atomically receive PRIVATE external learning artifacts; never train/write SQLite."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import tempfile
import time

VERSION = 'secondary-neural-publication-1.0.0'
ROOT = Path('/var/lib/lumi-trading/neural')
CURRENT = Path('/opt/lumi-trading/current')
ROLE_LIMITS = {'DATASET_CHECKPOINT': 64*1024*1024, 'TRAINING_CHECKPOINT': 64*1024*1024,
               'STATUS': 65536, 'MODEL': 131072, 'CANDIDATE': 131072}
ROLE_TARGETS = {'DATASET_CHECKPOINT': 'dataset-checkpoint.json',
                'TRAINING_CHECKPOINT': 'training-checkpoint.json', 'STATUS': 'status.json'}

def digest_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(65536), b''):
            digest.update(block)
    return digest.hexdigest()

def atomic_bytes(path, payload, uid=None, gid=None):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix='.'+path.name+'.', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        if uid is not None:
            os.fchown(fd, uid, gid)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        # Persist each rename before publishing dependent artifacts. In particular,
        # a withdrawal must survive a host failure before any replacement weights.
        descriptor = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        Path(temporary).unlink(missing_ok=True)

def atomic_copy(source, destination):
    """Checkpoints can be large: stream without exposing an incomplete generation."""
    destination = Path(destination)
    fd, temporary = tempfile.mkstemp(prefix='.'+destination.name+'.', dir=destination.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as target, Path(source).open('rb') as stream:
            shutil.copyfileobj(stream, target, length=65536)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, destination)
        descriptor = os.open(destination.parent, os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        Path(temporary).unlink(missing_ok=True)

def validate_model(path, role, revoked, now):
    envelope = json.loads(Path(path).read_text())
    if (envelope.get('version') != 'secondary-neural-artifact-1.0.0'
            or not isinstance(envelope.get('payload_json'), str)
            or hashlib.sha256(envelope['payload_json'].encode()).hexdigest() != envelope.get('sha256')):
        raise ValueError('NEURAL_PUBLICATION_MODEL_HASH')
    model = json.loads(envelope['payload_json'])
    domain = model.get('domain', {})
    if (model.get('version') != 'secondary-neural-model-1.0.0'
            or domain.get('mode') != 'PAPER' or domain.get('realTrading') is not False
            or domain.get('symbol') != 'PF_XBTUSD' or domain.get('ledger') != 'FREQUENT_PAPER'
            or domain.get('entry_revision') != 'secondary-entry-useful-margin-1.0.0'
            or domain.get('exit_policy_version') != 'secondary-net-trailing-1.0.0'):
        raise ValueError('NEURAL_PUBLICATION_MODEL_DOMAIN')
    if model.get('model_id') in revoked:
        raise ValueError('NEURAL_PUBLICATION_MODEL_REVOKED')
    if (not isinstance(model.get('trained_at'), int) or not isinstance(model.get('expires_at'), int)
            or model['trained_at'] > now+10000 or model['expires_at'] <= now):
        raise ValueError('NEURAL_PUBLICATION_MODEL_TIME')
    if model.get('validation', {}).get('status') in ['REJECTED', 'FAILED']:
        raise ValueError('NEURAL_PUBLICATION_MODEL_REJECTED')
    return {'model_id': model['model_id'], 'sha256': envelope['sha256'], 'domain': domain,
            'role': role, 'trained_at': model['trained_at']}

def validate_runtime_models(files, current, now):
    """Use the exact deployed, bounded parser; no trainer or third-party Python."""
    payloads = [files[role].read_text() for role in ('MODEL', 'CANDIDATE') if role in files]
    if not payloads:
        return
    program = """
import {parseNeuralArtifact} from './lib/trading/secondary-neural-runtime.js';
let input='';
try {
 for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>600000)throw Error('NEURAL_PUBLICATION_VALIDATION_SIZE');}
 const {artifacts,now}=JSON.parse(input);
 if(!Array.isArray(artifacts)||artifacts.length>2)throw Error('NEURAL_PUBLICATION_VALIDATION_SIZE');
 for(const text of artifacts)parseNeuralArtifact(text,{now});
 console.log(JSON.stringify({valid:true}));
}catch(error){console.log(JSON.stringify({valid:false,reason:error.code??'NEURAL_PUBLICATION_RUNTIME_REJECTED'}));process.exitCode=1;}
"""
    try:
        node = '/usr/bin/node-24' if Path('/usr/bin/node-24').is_file() else 'node'
        checked = subprocess.run([node, '--max-old-space-size=64', '--input-type=module', '-e', program],
                                 cwd=current, input=json.dumps({'artifacts': payloads, 'now': now}),
                                 capture_output=True, text=True, timeout=5, check=False)
        result = json.loads(checked.stdout)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
        raise ValueError('NEURAL_PUBLICATION_RUNTIME_VALIDATION_UNAVAILABLE') from error
    if checked.returncode or result.get('valid') is not True:
        reason = result.get('reason', '')
        if not re.fullmatch('NEURAL_[A-Z_]{1,100}', reason):
            reason = 'NEURAL_PUBLICATION_RUNTIME_REJECTED'
        raise ValueError(reason)

def publish(stage, *, expected_commit, root=ROOT, current=CURRENT, mode='PAPER', owner='lumitrading', now=None):
    if mode != 'PAPER':
        raise ValueError('NEURAL_PUBLICATION_PAPER_ONLY')
    if not re.fullmatch('[a-f0-9]{40}', expected_commit):
        raise ValueError('NEURAL_PUBLICATION_EXACT_RELEASE_REQUIRED')
    head = subprocess.run(['git', '-C', str(current), 'rev-parse', 'HEAD'],
                          capture_output=True, text=True, check=True, timeout=5).stdout.strip()
    if head != expected_commit:
        raise ValueError('NEURAL_PUBLICATION_RELEASE_CHANGED')
    stage, root = Path(stage).resolve(), Path(root).resolve()
    source = stage / 'publication-manifest.json'
    if source.stat().st_size > 65536:
        raise ValueError('NEURAL_PUBLICATION_MANIFEST_SIZE')
    raw = source.read_bytes()
    manifest = json.loads(raw)
    now = int(time.time()*1000) if now is None else now
    if (manifest.get('version') != VERSION or manifest.get('mode') != 'PAPER'
            or manifest.get('realTrading') is not False or not isinstance(manifest.get('created_at'), int)
            or manifest['created_at'] > now+10000 or now-manifest['created_at'] > 86400000):
        raise ValueError('NEURAL_PUBLICATION_MANIFEST_INVALID')
    items = manifest.get('files')
    if not isinstance(items, list) or not 3 <= len(items) <= 5:
        raise ValueError('NEURAL_PUBLICATION_FILE_LIMIT')
    files, models = {}, {}
    for item in items:
        role, name = item.get('role'), item.get('name')
        if (role not in ROLE_LIMITS or role in files or not isinstance(name, str)
                or not re.fullmatch('[A-Za-z0-9_.:-]{1,180}\\.json', name)
                or (stage/name).resolve().parent != stage or (stage/name).is_symlink()):
            raise ValueError('NEURAL_PUBLICATION_FILE_SCOPE')
        path = stage/name
        size = path.stat().st_size
        if not 0 < size <= ROLE_LIMITS[role] or size != item.get('bytes') or digest_file(path) != item.get('sha256'):
            raise ValueError('NEURAL_PUBLICATION_FILE_INTEGRITY')
        files[role] = path
    if not all(role in files for role in ROLE_TARGETS):
        raise ValueError('NEURAL_PUBLICATION_CHECKPOINTS_REQUIRED')
    status = json.loads(files['STATUS'].read_text())
    if (status.get('version') != 'secondary-neural-training-status-1.0.0'
            or status.get('mode') != 'PAPER' or status.get('realTrading') is not False
            or not isinstance(status.get('at'), int) or status['at'] > now+10000):
        raise ValueError('NEURAL_PUBLICATION_STATUS_INVALID')
    revoked = status.get('revoked_model_ids', [])
    if not isinstance(revoked, list) or len(revoked) > 256 or any(not isinstance(x, str) or len(x) > 128 for x in revoked):
        raise ValueError('NEURAL_PUBLICATION_REVOCATION_LIMIT')
    for role in ['MODEL', 'CANDIDATE']:
        if role in files:
            models[role] = validate_model(files[role], role, revoked, now)
    if ('MODEL' in models and manifest.get('model_id') != models['MODEL']['model_id']
            or 'CANDIDATE' in models and manifest.get('candidate_id') != models['CANDIDATE']['model_id']):
        raise ValueError('NEURAL_PUBLICATION_MODEL_POINTER')
    validate_runtime_models(files, current, now)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    identity = pwd.getpwnam(owner) if owner else None
    uid, gid = (identity.pw_uid, identity.pw_gid) if identity else (None, None)
    if uid is not None:
        os.chown(root, uid, gid)
    publication_id = hashlib.sha256(raw).hexdigest()
    with (root/'publish.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        pointer = root/'publication.json'
        old = json.loads(pointer.read_text()) if pointer.exists() else None
        if old and old.get('publication_id') == publication_id:
            return {**old, 'replayed': True}
        prior_status = root/'status.json'
        if prior_status.exists():
            if prior_status.stat().st_size > ROLE_LIMITS['STATUS']:
                raise ValueError('NEURAL_PUBLICATION_PRIOR_STATUS_SIZE')
            prior_revoked = json.loads(prior_status.read_text()).get('revoked_model_ids', [])
            if not set(prior_revoked).issubset(revoked):
                raise ValueError('NEURAL_PUBLICATION_REVOCATION_REGRESSION')
        if old and manifest['created_at'] < old['at']:
            raise ValueError('NEURAL_PUBLICATION_STALE_RESULT')
        source_meta = manifest.get('source', {})
        if (old and source_meta.get('source_id') == old.get('source', {}).get('source_id')
                and int(source_meta.get('cursor', 0)) < int(old['source'].get('cursor', 0))):
            raise ValueError('NEURAL_PUBLICATION_CURSOR_REGRESSION')
        external = root/'external'
        external.mkdir(mode=0o700, exist_ok=True)
        if shutil.disk_usage(root).free < sum(files[role].stat().st_size for role in ROLE_TARGETS)+16*1024*1024:
            raise ValueError('NEURAL_PUBLICATION_STORAGE_LOW')
        generation = external/publication_id
        generation.mkdir(mode=0o700, exist_ok=True)
        for role, target in ROLE_TARGETS.items():
            destination = generation/target
            if destination.exists():
                if digest_file(destination) != digest_file(files[role]):
                    raise ValueError('NEURAL_IMMUTABLE_GENERATION_CONFLICT')
            else:
                atomic_copy(files[role], destination)
        atomic_bytes(generation/'publication-manifest.json', raw)
        for directory in (generation, external):
            descriptor = os.open(directory, os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        # A withdrawal is durable before any model replacement. The worker reads
        # this status before loading artifacts, so an interrupted import cannot
        # resurrect a model invalidated by a corrected training label.
        atomic_bytes(root/'status.json', files['STATUS'].read_bytes(), uid, gid)
        for role, target in [('MODEL', 'model.json'), ('CANDIDATE', 'candidate.json')]:
            if role not in files:
                if role == 'CANDIDATE':
                    (root/target).unlink(missing_ok=True)
                continue
            if role == 'MODEL' and (root/target).exists():
                try:
                    validate_model(root/target, role, revoked, now)
                    atomic_bytes(root/'last-good.json', (root/target).read_bytes(), uid, gid)
                except (ValueError, KeyError, json.JSONDecodeError):
                    pass
            atomic_bytes(root/target, files[role].read_bytes(), uid, gid)
        result = {'version': VERSION, 'publication_id': publication_id, 'mode': 'PAPER',
                  'realTrading': False, 'at': now, 'release': head, 'source': source_meta,
                  'checkpoint_directory': str(generation), 'models': models,
                  'checkpoint_files': [dict(role=role, name=target,
                                            bytes=files[role].stat().st_size,
                                            sha256=digest_file(files[role]))
                                       for role, target in ROLE_TARGETS.items()],
                  'status': status.get('status'), 'replayed': False}
        atomic_bytes(pointer, (json.dumps(result, separators=(',', ':'))+'\n').encode(), uid, gid)
        descriptor = os.open(root, os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        # Keep two complete checkpoint generations; all model-attempt manifests
        # and processed label hashes remain in each cumulative private checkpoint.
        keep = {publication_id, old.get('publication_id') if old else None}
        for directory in external.iterdir():
            if directory.is_dir() and re.fullmatch('[a-f0-9]{64}', directory.name) and directory.name not in keep:
                shutil.rmtree(directory)
        return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', required=True)
    parser.add_argument('--expected-commit', required=True)
    parser.add_argument('--mode', default='PAPER')
    args = parser.parse_args()
    print(json.dumps(publish(args.stage, expected_commit=args.expected_commit, mode=args.mode)))

if __name__ == '__main__':
    main()
