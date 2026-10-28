import { test, expect } from '@playwright/test';
import { address, fixture, openDesktop } from './fixtures';
import { mkdir } from 'node:fs/promises';
const shots='artifacts/visual-review';
test('review desktop pages and long paths at common window sizes',async({page})=>{
  await mkdir(shots,{recursive:true});
  const state=structuredClone(fixture);
  state.settings.wallet_file='/home/new-user/private key backups/'+ 'long folder name/'.repeat(7) + 'mmxwallet.dat';
  state.ghost_seed_file=state.settings.ghost_seed_file='/home/new-user/private key backups/'+ 'long folder name/'.repeat(7) + 'account.seed';
  await openDesktop(page,state);
  for(const width of [760,800,1024,1180,1600]) {
    await page.setViewportSize({width,height:width<1000 ? 600 : 820});
    for(const hash of ['home','wallet','account','settings']) {
      await page.goto('/#'+hash);
      await expect(page.locator('#main h1')).toBeVisible();
      if(hash==='wallet') await page.getByRole('tab',{name:'Receive'}).click();
      await page.screenshot({animations:'disabled',path:`${shots}/${hash}-${width}.png`,fullPage:true});
      const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,main:document.querySelector('#main')!.getBoundingClientRect().toJSON()}));
      expect(overflow.scroll,`${hash} at ${width}px`).toBeLessThanOrEqual(width);
      if(hash==='home') {
        const cards=await page.locator('.balance-block').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().width));
        expect(Math.abs(cards[0]-cards[1])).toBeLessThan(1);
      }
    }
  }
});
test('review small-window payment and restore dialogs',async({page})=>{
  await mkdir(shots,{recursive:true});
  await page.setViewportSize({width:800,height:600});
  await openDesktop(page);
  await page.getByRole('button',{name:'Send MMX'}).click();
  await page.getByLabel('Recipient address').fill(address);
  await page.getByLabel('Amount in MMX').fill('0.000001');
  await page.getByLabel('Memo (optional)').fill('long memo with punctuation and 世界');
  await page.getByRole('button',{name:'Review payment'}).click();
  await page.screenshot({animations:'disabled',path:`${shots}/payment-800.png`});
  await page.getByRole('button',{name:'Confirm and send'}).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button',{name:'Confirm and send'})).toBeInViewport();
  await page.screenshot({animations:'disabled',path:`${shots}/payment-800-scrolled.png`});
  await page.getByRole('button',{name:'Close dialog'}).click();
  await page.getByRole('link',{name:'Account'}).click();
  await page.getByLabel('Approval link or request ID').fill('d991d038-bbfc-4a9b-82dd-0d1cf33281b7');
  await page.getByRole('button',{name:'Review request'}).click();
  await page.getByRole('button',{name:'Authorize restore',exact:true}).scrollIntoViewIfNeeded();
  await expect(page.getByLabel('I reviewed the destination and charge, and authorize this restore.')).toBeInViewport();
  await expect(page.getByRole('button',{name:'Authorize restore',exact:true})).toBeInViewport();
  await page.screenshot({animations:'disabled',path:`${shots}/restore-800.png`});
});

test('app bar and page headings stay fixed when views change or scroll',async({page})=>{
  await page.setViewportSize({width:1600,height:1000});
  await openDesktop(page);
  const before=await page.locator('#main').boundingBox();
  await page.getByRole('link',{name:'Settings'}).click();
  const after=await page.locator('#main').boundingBox();
  expect(after!.y).toBe(before!.y);
  await page.getByRole('button',{name:'Save settings'}).scrollIntoViewIfNeeded();
  expect((await page.locator('.desktop-bar').boundingBox())!.y).toBe(0);
  await expect(page.getByRole('link',{name:'Overview'})).toBeInViewport();
});

test('the app bar wears the website theme: paper, a hairline, the lockup at 32 px and the website fonts',async({page})=>{
  const fonts:string[]=[];
  page.on('response',response=>{if(response.url().endsWith('.woff2')) fonts.push(`${response.url().split('/').pop()} ${response.status()}`);});
  await openDesktop(page);
  const bar=await page.locator('.desktop-bar').evaluate(node=>({background:getComputedStyle(node).backgroundColor,border:getComputedStyle(node).borderBottomStyle,page:getComputedStyle(document.documentElement).backgroundColor}));
  expect(bar.background).toBe(bar.page);
  expect(bar.border).toBe('solid');
  const lockup=(await page.locator('.desktop-brand svg').boundingBox())!;
  expect(lockup.height).toBe(32);
  expect(Math.round(lockup.width)).toBe(138);
  const loaded=await page.evaluate(()=>Promise.all(['16px "Instrument Sans"','16px "Geist Mono"'].map(font=>document.fonts.load(font).then(faces=>faces.length,()=>0))));
  expect(loaded).toEqual([1,1]);
  expect([...new Set(fonts)].sort()).toEqual(['geist-mono.woff2 200','instrument-sans.woff2 200']);
});

