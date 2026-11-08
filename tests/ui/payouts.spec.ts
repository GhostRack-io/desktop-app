import { test, expect } from '@playwright/test';
import { fixture, address, openDesktop } from './fixtures';

function provider(payoutAddress:string|null=address) {
  const state:any=structuredClone(fixture);
  state.provider_balance={data:{pending_payout_microusd:'90000000',available_payout_microusd:'0',held_microusd:'24499999',on_the_way_microusd:'0',sla_settlement_pending:false,available_payout_mmx_atomic:'12250000',on_the_way_mmx_atomic:'0',waiting_for_exchange_rate:false,payout_address:payoutAddress},error:null};
  return state;
}
const payout={payout_id:'d991d038-bbfc-4a9b-82dd-0d1cf33281b7',destination_address:address,amount_microusd:'40010000',amount_mmx_atomic:null,state:'queued',chain_transaction_id:null,requested_at:'2026-10-07T00:00:00Z',waiting_reason:null};

test('payout address uses the wallet address and requires separate confirmation',async({page})=>{
  await openDesktop(page,provider(null));
  await page.getByRole('link',{name:'Payouts',exact:true}).click();
  const update=page.getByRole('button',{name:'Update address',exact:true});
  await expect(update).toBeDisabled();
  await expect(page.getByRole('button',{name:'Review payout',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Use wallet address',exact:true}).click();
  await expect(page.getByLabel('MMX payout address',{exact:true})).toHaveValue(address);
  await expect(update).toBeEnabled();
  await update.click();
  await expect(page.getByRole('dialog')).toContainText(address);
  expect(await page.evaluate(()=>(window as any).calls.some((r:any)=>r.action==='confirm_payout'))).toBe(false);
  await page.getByRole('button',{name:'Save payout address',exact:true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button',{name:'Review payout',exact:true})).toBeEnabled();
  await expect(update).toBeDisabled();
  const input=page.getByLabel('MMX payout address',{exact:true});
  await input.fill('  '+address+'  ');
  await expect(update).toBeDisabled();
  await input.press('Enter');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await input.fill(address.slice(0,-1)+'q');
  await expect(update).toBeEnabled();
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(input).toHaveValue(address.slice(0,-1)+'q');
  await expect(update).toBeEnabled();
  await page.getByRole('button',{name:'Use wallet address',exact:true}).click();
  await expect(update).toBeDisabled();
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action==='prepare_payout_address').length)).toBe(1);
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action==='confirm_payout').length)).toBe(1);
});

test('the tiles show pending dollars and available and on-the-way MMX',async({page})=>{
  await openDesktop(page,provider());
  await page.getByRole('link',{name:'Payouts',exact:true}).click();
  const tiles=page.locator('.payout-balances .balance-block');
  await expect(tiles).toHaveText(['Pending$90.00','Available now12.25MMX','On the way0MMX']);
});

