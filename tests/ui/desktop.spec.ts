import { test, expect } from '@playwright/test';

import { fixture, address, openDesktop } from './fixtures';

test.beforeEach(async({page})=>{ await openDesktop(page); });
test('uses the live Signal palette and exact money display',async({page})=>{
  await expect(page.getByRole('heading',{name:'Your account, at a glance.'})).toBeVisible();
  await expect(page.getByText('12.345678',{exact:false}).first()).toBeVisible();
  await expect(page.getByText('$123.45',{exact:false})).toBeVisible();
  expect(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim())).toBe('#f25000');
  await page.screenshot({animations:'disabled',path:'test-results/overview.png',fullPage:true});
  await page.getByRole('button',{name:'Change theme'}).click();
  expect(await page.evaluate(()=>document.documentElement.dataset.theme)).toBe('dark');
  await page.screenshot({animations:'disabled',path:'test-results/overview-dark.png',fullPage:true});
});
test('prepares a payment and requires separate explicit confirmation',async({page})=>{
  await page.getByRole('button',{name:'Send MMX'}).click();
  await page.getByLabel('Recipient address').fill(address);
  await page.getByLabel('Amount in MMX').fill('0.000001');
  await page.getByLabel('Memo (optional)').fill('hello 世界');
  await page.getByRole('button',{name:'Review payment'}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('0.000001 MMX',{exact:true})).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Estimated USD value',{exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'broadcast').length)).toBe(0);
  await page.screenshot({animations:'disabled',path:'test-results/payment-review.png'});
  await page.getByRole('button',{name:'Confirm and send'}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  for (const name of ['Recipient address','Amount in MMX','Memo (optional)']) await expect(page.getByLabel(name,{exact:true})).toHaveValue('');
  await expect(page.locator('#memo-count')).toHaveText('0 / 64 UTF-8 bytes');
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.getByLabel('Recipient address',{exact:true})).toHaveValue('');
  await expect(page.getByLabel('Amount in MMX',{exact:true})).toHaveValue('');
  await expect(page.locator('.operation')).toContainText('0.000001 MMX');
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'broadcast').length)).toBe(1);
});
test('service funding locks account destination and memo',async({page})=>{
  await page.getByRole('button',{name:'Add funds'}).click();
  await expect(page.getByLabel('Recipient address')).toHaveAttribute('readonly','');
  await expect(page.getByLabel('Account deposit memo')).toHaveValue('gh-test-memo');
  await expect(page.getByLabel('Account deposit memo')).toHaveAttribute('readonly','');
  await page.getByLabel('Amount in MMX').fill('2');
  await page.getByRole('button',{name:'Review payment'}).click();
  expect(await page.evaluate(()=>(window as any).calls.find((r:any)=>r.action === 'prepare_send').purpose)).toBe('top_up');
  await expect(page.getByRole('dialog').locator('.fact').filter({hasText:'Estimated USD value'})).toHaveText('Estimated USD value$0.40');
  await page.screenshot({animations:'disabled',path:'artifacts/visual-review/top-up-review.png'});
  await page.getByRole('button',{name:'Confirm and send',exact:true}).click();
  await expect(page.getByLabel('Recipient address',{exact:true})).toHaveValue('');
  await expect(page.getByLabel('Recipient address',{exact:true})).not.toHaveAttribute('readonly','');
  await expect(page.getByLabel('Amount in MMX',{exact:true})).toHaveValue('');
  await expect(page.getByLabel('Memo (optional)',{exact:true})).toHaveValue('');
  await expect(page.getByLabel('Account deposit memo',{exact:true})).toHaveCount(0);
});