test('skip to content preserves the current view',async({page})=>{
  await openDesktop(page);
  await page.getByRole('link',{name:'Wallet',exact:true}).click();
  await page.locator('.skip-link').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading',{name:'Your MMX wallet.'})).toBeVisible();
  await expect(page.locator('#main')).toBeFocused();
});

test('settings inputs and the restore review button align with adjacent controls',async({page})=>{
  await openDesktop(page);
  for(const width of [800,1180]) {
    await page.setViewportSize({width,height:820});
    await page.getByRole('link',{name:'Settings',exact:true}).click();
    const account=await page.getByLabel('MMX derivation account',{exact:true}).boundingBox();
    const addresses=await page.getByLabel('Addresses to scan',{exact:true}).boundingBox();
    expect(Math.abs(account!.y-addresses!.y)).toBeLessThan(1);
    expect(Math.abs(account!.height-addresses!.height)).toBeLessThan(1);
    await page.getByRole('link',{name:'Account',exact:true}).click();
    const reference=await page.getByLabel('Approval link or request ID').boundingBox();
    const button=await page.getByRole('button',{name:'Review request',exact:true}).boundingBox();
    expect(Math.abs(reference!.y-button!.y)).toBeLessThan(1);
    expect(Math.abs(reference!.height-button!.height)).toBeLessThan(1);
  }
});

function populatedProvider() {
  const state:any=structuredClone(fixture);
  state.provider_balance={data:{pending_payout_microusd:'90000000',available_payout_microusd:'65500001',held_microusd:'24499999',on_the_way_microusd:'40010000',sla_settlement_pending:false,payout_address:address},error:null};
  state.payouts={data:[{payout_id:'d991d038-bbfc-4a9b-82dd-0d1cf33281b7',destination_address:address,amount_microusd:'40010000',amount_mmx_atomic:'200050000',state:'submitted',chain_transaction_id:'a'.repeat(64),requested_at:'2026-10-07T00:00:00Z',waiting_reason:null}],error:null};
  return state;
}