test('payout review freezes everything available and confirmation clears the amount',async({page})=>{
  await openDesktop(page,provider());
  await page.getByRole('link',{name:'Payouts',exact:true}).click();
  await page.getByRole('button',{name:'Review payout',exact:true}).click();
  await expect(page.getByRole('dialog').locator('.fact').filter({hasText:'Amount'})).toHaveText('Amount12.25 MMX');
  await expect(page.getByRole('dialog')).not.toContainText('Estimated MMX value');
  await expect(page.getByRole('dialog')).not.toContainText('exchange rate when the payout is prepared');
  expect(await page.evaluate(()=>(window as any).calls.some((r:any)=>r.action==='confirm_payout'))).toBe(false);
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await expect(page.getByRole('button',{name:'Review payout',exact:true})).toBeDisabled();
  await expect(page.locator('[data-review-payout]')).toContainText('Review');
  await expect(page.locator('.operation h3')).toHaveText('Payout · 12.25 MMX');
  await page.locator('[data-review-payout]').click();
  await page.getByRole('button',{name:'Confirm payout',exact:true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByLabel('Amount in MMX (optional)',{exact:true})).toHaveValue('');
  await expect(page.locator('.payout-table')).toContainText('12.25 MMX');
  await expect(page.locator('.payout-table')).not.toContainText('$');
  await expect(page.locator('.payout-table')).toContainText('Queued');
  await expect(page.locator('.payout-balances .balance-block').nth(2)).toHaveText('On the way12.25MMX');
});

test('payout review needs no exchange rate quote',async({page})=>{
  for (const quote of [null,{usd_per_mmx:'0.2',expires_at:'2000-01-01T00:00:00Z'}]) {
    const state=provider();
    state.activation_terms.data.mmx_exchange_rate=quote;
    await openDesktop(page,state);
    await page.getByRole('link',{name:'Payouts',exact:true}).click();
    await page.getByRole('button',{name:'Review payout',exact:true}).click();
    await expect(page.getByRole('dialog')).not.toContainText('Estimated');
    await expect(page.getByRole('button',{name:'Confirm payout',exact:true})).toBeEnabled();
  }
});

test('an uncertain payout retries its saved request and cannot prepare another',async({page})=>{
  await openDesktop(page,provider());
  await page.getByRole('link',{name:'Payouts',exact:true}).click();
  await page.getByLabel('Amount in MMX (optional)',{exact:true}).fill('5.5');
  await page.getByRole('button',{name:'Review payout',exact:true}).click();
  await page.evaluate(()=>{
    const original=(window as any).__DESKTOP_TEST__; let attempts=0;
    (window as any).__DESKTOP_TEST__=async(request:any)=>{
      if(request.action==='confirm_payout' && ++attempts===1) {
        (window as any).calls.push(request);
        const snapshot=await original({action:'snapshot'}); snapshot.operations[0].state='uncertain';
        throw {code:'no_response',message:'The response did not arrive. Retry the saved request.'};
      }
      return original(request);
    };
  });
  await page.getByRole('button',{name:'Confirm payout',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('response did not arrive');
  await expect(page.getByRole('button',{name:'Retry same payout',exact:true})).toBeEnabled();
  await expect(page.getByLabel('Amount in MMX (optional)',{exact:true})).toHaveValue('5.5');
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await expect(page.getByRole('button',{name:'Review payout',exact:true})).toBeDisabled();
  await expect(page.locator('[data-discard-payout]')).toHaveCount(0);
  await page.getByRole('button',{name:'Review saved request',exact:true}).click();
  await page.getByRole('button',{name:'Retry same payout',exact:true}).click();
  await expect(page.locator('.payout-table')).toContainText('5.5 MMX');
  const requests=await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action==='confirm_payout'));
  expect(requests).toHaveLength(2); expect(requests[0].id).toBe(requests[1].id);
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action==='prepare_payout').length)).toBe(1);
});

test('payout status updates automatically while preserving both forms, then stays manually checkable',async({page})=>{
  await page.clock.install();
  const state=provider(); state.payouts.data=[payout];
  await openDesktop(page,state);
  await page.getByRole('link',{name:'Payouts',exact:true}).click();
  const amount=page.getByLabel('Amount in MMX (optional)',{exact:true});
  await amount.fill('12.34'); await amount.evaluate((el:HTMLInputElement)=>el.setSelectionRange(1,3));
  await page.evaluate(()=>{
    const original=(window as any).__DESKTOP_TEST__; (window as any).nextPayoutState='submitted';
    (window as any).__DESKTOP_TEST__=async(request:any)=>{
      const result=await original(request);
      if(request.action==='snapshot') result.payouts.data[0].state=(window as any).nextPayoutState;
      return result;
    };
  });
  await page.clock.fastForward(10_000);
  await expect(page.locator('.payout-table')).toContainText('Waiting for confirmation');
  await expect(amount).toBeFocused(); await expect(amount).toHaveValue('12.34');
  expect(await amount.evaluate((el:HTMLInputElement)=>[el.selectionStart,el.selectionEnd])).toEqual([1,3]);
  await page.getByLabel('MMX payout address',{exact:true}).fill('draft payout address');
  await page.evaluate(()=>(window as any).nextPayoutState='confirmed');
  await page.clock.fastForward(10_000);
  await expect(page.locator('.payout-table')).toContainText('Confirmed');
  await expect(page.getByLabel('MMX payout address',{exact:true})).toHaveValue('draft payout address');
  const count=await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action==='snapshot').length);
  await page.clock.fastForward(20_000);
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action==='snapshot').length)).toBe(count);
  await page.getByRole('button',{name:'Check status',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action==='snapshot').length)).toBe(count+1);
  expect(await page.evaluate(()=>(window as any).calls.some((r:any)=>['prepare_payout','confirm_payout'].includes(r.action)))).toBe(false);
});

