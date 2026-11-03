import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

export const address = 'mmx1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqdgytev';
const ok = (data: unknown) => ({ data, error: null });
export const fixture = {
  settings: { wallet_file:'/tmp/disposable-wallet.dat',ghost_seed_file:'/tmp/disposable-account.seed',recovery_seed_files:[],rpc_url:'https://rpc.mmx.network',api_url:'https://api.ghostrack.io',website_url:'https://ghostrack.io',theme:'light',account_index:0,num_addresses:1 },
  wallet: { file:'/tmp/disposable-wallet.dat',addresses:ok({addresses:[address]}),balance:ok({balances:[{amount:'12.345678',amount_atomic:'12345678'}]}),history:ok({history:[{type:'RECEIVE',memo:'<img src=x onerror="window.bad=true">',amount:'0.000001',txid:'a'.repeat(64),height:100,is_pending:false,time_stamp:1700000000000}]}) },
  wallets:ok({wallets:[]}),keys:ok({deposit_memo:'gh-test-memo'}),ghost_seed_file:'/tmp/disposable-account.seed',account:ok({account_alias:'gh-test-account',status:'active',key_epoch:1}),account_balance:ok({available_microusd:'123450000',reserved_microusd:'5000000'}),deposits:ok({items:[]}),activation_terms:ok({deposit_address:address,minimum_deposit_mmx_atomic:'1000000',minimum_confirmations:6,mmx_exchange_rate:{usd_per_mmx:'0.200000000000000000',expires_at:'2099-01-01T00:00:00Z'}}),operations:[],refreshed_at:1700000000,
  provider_balance:ok(null),payouts:ok([]),
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
      if(request.action === 'prepare_payout' || request.action === 'prepare_payout_address') {
        const balance=(fixture as any).provider_balance.data;
        const [whole,fraction='']=String(request.amount || '').split('.');
        const amount=request.amount ? String(BigInt(whole)*1_000_000n + BigInt(fraction.padEnd(6,'0'))) : balance.available_payout_microusd;
        const op={id:'payout-review-'+fixture.operations.length,kind:request.action === 'prepare_payout' ? 'payout' : 'payout_address',state:'prepared',created_at:1700000000,api_url:fixture.settings.api_url,ghost_seed_file:fixture.ghost_seed_file,review:{account_alias:fixture.account.data.account_alias,previous_address:balance.payout_address,address:request.address || balance.payout_address,amount_microusd:amount}};
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
            op.review.result={payout_id:'d991d038-bbfc-4a9b-82dd-0d1cf33281b7',destination_address:op.review.address,amount_microusd:op.review.amount_microusd,amount_mmx_atomic:null,state:'queued',chain_transaction_id:null,requested_at:'2026-10-07T00:00:00Z'};
            (fixture as any).payouts.data=[op.review.result];
            balance.available_payout_microusd=String(BigInt(balance.available_payout_microusd)-BigInt(op.review.amount_microusd));
            balance.on_the_way_microusd=op.review.amount_microusd;
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
      if(request.action === 'inspect_restore') {
        const op={id:'restore-local-test',kind:'restore',state:'prepared',created_at:1700000000,review:{request:{operation:{kind:'restore_backup',instance_id:'destination-id'},expires_at:'2099-01-01T00:00:00Z'},backup:{backup_id:'backup-id',instance_id:'source-id',recipient_key_fingerprint:'public-fingerprint'},destination:{hostname:'staging-target'},account:{account_alias:'gh-test-account'},matching_recovery_files:['/tmp/older-recovery.seed'],restore_charge_microusd:'1954',charge_already_committed:false}};
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