for (const mode of [
  {theme:'light',scheme:'dark'}, {theme:'dark',scheme:'light'},
  {theme:'system',scheme:'light'}, {theme:'system',scheme:'dark'},
] as const) test(`custom desktop surfaces follow ${mode.theme} theme with ${mode.scheme} system colors`,async({page})=>{
  await mkdir(shots,{recursive:true});
  await page.emulateMedia({colorScheme:mode.scheme});
  const state=populatedProvider(); state.settings.theme=mode.theme;
  await openDesktop(page,state);
  await expect(page.locator('#main h1')).toBeVisible();
  const values=await page.evaluate(()=>{
    const css=(selector:string)=>getComputedStyle(document.querySelector(selector)!);
    const reference=document.createElement('div');
    reference.style.cssText='background:var(--color-selected-surface);border:var(--rule-signal) solid var(--color-accent);height:var(--bar-height);';
    document.body.append(reference);
    const expected=getComputedStyle(reference),panel=css('.balance-block'),section=css('.section'),nav=css('[aria-current=page]');
    const result={panel:[panel.backgroundColor,panel.borderRadius,panel.borderTopWidth],section:[section.backgroundColor,section.borderRadius,section.borderTopWidth],nav:[nav.backgroundColor,nav.borderLeftColor,nav.borderLeftWidth],selected:[expected.backgroundColor,expected.borderLeftColor,expected.borderLeftWidth],bar:css('.desktop-bar').height,barToken:expected.height,titleSize:parseFloat(css('.page-top h1').fontSize),sectionTitleSize:parseFloat(css('.section-title').fontSize),titleWeight:Number(css('.page-top h1').fontWeight),scheme:css('html').colorScheme};
    reference.remove(); return result;
  });
  expect(values.panel).toEqual(values.section);
  expect(values.nav).toEqual(values.selected);
  expect(values.bar).toBe(values.barToken);
  expect(values.titleSize).toBeGreaterThan(values.sectionTitleSize);
  expect(values.titleWeight).toBeLessThan(700);
  // Opposite OS preferences verify explicit selection wins; system tracks the OS.
  expect(values.scheme).toBe(mode.theme==='system' ? mode.scheme : mode.theme);
  if(mode.theme!=='system') await page.screenshot({animations:'disabled',path:`${shots}/theme-${mode.theme}-home.png`,fullPage:true});
  await page.getByRole('link',{name:'Wallet',exact:true}).click();
  await expect(page.getByLabel('Recipient address',{exact:true})).toBeVisible();
  await page.mouse.move(0,0);
  const controls=await page.evaluate(()=>{
    const css=(selector:string)=>getComputedStyle(document.querySelector(selector)!);
    const input=css('#target'),button=css('#send-form .btn'),tab=css('[role=tab][aria-selected=true]'),nav=css('[aria-current=page]');
    return {input:[input.height,input.borderRadius],button:[button.height,button.borderRadius],tab:[tab.backgroundColor,tab.borderBottomColor,tab.borderBottomWidth],nav:[nav.backgroundColor,nav.borderLeftColor,nav.borderLeftWidth]};
  });
  expect(controls.input).toEqual(controls.button);
  expect(controls.tab).toEqual(controls.nav);
  if(mode.theme!=='system') {
    for(const hash of ['wallet','account','payouts','settings']) {
      await page.goto('/#'+hash);
      await expect(page.locator('#main h1')).toBeVisible();
      await page.screenshot({animations:'disabled',path:`${shots}/theme-${mode.theme}-${hash}.png`,fullPage:true});
    }
  }
  await page.getByRole('link',{name:'Overview',exact:true}).click();
  // Top-ups exercise read-only controls as well as the payment review.
  await page.getByRole('button',{name:'Add funds',exact:true}).click();
  const readonly=await page.locator('#target').evaluate(node=>({readonly:(node as HTMLInputElement).readOnly,bg:getComputedStyle(node).backgroundColor,radius:getComputedStyle(node).borderRadius}));
  expect(readonly.readonly).toBe(true);
  expect(readonly.radius).toBe(controls.input[1]);
  expect(readonly.bg).not.toBe(values.panel[0]);
  await page.getByLabel('Amount in MMX',{exact:true}).fill('0.000001');
  await page.getByRole('button',{name:'Review payment',exact:true}).click();
  const modal=await page.getByRole('dialog').evaluate(node=>{
    const expected=document.createElement('div'); expected.style.background='var(--color-surface-raised)'; node.append(expected);
    const result={bg:getComputedStyle(node).backgroundColor,expected:getComputedStyle(expected).backgroundColor,radius:getComputedStyle(node).borderRadius}; expected.remove(); return result;
  });
  expect(modal.bg).toBe(modal.expected);
  expect(modal.radius).toBe(values.panel[1]);
  await expect(page.getByRole('button',{name:'Confirm and send',exact:true})).toBeInViewport();
  if(mode.theme!=='system') await page.screenshot({animations:'disabled',path:`${shots}/theme-${mode.theme}-payment.png`});
});

test('all five populated views fit the minimum window and setup keeps the shared panel shape',async({page})=>{
  await mkdir(shots,{recursive:true});
  await page.setViewportSize({width:360,height:820});
  await openDesktop(page,populatedProvider());
  for(const hash of ['home','wallet','account','payouts','settings']) {
    await page.goto('/#'+hash);
    await expect(page.locator('#main h1')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth),hash).toBeLessThanOrEqual(360);
    expect(await page.locator('[aria-current=page]').evaluate(node=>getComputedStyle(node).borderBottomWidth)).toBe('2px');
    await page.screenshot({animations:'disabled',path:`${shots}/minimum-${hash}.png`,fullPage:true});
  }
  const setup:any=structuredClone(fixture); setup.wallet=null; setup.keys={data:null,error:null}; setup.account={data:null,error:null};
  await page.setViewportSize({width:1180,height:820});
  await openDesktop(page,setup);
  await expect(page.getByRole('heading',{name:'A place for your MMX.',exact:true})).toBeVisible();
  const panels=await page.locator('.setup-step,.balance-block').evaluateAll(nodes=>nodes.map(node=>({radius:getComputedStyle(node).borderRadius,border:getComputedStyle(node).borderTopWidth})));
  expect(panels.every(panel=>panel.radius===panels[0].radius && panel.border==='1px')).toBe(true);
  await page.screenshot({animations:'disabled',path:`${shots}/setup-missing-wallet.png`,fullPage:true});
});
