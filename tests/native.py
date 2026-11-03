#!/usr/bin/env python3
"""Desktop controller contract tests: real bundled CLIs, disposable keys, local RPC/API.

python3 tests/native.py --driver src-tauri/target/debug/desktop-driver \
    --ghost /path/to/ghost --wallet /path/to/mmxwallet
"""
import argparse
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import tempfile
import threading
import time
import unittest
import uuid
from urllib.parse import urlsplit

ARGS = None
NATIVE = 'mmx1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqdgytev'

class Service(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def reply(self, value, status=200):
        data = b'' if status == 204 else json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        path=urlsplit(self.path).path
        self.server.requests.append(('GET',path,self.headers.get('x-gigahost-auth-key-id')))
        if path == '/chain/info': return self.reply({'network':'mainnet','decimals':6})
        if path == '/node/info': return self.reply({'name':'mainnet','height':1000,'is_synced':True})
        if path == '/address': return self.reply({'balances':[{'contract':NATIVE,'amount':'10000000','decimals':6,'symbol':'MMX'}]})
        if path == '/address/history': return self.reply([])
        if path == '/transaction': return self.reply(self.server.transaction,204 if self.server.transaction is None else 200)
        if path == '/v1/account/activation-terms': return self.reply({'deposit_address':self.server.address,'minimum_deposit_mmx_atomic':1000000,'minimum_confirmations':6,'mmx_exchange_rate':self.server.exchange_rate})
        if path in ['/v1/account','/v1/account/balance','/v1/account/deposits','/v1/provider/balance','/v1/provider/payouts'] and not self.server.activated:
            return self.reply({'code':'account_not_activated','message':'This account key has not been activated'},401)
        if path == '/v1/account':
            if self.server.new_key_id and self.headers.get('x-gigahost-auth-key-id') == self.server.new_key_id and not self.server.migrated: return self.reply({'code':'account_not_activated','message':'This account key has not been activated'},401)
            return self.reply({'account_alias':'gh-disposable-test','deposit_memo':(self.server.new_memo or self.server.memo) if self.server.migrated else self.server.memo,'key_epoch':2 if self.server.migrated else 1,'status':'active'})
        if path == '/v1/account/balance': return self.reply({'available_microusd':123450000,'reserved_microusd':0,'total_microusd':123450000,'funding_status':None,'provider_credits':[]})
        if path.startswith('/v1/account/operation-intents/'): return self.reply(self.server.intent)
        if path.startswith('/v1/backups/'): return self.reply(self.server.backup)
        if path.startswith('/v1/instances/'): return self.reply(self.server.instance)
        if path.startswith('/v1/jobs/'): return self.reply(self.server.job)
        if path == '/v1/account/deposits': return self.reply({'items':[],'next_cursor':None})
        if path == '/v1/provider/balance': return self.reply(self.server.provider_balance)
        if path == '/v1/provider/payouts': return self.reply(self.server.payouts)
        return self.reply({'code':'not_found','message':'not found'},404)
    def do_PUT(self):
        path=urlsplit(self.path).path
        raw=self.rfile.read(int(self.headers.get('Content-Length','0')))
        value=json.loads(raw) if raw else {}
        self.server.requests.append(('PUT',path,raw))
        if path == '/api/mut/v1/provider/payout-address':
            self.server.address_writes.append((value,self.headers.get('x-gigahost-auth-key-id')))
            self.server.provider_balance['payout_address']=value['address']
            if self.server.drop_address:
                self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
            return self.reply({'address':value['address'],'updated_at':'2026-10-07T00:00:00Z'})
        return self.reply({'code':'not_found','message':'not found'},404)
    def do_POST(self):
        path=urlsplit(self.path).path
        raw=self.rfile.read(int(self.headers.get('Content-Length','0')))
        value=json.loads(raw) if raw else {}
        self.server.requests.append(('POST',path,raw))
        if path == '/api/mut/v1/provider/payouts':
            key=self.headers.get('Idempotency-Key')
            self.server.payout_requests.append((key,value,self.headers.get('x-gigahost-auth-key-id')))
            if self.server.payout_refusal:
                code,message,status=self.server.payout_refusal
                return self.reply({'code':code,'message':message},status)
            payout=self.server.payout_by_key.get(key)
            if payout is None:
                amount=value['amount_microusd']
                payout={'payout_id':str(uuid.uuid4()),'destination_address':self.server.provider_balance['payout_address'],'amount_microusd':amount,'amount_mmx_atomic':None,'state':'queued','chain_transaction_id':None,'requested_at':'2026-10-07T00:00:00Z','submitted_at':None,'confirmed_at':None,'last_error':None,'waiting_reason':None}
                self.server.payout_by_key[key]=payout
                self.server.payouts.insert(0,payout)
                self.server.provider_balance['available_payout_microusd']-=amount
                self.server.provider_balance['on_the_way_microusd']+=amount
            if self.server.drop_payout:
                self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
            return self.reply(payout,202)
        if path == '/transaction/validate': return self.reply({'did_fail':False,'total_fee':'1300'})
        if path == '/transaction/broadcast':
            self.server.broadcasts.append(raw)
            if self.server.drop_broadcast:
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            return self.reply({})
        if path.startswith('/api/mut/v1/account/operation-intents/') and path.endswith('/complete'):
            self.server.intent['completed_job_id']=value['job_id']
            return self.reply(self.server.intent)
        if path == '/api/mut/v1/account/login': return self.reply({'login_url':self.server.login_url,'expires_at':'2099-01-01T00:00:00Z'})
        if path == '/api/mut/v1/account/activate':
            if not self.server.activation_confirmed:
                return self.reply({'code':'invalid_request','message':'confirmed MMX deposits total 0 atomic units; activation requires 1000000'},400)
            self.server.activated=True
            return self.reply({'account_alias':'gh-disposable-test','deposit_memo':self.server.memo,'key_epoch':1,'status':'active'})
        if path == '/api/mut/v1/account/migrate-seed':
            if self.server.reject_migration:
                self.server.reject_migration=False
                return self.reply({'code':'account_unavailable','message':'Try the saved rotation again'},503)
            self.server.migrated=True
            if self.server.drop_migration:
                self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
            return self.reply({'account_alias':'gh-disposable-test','deposit_memo':(self.server.new_memo or self.server.memo) if self.server.migrated else self.server.memo,'key_epoch':2,'status':'active'})
        return self.reply({'code':'not_found','message':'not found'},404)

class Desktop(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='ghostrack-desktop-test-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        class LocalServer(http.server.ThreadingHTTPServer):
            request_queue_size=128
        self.server=LocalServer(('127.0.0.1',0),Service)
        self.server.requests=[]; self.server.broadcasts=[]; self.server.transaction=None
        self.server.activated=True; self.server.activation_confirmed=True
        self.server.exchange_rate={'usd_per_mmx':'0.200000000000000000','expires_at':'2099-01-01T00:00:00Z'}
        self.server.reject_migration=False
        self.server.provider_balance={'pending_payout_microusd':90000000,'available_payout_microusd':65500001,'held_microusd':24499999,'on_the_way_microusd':0,'sla_settlement_pending':False,'payout_address':None}
        self.server.payouts=[]; self.server.payout_by_key={}; self.server.payout_requests=[]; self.server.address_writes=[]
        self.server.drop_payout=False; self.server.drop_address=False; self.server.payout_refusal=None
        self.server.drop_broadcast=False; self.server.drop_migration=False; self.server.migrated=False; self.server.new_key_id=None; self.server.new_memo=None
        self.server.login_url='https://ghostrack.io/login?token=disposable-secret'
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
        self.addCleanup(self.stop_server)
        self.url='http://127.0.0.1:'+str(self.server.server_port)
        self.env=dict(os.environ,HOME=str(self.root),MMX_HOME=str(self.root/'wallets'),XDG_CONFIG_HOME=str(self.root/'config'))
        self.wallet=self.root/"wallet ' $(touch should-not-exist) 世界.dat"
        self.seed=self.root/'custom account.seed'
        made=json.loads(subprocess.check_output([ARGS.wallet,'create','--file',str(self.wallet),'--json'],env=self.env,text=True))
        self.server.address=made['address']
        account=json.loads(subprocess.check_output([ARGS.ghost,'--compact','key','generate','--output',str(self.seed)],env=self.env,text=True))
        self.server.memo=account['keys']['deposit_memo']
        self.account_keys=account['keys']
        self.server.intent=None
        self.start_driver()
        settings={'wallet_file':str(self.wallet),'ghost_seed_file':str(self.seed),'recovery_seed_files':[],'rpc_url':self.url,'api_url':self.url,'website_url':'https://ghostrack.io','theme':'light','account_index':0,'num_addresses':1}
        self.request('save_settings',settings=settings)
    def stop_server(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
    def start_driver(self):
        self.driver=subprocess.Popen([ARGS.driver,str(self.root/'state'),ARGS.ghost,ARGS.wallet],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=self.env)
        self.addCleanup(self.stop_driver)
    def stop_driver(self):
        if self.driver.poll() is None: self.driver.terminate(); self.driver.wait(timeout=10)
        for stream in [self.driver.stdin,self.driver.stdout,self.driver.stderr]: stream.close()
    def request(self,action,error=None,**fields):
        self.driver.stdin.write(json.dumps({'action':action,**fields})+'\n'); self.driver.stdin.flush()
        line=self.driver.stdout.readline()
        if not line:
            self.fail('driver exited: '+self.driver.stderr.read())
        value=json.loads(line)
        if error:
            self.assertIn('error',value,value)
            if isinstance(error,str): self.assertEqual(value['error']['code'],error,value)
            return value['error']
        self.assertNotIn('error',value,value)
        return value['data']
    def prepare(self,**changes):
        args={'target':self.server.address,'amount':'1.000001','memo':'memo 世界','passphrase':None,'purpose':'send'}; args.update(changes)
        return self.request('prepare_send',**args)
    def test_real_cli_snapshot_and_independent_custom_paths(self):
        s=self.request('snapshot',passphrase=None)
        self.assertIsNotNone(s['wallet']['balance']['data'],s['wallet']['balance'])
        self.assertEqual(s['wallet']['balance']['data']['balances'][0]['amount'],'10')
        self.assertEqual(s['account_balance']['data']['available_microusd'],'123450000')
        self.assertEqual(s['activation_terms']['data']['mmx_exchange_rate'],self.server.exchange_rate)
        self.assertEqual(s['settings']['wallet_file'],str(self.wallet))
        self.assertEqual(s['ghost_seed_file'],str(self.seed))
        self.assertEqual(stat.S_IMODE((self.root/'state/operations.json').stat().st_mode) if (self.root/'state/operations.json').exists() else stat.S_IMODE((self.root/'state/settings.json').stat().st_mode),0o600)
        self.assertFalse((self.root/'should-not-exist').exists())
        self.server.exchange_rate=None
        self.assertIsNone(self.request('snapshot',passphrase=None)['activation_terms']['data']['mmx_exchange_rate'])
    def test_gui_activation_after_unregistered_key_response_and_pending_deposit(self):
        self.server.activated=False; self.server.activation_confirmed=False
        snapshot=self.request('snapshot',passphrase=None)
        for name in ['account','account_balance','deposits']:
            self.assertEqual(snapshot[name]['error']['code'],'account_not_activated')
        self.assertEqual(snapshot['activation_terms']['data']['minimum_confirmations'],6)
        op=self.prepare(purpose='activation',target='untrusted',memo='wrong',amount='1')
        self.assertEqual(op['review']['target'],self.server.address)
        self.assertEqual(op['review']['memo'],self.server.memo)
        self.request('broadcast',id=op['id'])
        pending=self.request('activate_account',error='activation_pending')
        self.assertIn('Check activation again',pending['message'])
        self.assertNotIn('ghost',pending['message'])
        self.server.activation_confirmed=True
        self.assertEqual(self.request('activate_account')['status'],'active')
        self.assertEqual(self.request('snapshot',passphrase=None)['account']['data']['status'],'active')
        self.assertEqual(len(self.server.broadcasts),1)
    def test_review_survives_restart_and_broadcasts_exact_bytes(self):
        op=self.prepare()
        self.assertEqual(self.server.broadcasts,[])
        saved=self.root/'state/transactions'/f"{op['id']}.json"
        raw=saved.read_bytes()
        self.assertEqual(stat.S_IMODE(saved.stat().st_mode),0o600)
        self.assertEqual(op['review']['amount_atomic'],'1000001')
        self.stop_driver(); self.start_driver()
        self.request('broadcast',id=op['id'])
        self.assertEqual(self.server.broadcasts,[raw])
        journal=(self.root/'state/operations.json').read_text()
        self.assertNotIn('seed_value',journal)
        self.assertNotIn('passphrase',journal)
    def test_real_cli_confirmation_counts_are_saved_across_restart(self):
        op=self.prepare()
        self.request('broadcast',id=op['id'])
        for confirmations in [1,9,10]:
            self.server.transaction={'id':op['transaction_id'],'height':1001-confirmations,'did_fail':False}
            status=self.request('payment_status',id=op['id'])
            self.assertEqual(status['status'],'included')
            self.assertEqual(status['confirmations'],confirmations)
            saved=self.request('snapshot',passphrase=None)['operations'][0]
            self.assertEqual(saved['confirmations'],confirmations)
        self.stop_driver(); self.start_driver()
        self.assertEqual(self.request('snapshot',passphrase=None)['operations'][0]['confirmations'],10)
        self.server.transaction['height']=989
        self.assertEqual(self.request('payment_status',id=op['id'])['confirmations'],12)
        self.assertEqual(len(self.server.broadcasts),1)
    def test_changed_signed_file_and_duplicate_drafts_are_rejected(self):
        op=self.prepare()
        self.prepare(error='payment_draft_exists')
        saved=self.root/'state/transactions'/f"{op['id']}.json"
        saved.write_bytes(saved.read_bytes()+b' ')
        self.request('broadcast',id=op['id'],error='payment_changed')
        self.assertEqual(self.server.broadcasts,[])
    def test_uncertain_submission_is_saved_and_retry_reuses_transaction(self):
        op=self.prepare(); self.server.drop_broadcast=True
        self.request('broadcast',id=op['id'],error='rpc_transport_error')
        self.assertEqual(self.request('snapshot',passphrase=None)['operations'][0]['state'],'uncertain')
        self.prepare(error='payment_pending')
        self.server.drop_broadcast=False
        self.request('broadcast',id=op['id'])
        self.assertEqual(len(self.server.broadcasts),2)
        self.assertEqual(self.server.broadcasts[0],self.server.broadcasts[1])
    def test_topup_uses_authoritative_destination_and_memo(self):
        op=self.prepare(purpose='top_up',target='untrusted',memo='wrong')
        self.assertEqual(op['review']['target'],self.server.address)
        self.assertEqual(op['review']['memo'],self.server.memo)
        self.assertEqual(op['account_epoch'],'1')
        self.server.migrated=True
        self.request('broadcast',id=op['id'],error='account_changed')
        self.assertEqual(self.server.broadcasts,[])
    def test_payout_address_is_validated_and_requires_confirmation(self):
        self.request('prepare_payout_address',address=self.server.address[:-1]+'q',error='invalid_payout_address')
        self.assertEqual(self.server.address_writes,[])
        op=self.request('prepare_payout_address',address='  '+self.server.address+'  ')
        self.assertEqual(op['review']['address'],self.server.address)
        self.assertEqual(self.server.address_writes,[])
        self.stop_driver(); self.start_driver()
        self.assertEqual(self.request('payout_review',id=op['id'])['state'],'prepared')
        self.assertEqual(self.request('confirm_payout',id=op['id'])['state'],'complete')
        self.request('confirm_payout',id=op['id'])
        self.assertEqual(self.server.address_writes,[({'address':self.server.address},self.account_keys['authentication_key_id'])])
        self.assertEqual(self.request('snapshot',passphrase=None)['provider_balance']['data']['payout_address'],self.server.address)
    def test_payout_reviews_freeze_exact_dollars_and_history_tracks_server_status(self):
        self.request('prepare_payout',amount='40.01',error='payout_address_required')
        self.server.provider_balance['payout_address']=self.server.address
        op=self.request('prepare_payout',amount='40.01')
        self.assertEqual(op['review']['amount_microusd'],'40010000')
        self.assertEqual(self.server.payout_requests,[])
        confirmed=self.request('confirm_payout',id=op['id'])
        self.assertEqual(confirmed['state'],'complete')
        self.assertEqual(confirmed['review']['result']['amount_microusd'],'40010000')
        self.request('confirm_payout',id=op['id'])
        self.assertEqual(self.server.payout_requests,[(op['id'],{'amount_microusd':40010000},self.account_keys['authentication_key_id'])])
        snapshot=self.request('snapshot',passphrase=None)
        self.assertEqual(snapshot['provider_balance']['data']['available_payout_microusd'],'25490001')
        self.assertEqual(snapshot['payouts']['data'][0]['state'],'queued')
        self.assertEqual(snapshot['account_balance']['data']['available_microusd'],'123450000')
        self.server.payouts[0].update(state='confirmed',amount_mmx_atomic=123000001,chain_transaction_id='a'*64,submitted_at='2026-10-07T00:01:00Z',confirmed_at='2026-10-07T00:02:00Z')
        history=self.request('snapshot',passphrase=None)['payouts']['data'][0]
        self.assertEqual(history['state'],'confirmed')
        self.assertEqual(history['amount_mmx_atomic'],'123000001')
    def test_all_available_payout_is_frozen_without_losing_microdollars(self):
        self.server.provider_balance.update(payout_address=self.server.address,available_payout_microusd=9007199254740993)
        op=self.request('prepare_payout',amount='')
        self.assertEqual(op['review']['amount_microusd'],'9007199254740993')
        self.server.provider_balance['available_payout_microusd']+=1000000
        self.request('confirm_payout',id=op['id'])
        self.assertEqual(self.server.payout_requests[0][1],{'amount_microusd':9007199254740993})
        self.assertEqual(self.request('snapshot',passphrase=None)['provider_balance']['data']['available_payout_microusd'],'1000000')
    def test_accepted_payout_with_lost_response_retries_once_across_restart(self):
        self.server.provider_balance['payout_address']=self.server.address
        op=self.request('prepare_payout',amount='')
        self.server.drop_payout=True
        self.request('confirm_payout',id=op['id'],error=True)
        self.assertEqual(self.request('payout_review',id=op['id'])['state'],'uncertain')
        self.request('prepare_payout',amount='1',error='payout_pending')
        self.request('discard_payout',id=op['id'],error='payout_state')
        self.stop_driver(); self.start_driver()
        self.server.drop_payout=False
        self.server.provider_balance['payout_address']=NATIVE
        result=self.request('confirm_payout',id=op['id'])
        self.assertEqual(result['state'],'complete')
        self.assertEqual(result['review']['result']['destination_address'],self.server.address)
        self.assertEqual(len(self.server.payouts),1)
        self.assertEqual(self.server.provider_balance['available_payout_microusd'],0)
        self.assertEqual([r[0] for r in self.server.payout_requests],[op['id'],op['id']])
        self.assertEqual([r[1] for r in self.server.payout_requests],[{'amount_microusd':65500001}]*2)
    def test_payout_rejection_shows_dollars_and_allows_discard(self):
        self.server.provider_balance['payout_address']=self.server.address
        op=self.request('prepare_payout',amount='1')
        self.server.payout_refusal=('invalid_request','payout must be between 5000000 and 5000000000 micro-USD',400)
        error=self.request('confirm_payout',id=op['id'],error='invalid_request')
        self.assertEqual(error['message'],'Request a payout between $5.00 and $5000.00.')
        self.assertEqual(self.request('payout_review',id=op['id'])['state'],'failed')
        self.request('discard_payout',id=op['id'])
        self.assertEqual(self.request('prepare_payout',amount='5')['state'],'prepared')
        self.assertEqual(self.server.payouts,[])
    def test_rejected_retry_cannot_release_an_already_accepted_payout(self):
        self.server.provider_balance['payout_address']=self.server.address
        op=self.request('prepare_payout',amount='40')
        self.server.drop_payout=True
        self.request('confirm_payout',id=op['id'],error=True)
        self.server.drop_payout=False
        self.server.payout_refusal=('account_unavailable','payouts are temporarily paused',403)
        error=self.request('confirm_payout',id=op['id'],error='account_unavailable')
        self.assertIn('saved review',error['message'])
        self.assertEqual(self.request('payout_review',id=op['id'])['state'],'uncertain')
        self.request('discard_payout',id=op['id'],error='payout_state')
        self.request('prepare_payout',amount='1',error='payout_pending')
        self.server.payout_refusal=None
        self.request('confirm_payout',id=op['id'])
        self.assertEqual(len(self.server.payouts),1)
    def test_payout_confirmation_refuses_changed_address_balance_or_key(self):
        self.server.provider_balance['payout_address']=self.server.address
        op=self.request('prepare_payout',amount='40')
        self.server.provider_balance['payout_address']=NATIVE
        self.request('confirm_payout',id=op['id'],error='payout_address_changed')
        self.server.provider_balance['payout_address']=self.server.address
        self.server.provider_balance['sla_settlement_pending']=True
        self.request('confirm_payout',id=op['id'],error='payout_balance_changed')
        self.server.provider_balance['sla_settlement_pending']=False
        self.server.provider_balance['available_payout_microusd']=0
        self.request('confirm_payout',id=op['id'],error='payout_balance_changed')
        self.server.provider_balance['available_payout_microusd']=65500001
        self.seed.unlink()
        subprocess.check_output([ARGS.ghost,'--compact','key','generate','--output',str(self.seed)],env=self.env,text=True)
        self.request('confirm_payout',id=op['id'],error='account_changed')
        self.assertEqual(self.server.payout_requests,[])
    def test_lost_address_change_response_reconciles_and_never_overwrites_newer_address(self):
        op=self.request('prepare_payout_address',address=self.server.address)
        self.server.drop_address=True
        self.request('confirm_payout',id=op['id'],error=True)
        self.server.drop_address=False
        self.stop_driver(); self.start_driver()
        self.assertEqual(self.request('confirm_payout',id=op['id'])['state'],'complete')
        self.assertEqual(len(self.server.address_writes),1)
        op=self.request('prepare_payout_address',address=NATIVE)
        self.server.drop_address=True
        self.request('confirm_payout',id=op['id'],error=True)
        self.server.provider_balance['payout_address']=None
        self.server.drop_address=False
        self.request('confirm_payout',id=op['id'],error='payout_address_changed')
        self.assertEqual(self.request('payout_review',id=op['id'])['state'],'failed')
        self.assertEqual(self.request('discard_payout',id=op['id'])['state'],'discarded')
        self.assertEqual(len(self.server.address_writes),2)
        self.assertIsNone(self.server.provider_balance['payout_address'])
    def test_uncertain_payout_cannot_retry_after_backend_replay_retention(self):
        self.server.provider_balance['payout_address']=self.server.address
        op=self.request('prepare_payout',amount='40')
        self.server.drop_payout=True
        self.request('confirm_payout',id=op['id'],error=True)
        path=self.root/'state/operations.json'
        journal=json.loads(path.read_text())
        journal[0]['review']['first_requested_at']=int(time.time())-30*86400
        path.write_text(json.dumps(journal))
        self.server.drop_payout=False
        self.request('confirm_payout',id=op['id'],error='payout_retry_expired')
        self.assertEqual(len(self.server.payout_requests),1)
        self.assertEqual(self.request('payout_review',id=op['id'])['state'],'uncertain')
    def test_verified_rotation_keeps_the_same_uncertain_payout_request(self):
        self.server.provider_balance['payout_address']=self.server.address
        payout=self.request('prepare_payout',amount='40')
        self.server.drop_payout=True
        self.request('confirm_payout',id=payout['id'],error=True)
        replacement=self.root/'replacement.seed'
        rotation=self.request('prepare_rotation',file=str(replacement))
        self.server.new_key_id=rotation['review']['replacement']['keys']['authentication_key_id']
        self.server.new_memo=rotation['review']['replacement']['keys']['deposit_memo']
        self.request('rotate_keys',id=rotation['id'])
        saved=self.request('payout_review',id=payout['id'])
        self.assertEqual(saved['ghost_seed_file'],str(replacement))
        self.assertEqual(saved['account_memo'],self.server.new_memo)
        self.assertEqual(saved['review'],payout['review'] | {'first_requested_at':saved['review']['first_requested_at']})
        self.server.drop_payout=False
        self.request('confirm_payout',id=payout['id'])
        self.assertEqual(len(self.server.payouts),1)
        self.assertEqual([r[0] for r in self.server.payout_requests],[payout['id']]*2)
        self.assertEqual(self.server.payout_requests[-1][2],self.server.new_key_id)
    def test_login_origin_is_checked_and_rotation_preserves_old_seed(self):
        self.server.login_url='https://evil.example/login?token=disposable-secret'
        self.request('login',error='invalid_login')
        old=self.seed.read_bytes(); replacement=self.root/'replacement.seed'
        op=self.request('prepare_rotation',file=str(replacement))
        self.server.new_key_id=op['review']['replacement']['keys']['authentication_key_id']
        self.server.new_memo=op['review']['replacement']['keys']['deposit_memo']
        self.request('reconcile_rotation',id=op['id'],error='account_not_activated')
        backup=self.root/'replacement-backup.seed'
        self.request('export_replacement_key',id=op['id'],destination=str(backup))
        self.assertEqual(backup.read_bytes(),replacement.read_bytes())
        self.request('rotate_keys',id=op['id'])
        s=self.request('snapshot',passphrase=None)
        self.assertEqual(s['settings']['ghost_seed_file'],str(replacement))
        self.assertIn(str(self.seed),s['settings']['recovery_seed_files'])
        self.assertEqual(self.seed.read_bytes(),old)
    def test_lost_rotation_response_reconciles_without_another_migration(self):
        replacement=self.root/'replacement.seed'
        op=self.request('prepare_rotation',file=str(replacement))
        self.server.new_key_id=op['review']['replacement']['keys']['authentication_key_id']
        self.server.new_memo=op['review']['replacement']['keys']['deposit_memo']
        self.server.drop_migration=True
        self.request('rotate_keys',id=op['id'],error=True)
        self.assertEqual(self.request('snapshot',passphrase=None)['operations'][0]['state'],'uncertain')
        self.request('rotate_keys',id=op['id'])
        s=self.request('snapshot',passphrase=None)
        self.assertEqual(s['settings']['ghost_seed_file'],str(replacement))
        self.assertEqual(s['operations'][0]['state'],'complete')
        migrations=[r for r in self.server.requests if r[:2] == ('POST','/api/mut/v1/account/migrate-seed')]
        self.assertEqual(len(migrations),1)
    def test_uncertain_rotation_can_retry_an_unactivated_replacement(self):
        op=self.request('prepare_rotation',file=str(self.root/'replacement.seed'))
        self.server.new_key_id=op['review']['replacement']['keys']['authentication_key_id']
        self.server.new_memo=op['review']['replacement']['keys']['deposit_memo']
        self.server.reject_migration=True
        self.request('rotate_keys',id=op['id'],error='account_unavailable')
        self.assertEqual(self.request('snapshot',passphrase=None)['operations'][0]['state'],'uncertain')
        self.request('rotate_keys',id=op['id'])
        self.assertEqual(self.request('snapshot',passphrase=None)['operations'][0]['state'],'complete')
        migrations=[r for r in self.server.requests if r[:2] == ('POST','/api/mut/v1/account/migrate-seed')]
        self.assertEqual(len(migrations),2)
    def test_changed_replacement_seed_is_not_migrated(self):
        replacement=self.root/'replacement.seed'
        op=self.request('prepare_rotation',file=str(replacement))
        other=self.root/'other.seed'
        subprocess.check_output([ARGS.ghost,'--compact','key','generate','--output',str(other)],env=self.env)
        replacement.write_bytes(other.read_bytes())
        self.request('rotate_keys',id=op['id'],error='replacement_changed')
        self.assertFalse(self.server.migrated)
    def test_payment_is_bound_to_derivation_account(self):
        op=self.prepare()
        settings=self.request('snapshot',passphrase=None)['settings']
        settings['account_index']=1
        self.request('save_settings',settings=settings)
        self.request('broadcast',id=op['id'],error='wallet_changed')
        self.assertEqual(self.server.broadcasts,[])
    def restore_fixture(self):
        intent,backup,instance,job=[str(uuid.uuid4()) for _ in range(4)]
        date='2026-10-04T00:00:00Z'
        self.server.intent={'intent_id':intent,'operation':{'kind':'restore_backup','instance_id':instance,'backup_id':backup},'expires_at':'2099-01-01T00:00:00Z','started_job_id':job,'completed_job_id':None,'refusal':None}
        self.server.backup={'backup_id':backup,'instance_id':instance,'destination':'gigahost_s3','status':'available','purpose':'regular','funding_lifecycle_id':None,'size_bytes':1048577,'restore_pricing_revision':1,'restore_charge_microusd_per_gib':1000000,'storage_charge_microusd_per_gib_month':20000,'recipient_key_fingerprint':self.account_keys['recovery_key_fingerprint'],'wrapped_data_key':'private-wrapped-key-not-for-the-ui','created_at':date,'completed_at':date}
        self.server.instance={'instance_id':instance,'offering_id':'of2_J7hnuv_uO8PmXACeyas4QY','restored_from_backup_id':None,'hostname':'restore-destination','root_disk_bytes':10737418240,'state':'stopped','desired_power_state':'stopped','holds_capacity':True,'public_ipv4':None,'gateway_tier':None,'network_microusd_per_tib':0,'created_at':date,'billing_started_at':date,'balance_reservation_microusd':0,'provider_termination':None}
        self.server.job={'job_id':job,'kind':'restore_backup','state':'succeeded','resource_id':instance,'progress_permyriad':10000,'current_step_key':None,'result':{},'error_code':None,'error_message':None,'created_at':date,'updated_at':date,'completed_at':date,'steps':[],'events':[]}
        return intent
    def test_hosted_restore_review_and_resume_are_bound_to_one_intent(self):
        intent=self.restore_fixture()
        op=self.request('inspect_restore',reference='https://ghostrack.io/approvals/'+intent)
        self.assertEqual(op['review']['restore_charge_microusd'],'1954')
        self.assertEqual(op['review']['matching_recovery_files'],[str(self.seed)])
        self.assertNotIn('wrapped_data_key',op['review']['backup'])
        self.assertNotIn('private-wrapped-key-not-for-the-ui',(self.root/'state/operations.json').read_text())
        self.server.requests=[]
        self.request('approve_restore',id=op['id'],recovery_seed_file=None)
        writes=[path for method,path,*_ in self.server.requests if method == 'POST']
        self.assertEqual(writes,['/api/mut/v1/account/operation-intents/'+intent+'/complete'])
        self.assertEqual(self.request('snapshot',passphrase=None)['operations'][0]['state'],'authorized')
        self.request('approve_restore',id=op['id'],recovery_seed_file=None,error='approval_state')
    def test_restore_rejects_changed_intent_and_wrong_recovery_seed(self):
        intent=self.restore_fixture()
        op=self.request('inspect_restore',reference=intent)
        old=self.server.intent['operation']['instance_id']
        self.server.intent['operation']['instance_id']=str(uuid.uuid4())
        self.request('approve_restore',id=op['id'],recovery_seed_file=None,error='approval_changed')
        self.server.intent['operation']['instance_id']=old
        wrong=self.root/'wrong.seed'
        subprocess.check_output([ARGS.ghost,'--compact','key','generate','--output',str(wrong)],env=self.env)
        self.request('approve_restore',id=op['id'],recovery_seed_file=str(wrong),error='recovery_key_mismatch')
        self.server.backup['restore_charge_microusd_per_gib']=0
        op=self.request('inspect_restore',reference=intent)
        self.request('approve_restore',id=op['id'],recovery_seed_file=None,error='price_unavailable')
    def test_backup_export_is_private_and_never_overwrites(self):
        destination=self.root/'account-backup.seed'
        self.request('export_key',kind='account',destination=str(destination))
        self.assertEqual(destination.read_bytes(),self.seed.read_bytes())
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode),0o600)
        self.request('export_key',kind='account',destination=str(destination),error='file_exists')

if __name__ == '__main__':
    p=argparse.ArgumentParser(); p.add_argument('--driver',required=True); p.add_argument('--ghost',required=True); p.add_argument('--wallet',required=True)
    ARGS,rest=p.parse_known_args()
    for key in ['driver','ghost','wallet']: setattr(ARGS,key,str(Path(getattr(ARGS,key)).resolve()))
    unittest.main(argv=[__file__,*rest])