test('payout availability reflects MMX earnings, an unsettled outage does not block it, and missing profiles show no request form',async({page})=>{
  const state=provider(); state.provider_balance.data.sla_settlement_pending=true;
  await openDesktop(page,state);
  await page.getByRole('link',{name:'Payouts',exact:true}).click();
  await expect(page.getByRole('button',{name:'Review payout',exact:true})).toBeEnabled();
  await expect(page.getByText('An outage on one of your hosts is not settled yet. Earnings convert to MMX once it is.',{exact:true})).toBeVisible();
  await page.screenshot({animations:'disabled',path:'artifacts/visual-review/payouts-outage.png',fullPage:true});
  const empty=provider(); empty.provider_balance.data.available_payout_mmx_atomic='0';
  await openDesktop(page,empty);
  await page.getByRole('link',{name:'Payouts',exact:true}).click();
  await expect(page.getByRole('button',{name:'Review payout',exact:true})).toBeDisabled();
  await openDesktop(page);
  await page.getByRole('link',{name:'Payouts',exact:true}).click();
  await expect(page.getByRole('heading',{name:'No earnings yet.',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Review payout',exact:true})).toHaveCount(0);
});

test('released dollars wait for an exchange rate',async({page})=>{
  const state=provider(); Object.assign(state.provider_balance.data,{available_payout_microusd:'40010000',waiting_for_exchange_rate:true});
  await openDesktop(page,state);
  await page.getByRole('link',{name:'Payouts',exact:true}).click();
  await expect(page.getByText('$40.01 converts to MMX once an exchange rate is published.',{exact:true})).toBeVisible();
});

test('conversions list each day newest first, empty and unavailable states',async({page})=>{
  const state=provider();
  state.conversions.data=[
    {conversion_id:'c2',converted_on:'2026-11-08',amount_microusd:'20000000',usd_per_mmx:'5.000000000000000000',exchange_rate_id:'r',amount_mmx_atomic:'4000000',created_at:'2026-11-08T00:05:00Z'},
    {conversion_id:'c1',converted_on:'2026-11-07',amount_microusd:'1500000',usd_per_mmx:'0.123456789012345678',exchange_rate_id:'r',amount_mmx_atomic:'12150001',created_at:'2026-11-07T00:05:00Z'},
  ];
  await openDesktop(page,state);
  await page.getByRole('link',{name:'Payouts',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Conversions',exact:true})).toBeVisible();
  const rows=page.locator('.conversion-table tbody tr');
  await expect(page.locator('.conversion-table thead th')).toHaveText(['Day','Earnings','Rate','MMX']);
  await expect(rows.nth(0)).toHaveText('2026-11-08$20.00$5.00 per MMX4 MMX');
  await expect(rows.nth(1)).toHaveText('2026-11-07$1.50$0.123456789012345678 per MMX12.150001 MMX');
  await page.screenshot({animations:'disabled',path:'artifacts/visual-review/payouts-conversions.png',fullPage:true});
  await page.getByRole('button',{name:'Change theme',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.screenshot({animations:'disabled',path:'artifacts/visual-review/payouts-conversions-dark.png',fullPage:true});
  const none=provider();
  await openDesktop(page,none);
  await page.getByRole('link',{name:'Payouts',exact:true}).click();
  await expect(page.getByText('No conversions yet.',{exact:true})).toBeVisible();
  const broken=provider(); broken.conversions={data:null,error:{code:'x',message:'Request failed'}};
  await openDesktop(page,broken);
  await page.getByRole('link',{name:'Payouts',exact:true}).click();
  await expect(page.getByText('Conversions are unavailable. Refresh to try again.',{exact:true})).toBeVisible();
});

test('a payout review saved in dollars is only discarded and never blocks a new one',async({page})=>{
  const state=provider();
  state.operations.push({id:'dollar-review',kind:'payout',state:'uncertain',created_at:1700000000,api_url:state.settings.api_url,ghost_seed_file:state.ghost_seed_file,review:{account_alias:'gh-test-account',previous_address:address,address,amount_microusd:'40010000'}});
  await openDesktop(page,state);
  await page.getByRole('link',{name:'Payouts',exact:true}).click();
  await expect(page.locator('.operation h3')).toHaveText('Payout · $40.01');
  await expect(page.getByRole('button',{name:'Review payout',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Review saved request',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('This saved request is in dollars. If it is not in your payout history, discard it and review a new payout in MMX.');
  await expect(page.getByRole('dialog')).toContainText('$40.01');
  await page.screenshot({animations:'disabled',path:'artifacts/visual-review/payout-review-dollars.png'});
  await expect(page.getByRole('button',{name:'Retry same payout',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Confirm payout',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByRole('button',{name:'Discard',exact:true}).click();
  await expect(page.locator('.operation')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).calls.some((r:any)=>r.action==='confirm_payout'))).toBe(false);
});

test('payout history shows an MMX payout alone and a payout of before in dollars with its memo',async({page})=>{
  const state=provider();
  state.payouts.data=[{...payout,payout_id:'mmx',amount_microusd:'0',amount_mmx_atomic:'40500000',state:'confirmed'},{...payout,payout_id:'usd',amount_mmx_atomic:'8002000',state:'confirmed'},{...payout,payout_id:'usd-open'}];
  await openDesktop(page,state);
  await page.getByRole('link',{name:'Payouts',exact:true}).click();
  const cells=page.locator('.payout-table tbody tr td:nth-child(2)');
  await expect(cells.nth(0)).toHaveText('40.5 MMX');
  await expect(cells.nth(1)).toHaveText('$40.018.002 MMX');
  await expect(cells.nth(2)).toHaveText('$40.01MMX amount set when prepared');
});

test('payout history uses public status notes and fits Linux window sizes',async({page})=>{
  const state=provider();
  state.payouts.data=[{...payout,state:'submitted',amount_mmx_atomic:'123000001',chain_transaction_id:'a'.repeat(64),waiting_reason:'exchange_rate',last_error:'backend error'}, {...payout,payout_id:'cancelled',state:'cancelled'}];
  await openDesktop(page,state);
  await page.getByRole('link',{name:'Payouts',exact:true}).click();
  await expect(page.locator('.payout-table')).toContainText('123.000001 MMX');
  await expect(page.locator('.payout-table')).toContainText('Waiting for the MMX exchange rate');
  await expect(page.locator('.payout-table')).toContainText('The amount is back in your earnings');
  await expect(page.getByText('backend error',{exact:true})).toHaveCount(0);
  for(const width of [760,800,1440]) {
    await page.setViewportSize({width,height:1000});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({animations:'disabled',path:`artifacts/visual-review/payouts-${width}.png`,fullPage:true});
  }
  await page.getByRole('button',{name:'Review payout',exact:true}).click();
  await expect(page.getByRole('button',{name:'Confirm payout',exact:true})).toBeInViewport();
  await page.screenshot({animations:'disabled',path:'artifacts/visual-review/payout-review.png'});
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByRole('button',{name:'Change theme',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.screenshot({animations:'disabled',path:'artifacts/visual-review/payouts-dark.png',fullPage:true});
  await page.locator('[data-review-payout]').click();
  await page.screenshot({animations:'disabled',path:'artifacts/visual-review/payout-review-dark.png'});
});
