import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

export const address = 'mmx1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqdgytev';
const ok = (data: unknown) => ({ data, error: null });
export const fixture = {
  settings: { wallet_file:'/tmp/disposable-wallet.dat',ghost_seed_file:'/tmp/disposable-account.seed',recovery_seed_files:[],rpc_url:'https://rpc.mmx.network',api_url:'https://api.ghostrack.io',website_url:'https://ghostrack.io',theme:'light',account_index:0,num_addresses:1 },
  wallet: { file:'/tmp/disposable-wallet.dat',addresses:ok({addresses:[address]}),balance:ok({balances:[{amount:'12.345678',amount_atomic:'12345678'}]}),history:ok({history:[{type:'RECEIVE',memo:'<img src=x onerror="window.bad=true">',amount:'0.000001',txid:'a'.repeat(64),height:100,is_pending:false,time_stamp:1700000000000}]}) },
  wallets:ok({wallets:[]}),keys:ok({deposit_memo:'gh-test-memo'}),ghost_seed_file:'/tmp/disposable-account.seed',account:ok({account_alias:'gh-test-account',status:'active',key_epoch:1}),account_balance:ok({available_microusd:'123450000',reserved_microusd:'5000000'}),deposits:ok({items:[]}),activation_terms:ok({deposit_address:address,minimum_deposit_mmx_atomic:'1000000',minimum_confirmations:6,mmx_exchange_rate:{usd_per_mmx:'0.200000000000000000',expires_at:'2099-01-01T00:00:00Z'}}),operations:[],refreshed_at:1700000000,
  provider_balance:ok(null),payouts:ok([]),conversions:ok([]),
  ssh_keys:ok([{ssh_key_id:'0b7c0a3e-3f0e-4c8e-9a53-5c1f3b1e7a11',label:'Work laptop',public_key:'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOne',key_type:'ssh-ed25519',fingerprint:'SHA256:3n0w0mO8Qe2yQ1Lq9bJ2uV1tY0m4c9o8pHk5aXz7WfE',created_at:'2026-11-02T10:00:00Z'},{ssh_key_id:'5d2f6c18-4c7a-4f25-8d0b-7a1e9c3b2f40',label:'Build server key with a long label that keeps going to sixty-four',public_key:'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQTwo',key_type:'ssh-rsa',fingerprint:'SHA256:Zp8vN2kQ7rT1xYb4LmC9dEoUa3JhGf6WsV0iRnXy5Kc',created_at:'2026-11-10T08:30:00Z'}]),
};
export async function openDesktop(page: Page, state = structuredClone(fixture)) {
  // Serve the built UI through Playwright interception when local listening
  // sockets are unavailable. This exercises the same production assets.
  if (process.env.DESKTOP_UI_OFFLINE === '1') await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://desktop.test') return route.abort();
    const root = resolve('dist'), path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!path.startsWith(root + sep)) return route.abort();
    try {
      const contentType = ({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png'} as Record<string,string>)[extname(path)] || 'application/octet-stream';
      await route.fulfill({body:await readFile(path),contentType});
    } catch { await route.fulfill({status:404,body:'Not found'}); }
  });
  await page.addInitScript(({fixture,address})=>{
    (window as any).calls=[];
    (window as any).__DESKTOP_TEST__=async(request:any)=>{
      (window as any).calls.push(request);
      if(request.action === 'snapshot') return fixture;
      if(request.action === 'save_settings') { fixture.settings=request.settings; return request.settings; }
      if(request.action === 'add_ssh_key') {
        const line=String(request.public_key).trim();
        if(!/^ssh-(ed25519|rsa) /.test(line)) throw {code:'invalid_ssh_key',message:'Paste one public key line from a *.pub file.'};
        const key={ssh_key_id:'9a1b2c3d-0000-4000-8000-'+String(Date.now()).padStart(12,'0'),label:request.label,public_key:line,key_type:line.split(' ')[0],fingerprint:'SHA256:NewKeyFingerprint0123456789abcdefghijklmnopq',created_at:'2026-11-21T09:00:00Z'};
        ((fixture as any).ssh_keys.data as any[]).push(key); return key;
      }
      if(request.action === 'remove_ssh_key') {
        const keys=(fixture as any).ssh_keys.data as any[], index=keys.findIndex(k=>k.ssh_key_id === request.ssh_key_id);
        return keys.splice(index,1)[0];
      }
      if(request.action === 'read_public_key_file') return {public_key:'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFromFile'};
      if(request.action === 'prepare_payout' || request.action === 'prepare_payout_address') {
        const balance=(fixture as any).provider_balance.data;
        const [whole,fraction='']=String(request.amount || '').split('.');
        const amount=request.amount ? String(BigInt(whole)*1_000_000n + BigInt(fraction.padEnd(6,'0'))) : balance.available_payout_mmx_atomic;
        const op={id:'payout-review-'+fixture.operations.length,kind:request.action === 'prepare_payout' ? 'payout' : 'payout_address',state:'prepared',created_at:1700000000,api_url:fixture.settings.api_url,ghost_seed_file:fixture.ghost_seed_file,review:{account_alias:fixture.account.data.account_alias,previous_address:balance.payout_address,address:request.address || balance.payout_address,...(request.action === 'prepare_payout' ? {amount_mmx_atomic:amount} : {})}};
        (fixture.operations as any[]).push(op); return op;
      }
      if(request.action === 'payout_review' || request.action === 'discard_payout' || request.action === 'confirm_payout') {
        const op=(fixture.operations as any[]).find(op=>op.id === request.id);
        if(request.action === 'discard_payout') op.state='discarded';
        if(request.action === 'confirm_payout') {
          op.state='complete';
          const balance=(fixture as any).provider_balance.data;
          if(op.kind === 'payout_address') balance.payout_address=op.review.address;
          else {
            op.review.result={payout_id:'d991d038-bbfc-4a9b-82dd-0d1cf33281b7',destination_address:op.review.address,amount_microusd:'0',amount_mmx_atomic:op.review.amount_mmx_atomic,state:'queued',chain_transaction_id:null,requested_at:'2026-10-07T00:00:00Z'};
            (fixture as any).payouts.data=[op.review.result];
            balance.available_payout_mmx_atomic=String(BigInt(balance.available_payout_mmx_atomic)-BigInt(op.review.amount_mmx_atomic));
            balance.on_the_way_mmx_atomic=op.review.amount_mmx_atomic;
          }
        }
        return op;
      }
      if(request.action === 'prepare_send') {
        const op={id:'d991d038-bbfc-4a9b-82dd-0d1cf33281b7',kind:request.purpose,state:'prepared',ghost_seed_file:fixture.ghost_seed_file,api_url:fixture.settings.api_url,account_memo:request.purpose === 'send' ? null : fixture.keys.data.deposit_memo,wallet_file:fixture.settings.wallet_file,wallet_account:fixture.settings.account_index,created_at:1700000000,transaction_id:'b'.repeat(64),review:{target:request.purpose === 'send' ? request.target : address,amount:request.amount,fee:'0.0013',max_fee_atomic:'5001300',memo:request.purpose === 'send' ? request.memo : 'gh-test-memo',expires_height:200,network:'mainnet'}};
        (fixture.operations as any[]).push(op); return op;
      }
      if(request.action === 'broadcast') { (fixture.operations[0] as any).state='broadcast'; return {status:'broadcast'}; }
      if(request.action === 'payment_status') {
        const op=(fixture.operations as any[]).find(op=>op.id === request.id);
        return {status:op.state,confirmations:op.confirmations ?? 0};
      }
      if(request.action === 'discard_payment') { (fixture.operations[0] as any).state='discarded'; return {}; }
      // A reinstall, rescue boot or SSH access reset (item 296b), as Ghost's screen shows it: reference
      // c…296 + 1, 2 or 3 picks the kind, 4 a reinstall of an instance with a long name. Set
      // window.changeApproval to answer the next approval as Ghost does a request that changed.
      const instanceKinds:Record<string,string>={'c0000000-0000-4000-8000-000000002961':'reinstall_instance','c0000000-0000-4000-8000-000000002962':'rescue_instance','c0000000-0000-4000-8000-000000002963':'reset_instance_access','c0000000-0000-4000-8000-000000002964':'reinstall_instance'};
      if(request.action === 'inspect_restore' && instanceKinds[request.reference]) {
        const kind=instanceKinds[request.reference], reinstall=kind === 'reinstall_instance';
        const keys=[{label:'SSH keys',value:'work laptop, build server'},{label:'',value:'ssh-ed25519 SHA256:ZkAslGjFiUHdGf/WUL8rQvkib4PTvQatUV0OUQSncCA renter@a-very-long-workstation-name.internal.example.org (added from the website for the migration weekend)'},{label:'',value:'ecdsa-sha2-nistp256 SHA256:Gb0oX0dYJ7Uo4n7cCPNkSPyc8fvxmCLDqVhBV1n0f8Y ci'}];
        const review=[{label:'Instance',value:'running, 4 vCPU, 8 GiB RAM, 80 GiB disk, Singapore'},...(reinstall ? [{label:'Image',value:'Ubuntu 24.04 LTS  →  Debian 13'},{label:'Hostname',value:'web-2'}] : []),...keys,...(reinstall ? [{label:'Cloud-init',value:'1.2 KiB, SHA-256 353576b3b36a47200c32dddbd3505f74af8929d00975ef558dad6e492bf55fd5'},{label:'First-boot command',value:'not set'}] : []),...(kind === 'reset_instance_access' ? [{label:'Firewall',value:'stopped for that boot only'}] : [])];
        const notice=({reinstall_instance:'Approving reinstalls the instance as shown above.',rescue_instance:'Approving boots the instance into rescue as shown above.',reset_instance_access:'Approving resets the instance\'s SSH access as shown above.'} as Record<string,string>)[kind];
        const name=request.reference.endsWith('4') ? 'customer-portal-production-frontend-blue-green-canary-europe-west-and-singapore' : 'web-production-frontend';
        const op={id:'instance-action-'+request.reference.slice(-1),kind:'instance_action',state:'prepared',created_at:1700000000,ghost_seed_file:fixture.ghost_seed_file,api_url:fixture.settings.api_url,intent_id:request.reference,review:{intent_id:request.reference,kind,instance_id:'0d3f5a52-7c1e-4b8e-9a51-2c4b6f0e9d13',instance_name:name,review,review_effects:reinstall ? ['Reinstall destroys the current root filesystem and starts the instance if it is stopped.','Keeps a backup first: up to $1.50, locked until 2026-11-27.'] : [],notice,expires_at:'2099-01-01T00:00:00Z',operation_sha256:'5d1c0e1f4b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d'}};
        // One saved review per request.
        (fixture as any).operations=[...(fixture.operations as any[]).filter(saved=>saved.id !== op.id),op]; return op;
      }
      if(request.action === 'approve_instance_action') {
        const op=(fixture.operations as any[]).find(op=>op.id === request.id);
        if((window as any).changeApproval) {
          (window as any).changeApproval=false;
          op.review={...op.review,review_effects:[op.review.review_effects[0],'Keeps a backup first: up to $1.50, locked until 2026-11-28.']};
          throw {code:'approval_changed',message:'The request changed. Review it again.'};
        }
        op.state='authorized'; return {job_id:'job-id'};
      }
      if(request.action === 'inspect_restore') {
        const op={id:'restore-local-test',kind:'restore',state:'prepared',created_at:1700000000,review:{request:{operation:{kind:'restore_backup',instance_id:'destination-id'},expires_at:'2099-01-01T00:00:00Z'},backup:{backup_id:'backup-id',instance_id:'source-id',recipient_key_fingerprint:'public-fingerprint'},destination:{hostname:'staging-target'},account:{account_alias:'gh-test-account'},matching_recovery_files:['/tmp/older-recovery.seed'],restore_charge_microusd:'1954',charge_already_committed:false}};
        // An older instance whose deletion waits (item 267).
        if(request.reference === 'a0000000-0000-4000-8000-000000000267') Object.assign(op.review,{forced_backup:'Keeps a backup first: up to $1.50, locked until 2026-11-20.',backup:{...op.review.backup,locked_until:'2026-11-20T00:00:00Z'},destination:{...op.review.destination,delete_at:'2026-11-13T12:00:00Z'}});
        (fixture.operations as any[]).push(op); return op;
      }
      if(request.action === 'keep_restore_destination') {
        const kept=(fixture.operations as any[]).find(op=>op.id === request.id);
        kept.state='discarded';
        const op={...kept,id:'restore-kept-test',state:'prepared',review:{...kept.review,destination:{hostname:'staging-target'}}};
        (fixture.operations as any[]).push(op); return op;
      }
      if(request.action === 'approve_restore') { (fixture.operations.at(-1) as any).state='authorized'; return {job_id:'job-id'}; }
      if(request.action === 'prepare_rotation') {
        const op={id:'rotation-local-test',kind:'rotation',state:'prepared',created_at:1700000000,ghost_seed_file:'/tmp/disposable-account.seed',replacement_seed_file:request.file,review:{account:{account_alias:'gh-test-account'},replacement:{keys:{recovery_key_fingerprint:'new-public-fingerprint'}}}};
        (fixture.operations as any[]).push(op); return op;
      }
      if(request.action === 'rotate_keys') { (fixture.operations.at(-1) as any).state='complete'; return {}; }
      if(request.action === 'import_account') {
        if((fixture as any).import_exists && !request.replace) throw {code:'account_key_exists',message:fixture.ghost_seed_file+' holds a different account key; keep it, or pass --replace to keep it as '+fixture.ghost_seed_file+'.replaced-20261019T120000Z and import this one'};
        return {result:request.replace ? 'replaced' : 'imported',seed_file:fixture.ghost_seed_file,...(request.replace ? {replaced_file:fixture.ghost_seed_file+'.replaced-20261019T120000Z'} : {}),keys:{deposit_memo:'gh-test-memo'},account:null,account_note:'this key has no account yet: sign up with `ghost account signup --github`, or on the website'};
      }
      if(request.action === 'login') return {opened:true};
      return {};
    };
  },{fixture:state,address});
  await page.goto('/');
}