test('top-up review keeps payment available when the quote is missing or expired',async({page})=>{
  for (const quote of [undefined,{usd_per_mmx:'0.2',expires_at:'2000-01-01T00:00:00Z'}]) {
    const state:any=structuredClone(fixture);
    state.activation_terms.data.mmx_exchange_rate=quote;
    await openDesktop(page,state);
    await page.getByRole('button',{name:'Add funds',exact:true}).click();
    await page.getByLabel('Amount in MMX',{exact:true}).fill('2');
    await page.getByRole('button',{name:'Review payment',exact:true}).click();
    await expect(page.getByRole('dialog').locator('.fact').filter({hasText:'Estimated USD value'})).toHaveText('Estimated USD valueUnavailable');
    await expect(page.getByRole('button',{name:'Confirm and send',exact:true})).toBeEnabled();
    await expect(page.getByRole('dialog')).not.toContainText('NaN');
  }
});

test('payment review opens immediately and does not wait for unrelated refreshes',async({page})=>{
  await page.getByRole('button',{name:'Send MMX',exact:true}).click();
  await page.getByLabel('Recipient address',{exact:true}).fill(address);
  await page.getByLabel('Amount in MMX',{exact:true}).fill('1');
  await page.evaluate(()=>{
    const original=(window as any).__DESKTOP_TEST__;
    (window as any).__DESKTOP_TEST__=async(request:any)=>{
      const result=await original(request);
      if(request.action === 'prepare_send') return new Promise(resolve=>{ (window as any).finishPreparation=()=>resolve(result); });
      if(request.action === 'snapshot') return new Promise(resolve=>{ (window as any).finishRefresh=()=>resolve(result); });
      return result;
    };
  });
  const snapshots=await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'snapshot').length);
  await page.getByRole('button',{name:'Review payment',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('heading',{name:'Preparing your payment.',exact:true})).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveAttribute('aria-busy','true');
  await expect(page.getByRole('button',{name:'Confirm and send',exact:true})).toHaveCount(0);
  await expect.poll(()=>page.evaluate(() => typeof (window as any).finishPreparation)).toBe('function');
  await page.evaluate(()=>(window as any).finishPreparation());
  await expect(page.getByRole('dialog').getByRole('heading',{name:'Review your payment.',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Confirm and send',exact:true})).toBeEnabled();
  await expect(page.locator('.operation')).toHaveCount(1);
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'snapshot').length)).toBe(snapshots);
  expect(await page.evaluate(()=>(window as any).calls.some((r:any)=>r.action === 'broadcast'))).toBe(false);
  await page.getByRole('button',{name:'Confirm and send',exact:true}).click();
  await expect.poll(()=>page.evaluate(() => typeof (window as any).finishRefresh)).toBe('function');
  await page.evaluate(()=>(window as any).finishRefresh());
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'broadcast').length)).toBe(1);
});

