#!/usr/bin/env python3
"""Local sidecar double for controller safety tests. No keys or network access."""
import hashlib
import json
from pathlib import Path
import sys

args = sys.argv[1:]
secret = json.loads(sys.stdin.readline()) if '--input-stdin' in args else {}
scenario_file = Path(__file__).with_name('scenario.json')
scenario = json.loads(scenario_file.read_text()) if scenario_file.exists() else {}
def option(name): return args[args.index(name) + 1] if name in args else None
def reply(value):
    if '--json' in args: value = {'schema_version': 1, **value}
    print(json.dumps(value)); sys.exit(0)
def fail(code):
    value = {'code': code, 'message': 'Simulated sidecar failure'}
    print(json.dumps(value if '--json' in args else {'error': value}), file=sys.stderr if '--json' in args else sys.stdout)
    sys.exit(1)

def wallet_address():
    identity = json.loads(Path(option('--file')).read_text())['identity']
    return identity + '-account-' + option('--account') + ('-pass-' + secret['passphrase'] if secret.get('passphrase') else '')
if 'address' in args: reply({'address':wallet_address()})
if 'addresses' in args: reply({'addresses':[wallet_address()]})
if 'send' in args:
    path = Path(option('--transaction'))
    path.write_text(json.dumps({'target':option('--target'), 'amount':option('--amount'), 'id':path.stem,'sender':wallet_address(),'inputs':[{'address':wallet_address()}]}))
    reply({'transaction_id':hashlib.sha256(path.read_bytes()).hexdigest(), 'target':option('--target'), 'amount':option('--amount'), 'fee':'0.001', 'max_fee_atomic':'5001300', 'expires_height':1100, 'network':'mainnet'})
if 'broadcast' in args: fail('rpc_transport_error')
if 'transaction' in args: reply(scenario.get('transaction', {'status':'unknown','confirmations':0}))
if 'key' in args and 'import' in args:
    Path(__file__).with_name('ghost-args.json').write_text(json.dumps(args))
    Path(__file__).with_name('ghost-stdin.txt').write_bytes(sys.stdin.buffer.read())
    if scenario.get('import_exists') and '--replace' not in args: fail('account_key_exists')
    replaced = '--replace' in args and scenario.get('import_exists')
    reply({'seed_file':option('--seed-file'),'result':'replaced' if replaced else 'imported','keys':{'deposit_memo':'old-memo'},'account':None,'account_note':'this key has no account yet',**({'replaced_file':option('--seed-file')+'.replaced-20261019T120000Z'} if replaced else {})})
if 'inspect' in args:
    memo = scenario.get('new_memo','old-memo') if option('--seed-file') == scenario.get('replacement_seed') else 'old-memo'
    reply({'recovery_key_fingerprint':scenario.get('recovery_fingerprint','older-key'), 'deposit_memo':memo})
if 'show' in args:
    memo = scenario.get('new_memo','old-memo') if option('--seed-file') == scenario.get('replacement_seed') else 'old-memo'
    reply({'account_alias':'gh-test','key_epoch':1,'deposit_memo':memo})
if 'set-password' in args:
    Path(__file__).with_name('ghost-args.json').write_text(json.dumps(args))
    if scenario.get('fail_password'): fail('signed_request_required')
    days = option('--expires-in')
    reply({'account_alias':'gh-test','password':'Abcd-2345.efgh!?','created_at':'2026-10-13T09:00:00Z','expires_at':None if days is None else '2027-01-11T09:00:00Z','note':'The password is shown only this once.'})
if 'remove-password' in args:
    Path(__file__).with_name('ghost-args.json').write_text(json.dumps(args))
    reply({'removed':True})
if 'signup' in args or 'link-github' in args or 'unlink-github' in args or 'github-status' in args:
    Path(__file__).with_name('ghost-args.json').write_text(json.dumps(args))
    if 'unlink-github' in args: reply({'unlinked':True,'ended_sessions':1})
    if 'signup' in args or 'link-github' in args: reply({'claim_id':'claim-one','claim_url':scenario.get('claim_url','https://gigahost.cloud/trial/start?claim=claim-one'),'expires_at':'2026-10-16T12:10:00Z'})
    reply({'status':scenario.get('claim_status','pending'),'account_alias':None,'reason':None,'expires_at':'2026-10-16T12:10:00Z'})
if 'offering' in args: reply(scenario['offering'])
if 'approve' in args:
    if '--yes' not in args: reply({'request':{'operation':scenario['operation'],'started_job_id':scenario.get('started_job_id')}})
    if not option('--recovery-seed-file'): fail('recovery_key_missing')
    if scenario.get('fail_authorization'): fail('destination_unavailable')
    reply({'job_id':'job-one'})
fail('unexpected_test_command')
