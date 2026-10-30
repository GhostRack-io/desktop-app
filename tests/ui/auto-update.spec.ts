import { test, expect } from '@playwright/test';
import { fixture, address, openDesktop } from './fixtures';

function payment(state = 'broadcast', confirmations: number | null = null) {
  return {id:'payment-auto-test',kind:'send',state,confirmations,created_at:1700000000,transaction_id:'b'.repeat(64),review:{amount:'1'},ghost_seed_file:fixture.ghost_seed_file,api_url:fixture.settings.api_url,account_memo:fixture.keys.data.deposit_memo};
}

test('payment status updates while typing, stops at ten, and remains manually checkable', async ({page}) => {
  await page.clock.install();
  const state:any=structuredClone(fixture); state.operations=[payment()];
  await openDesktop(page,state);
  await page.getByRole('button',{name:'Send MMX',exact:true}).click();
  await page.getByLabel('Recipient address').fill(address);
  await page.getByLabel('Amount in MMX').fill('2.000001');
  const memo=page.getByLabel('Memo (optional)');
  await memo.fill('é🔑');
  await memo.evaluate((el:HTMLInputElement)=>el.setSelectionRange(1,3));
  await page.evaluate(()=>{
    const original=(window as any).__DESKTOP_TEST__;
    (window as any).nextConfirmations=1;
    (window as any).__DESKTOP_TEST__=async(request:any)=>{
      if(request.action === 'payment_status') {
        await original(request);
        const snapshot=await original({action:'snapshot'});
        snapshot.operations[0].state='included';
        snapshot.operations[0].confirmations=(window as any).nextConfirmations;
        snapshot.wallet.balance.data.balances[0].amount='11.345678';
        return {status:'included',confirmations:(window as any).nextConfirmations};
      }
      return original(request);
    };
  });
  for (const confirmations of [1,9,10]) {
    await page.evaluate(value=>(window as any).nextConfirmations=value,confirmations);
    await page.clock.fastForward(10_000);
    await expect(page.locator('.operation')).toContainText(`${confirmations >= 10 ? '10+' : confirmations} confirmations`);
    await expect(memo).toBeFocused();
    await expect(memo).toHaveValue('é🔑');
    expect(await memo.evaluate((el:HTMLInputElement)=>[el.selectionStart,el.selectionEnd])).toEqual([1,3]);
  }
  await expect(page.getByLabel('Recipient address')).toHaveValue(address);
  await expect(page.getByLabel('Amount in MMX')).toHaveValue('2.000001');
  await expect(page.locator('#memo-count')).toHaveText('6 / 64 UTF-8 bytes');
  await expect(page.getByText('11.345678',{exact:false})).toBeVisible();
  const count=await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'payment_status').length);
  await page.clock.fastForward(60_000);
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'payment_status').length)).toBe(count);
  await page.evaluate(()=>(window as any).nextConfirmations=12);
  await page.getByRole('button',{name:'Check status',exact:true}).click();
  await expect(page.locator('.operation')).toContainText('10+ confirmations');
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'payment_status').length)).toBe(count+1);
  expect(await page.evaluate(()=>(window as any).calls.some((r:any)=>['prepare_send','broadcast'].includes(r.action)))).toBe(false);
});

test('background status errors retry without replacing an open review or broadcasting', async ({page}) => {
  await page.clock.install();
  const state:any=structuredClone(fixture); state.operations=[payment('uncertain')];
  await openDesktop(page,state);
  await page.getByRole('button',{name:'Review same payment',exact:true}).click();
  await page.evaluate(()=>{
    const original=(window as any).__DESKTOP_TEST__;
    (window as any).statusAttempts=0;
    (window as any).__DESKTOP_TEST__=async(request:any)=>{
      if(request.action === 'payment_status') {
        await original(request);
        if(++(window as any).statusAttempts === 1) throw {message:'RPC unavailable'};
        const snapshot=await original({action:'snapshot'});
        snapshot.operations[0].state='included'; snapshot.operations[0].confirmations=3;
        return {status:'included',confirmations:3};
      }
      return original(request);
    };
  });
  const review=await page.getByRole('dialog').textContent();
  await page.clock.fastForward(10_000);
  await expect.poll(()=>page.evaluate(()=>(window as any).statusAttempts)).toBe(1);
  await page.clock.fastForward(10_000);
  await expect(page.locator('.operation')).toContainText('3 confirmations');
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.getByRole('dialog').textContent()).toBe(review);
  expect(await page.evaluate(()=>(window as any).calls.some((r:any)=>r.action === 'broadcast'))).toBe(false);
});

test('activation completes automatically after deposit confirmations without another payment', async ({page}) => {
  await page.clock.install();
  const state:any=structuredClone(fixture);
  state.operations=[{...payment('included',5),kind:'activation'}];
  state.account={data:null,error:{code:'account_not_activated',message:'Activation pending'}};
  await openDesktop(page,state);
  await page.getByRole('link',{name:'Account',exact:true}).click();
  await page.getByRole('button',{name:'Check activation',exact:true}).focus();
  await page.evaluate(()=>{
    const original=(window as any).__DESKTOP_TEST__;
    (window as any).__DESKTOP_TEST__=async(request:any)=>{
      const result=await original(request);
      if(request.action === 'payment_status' || request.action === 'activate_account') {
        const snapshot=await original({action:'snapshot'});
        if(request.action === 'payment_status') snapshot.operations[0].confirmations=6;
        else snapshot.account={data:{account_alias:'gh-automatically-active',status:'active',key_epoch:1},error:null};
      }
      return result;
    };
  });
  await page.clock.fastForward(10_000);
  await expect(page.getByRole('heading',{name:'gh-automatically-active',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Open GhostRack',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'activate_account').length)).toBe(1);
  expect(await page.evaluate(()=>(window as any).calls.some((r:any)=>['prepare_send','broadcast'].includes(r.action)))).toBe(false);
});

test('reopened payments at ten confirmations and payment drafts only receive manual status checks', async ({page}) => {
  await page.clock.install();
  const state:any=structuredClone(fixture);
  state.operations=[payment('included',10),{...payment('prepared'),id:'draft'},{...payment('failed'),id:'failed'}];
  await openDesktop(page,state);
  await page.clock.fastForward(60_000);
  await expect(page.getByRole('button',{name:'Check status',exact:true})).toHaveCount(3);
  expect(await page.evaluate(()=>(window as any).calls.some((r:any)=>r.action === 'payment_status'))).toBe(false);
});