test('preparation failure stays in the dialog and retains the send form',async({page})=>{
  await page.getByRole('button',{name:'Send MMX',exact:true}).click();
  await page.getByLabel('Recipient address',{exact:true}).fill(address);
  await page.getByLabel('Amount in MMX',{exact:true}).fill('1');
  await page.getByLabel('Memo (optional)',{exact:true}).fill('Retain on failure');
  await page.evaluate(()=>{
    const original=(window as any).__DESKTOP_TEST__;
    (window as any).__DESKTOP_TEST__=async(request:any)=>{
      if(request.action === 'prepare_send') throw {message:'Wallet RPC unavailable. Try again.'};
      return original(request);
    };
  });
  await page.getByRole('button',{name:'Review payment',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('heading',{name:'Could not prepare payment.',exact:true})).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Wallet RPC unavailable');
  await expect(page.getByRole('dialog')).toHaveAttribute('aria-busy','false');
  await expect(page.getByRole('button',{name:'Confirm and send',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await expect(page.getByLabel('Recipient address',{exact:true})).toHaveValue(address);
  await expect(page.getByLabel('Amount in MMX',{exact:true})).toHaveValue('1');
  await expect(page.getByLabel('Memo (optional)',{exact:true})).toHaveValue('Retain on failure');
  expect(await page.evaluate(()=>(window as any).calls.some((r:any)=>r.action === 'broadcast'))).toBe(false);
});

test('an uncertain submission preserves the draft and shows its error in the review',async({page})=>{
  await page.getByRole('button',{name:'Send MMX',exact:true}).click();
  await page.getByLabel('Recipient address',{exact:true}).fill(address);
  await page.getByLabel('Amount in MMX',{exact:true}).fill('1');
  await page.getByLabel('Memo (optional)',{exact:true}).fill('Keep this draft');
  await page.getByRole('button',{name:'Review payment',exact:true}).click();
  await page.evaluate(()=>{
    const original=(window as any).__DESKTOP_TEST__;
    (window as any).__DESKTOP_TEST__=async(request:any)=>{
      const result=await original(request);
      if(request.action === 'broadcast') {
        const snapshot=await original({action:'snapshot'});
        snapshot.operations[0].state='uncertain';
        throw {code:'rpc_transport_error',message:'Could not confirm submission. Check this saved payment.'};
      }
      return result;
    };
  });
  await page.getByRole('button',{name:'Confirm and send',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Could not confirm submission');
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.getByLabel('Recipient address',{exact:true})).toHaveValue(address);
  await expect(page.getByLabel('Amount in MMX',{exact:true})).toHaveValue('1');
  await expect(page.getByLabel('Memo (optional)',{exact:true})).toHaveValue('Keep this draft');
  await expect(page.getByRole('button',{name:'Review same payment',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'prepare_send').length)).toBe(1);
});

test('a successful submission clears the form even if the following refresh fails',async({page})=>{
  await page.getByRole('button',{name:'Send MMX',exact:true}).click();
  await page.getByLabel('Recipient address',{exact:true}).fill(address);
  await page.getByLabel('Amount in MMX',{exact:true}).fill('1');
  await page.getByLabel('Memo (optional)',{exact:true}).fill('Submitted payment');
  await page.getByRole('button',{name:'Review payment',exact:true}).click();
  await page.evaluate(()=>{
    const original=(window as any).__DESKTOP_TEST__;
    let submitted=false;
    (window as any).__DESKTOP_TEST__=async(request:any)=>{
      if(submitted && request.action === 'snapshot') throw {message:'Status service unavailable'};
      const result=await original(request);
      if(request.action === 'broadcast') submitted=true;
      return result;
    };
  });
  await page.getByRole('button',{name:'Confirm and send',exact:true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByText('Showing the last loaded view',{exact:true})).toBeVisible();
  for(const name of ['Recipient address','Amount in MMX','Memo (optional)']) await expect(page.getByLabel(name,{exact:true})).toHaveValue('');
  await expect(page.locator('#memo-count')).toHaveText('0 / 64 UTF-8 bytes');
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'broadcast').length)).toBe(1);
});
test('history memos render as text and receiving QR contains only the address',async({page})=>{
  await page.getByRole('link',{name:'Wallet',exact:true}).click();
  await page.getByRole('tab',{name:'History'}).click();
  await expect(page.getByText('<img src=x onerror="window.bad=true">',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).bad)).toBeUndefined();
  await page.getByRole('tab',{name:'Receive'}).click();
  await expect(page.locator('#receive-address')).toHaveText(address);
  await expect(page.locator('#receive-qr')).toBeVisible();
  expect(await page.locator('#receive-qr').getAttribute('width')).toBe('200');
  await page.screenshot({animations:'disabled',path:'test-results/receive.png'});
});
test('memo limits use UTF-8 bytes and key paths stay independently configurable',async({page})=>{
  await page.getByRole('button',{name:'Send MMX'}).click();
  await page.getByLabel('Recipient address').fill(address);
  await page.getByLabel('Amount in MMX').fill('1');
  await page.getByLabel('Memo (optional)').fill('é'.repeat(33));
  await page.getByRole('button',{name:'Review payment'}).click();
  await expect(page.getByRole('status')).toContainText('Memo exceeds 64 UTF-8 bytes');
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'prepare_send').length)).toBe(0);
  await page.getByRole('link',{name:'Settings'}).click();
  await page.getByLabel('MMX wallet file',{exact:true}).fill('/tmp/custom wallet.dat');
  await page.getByRole('button',{name:'Save settings'}).click();
  await expect(page.getByLabel('GhostRack account key',{exact:true})).toHaveValue('/tmp/disposable-account.seed');
  await expect(page.getByLabel('MMX wallet file',{exact:true})).toHaveValue('/tmp/custom wallet.dat');
});

test('restore review shows exact billing and requires explicit authorization',async({page})=>{
  await page.getByRole('link',{name:'Account'}).click();
  await page.getByLabel('Approval link or request ID').fill('d991d038-bbfc-4a9b-82dd-0d1cf33281b7');
  await page.getByRole('button',{name:'Review request'}).click();
  await expect(page.getByRole('dialog').getByText('$0.001954',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Account key',{exact:true})).toHaveValue('/tmp/older-recovery.seed');
  await page.getByRole('button',{name:'Authorize restore',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'approve_restore').length)).toBe(0);
  await page.getByLabel('I reviewed the destination and charge, and authorize this restore.').check();
  await page.screenshot({animations:'disabled',path:'test-results/restore-review.png'});
  await page.getByRole('button',{name:'Authorize restore',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).calls.find((r:any)=>r.action === 'approve_restore').recovery_seed_file)).toBe('/tmp/older-recovery.seed');
});
test('rotation offers a default replacement location and a separate confirmation',async({page})=>{
  await page.getByRole('link',{name:'Account'}).click();
  await page.getByRole('button',{name:'Rotate account keys',exact:true}).click();
  await expect(page.getByLabel('Replacement account key file',{exact:true})).toHaveValue(/disposable-account.seed.replacement-/);
  await page.getByRole('button',{name:'Generate replacement'}).click();
  await expect(page.getByRole('button',{name:'Back up replacement account key'})).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:'Rotate account keys',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'rotate_keys').length)).toBe(0);
  await page.getByLabel('I have backed up both account keys and understand that sessions will end.').check();
  await page.getByRole('dialog').getByRole('button',{name:'Rotate account keys',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'rotate_keys').length)).toBe(1);
});

test('background updates preserve an approval link being edited',async({page})=>{
  await page.clock.install();
  await openDesktop(page);
  await page.getByRole('link',{name:'Account'}).click();
  const input=page.getByLabel('Approval link or request ID');
  await input.fill('https://ghostrack.io/approvals/d991d038-bbfc-4a9b-82dd-0d1cf33281b7');
  await input.blur();
  const before=await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'snapshot').length);
  for (let tick=0;tick<3;tick++) await page.clock.fastForward(10_000);
  await expect(input).toHaveValue('https://ghostrack.io/approvals/d991d038-bbfc-4a9b-82dd-0d1cf33281b7');
  await expect.poll(()=>page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'snapshot').length)).toBeGreaterThan(before);
});

test('a submitted activation payment offers activation checking instead of another payment',async({page})=>{
  await page.evaluate(()=>{
    const original=(window as any).__DESKTOP_TEST__;
    (window as any).__DESKTOP_TEST__=async(request:any)=>{
      const result=await original(request);
      if(request.action === 'snapshot') {
        result.account={data:null,error:{code:'account_not_activated',message:'Activation pending'}};
        result.operations=[{id:'activation-sent',kind:'activation',state:'included',created_at:1700000000,transaction_id:'a'.repeat(64),ghost_seed_file:result.ghost_seed_file,api_url:result.settings.api_url,account_memo:result.keys.data.deposit_memo,review:{amount:'1'}}];
      }
      return result;
    };
  });
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.getByRole('button',{name:'Activate account',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Check activation',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'activate_account').length)).toBe(1);
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'prepare_send').length)).toBe(0);
});
