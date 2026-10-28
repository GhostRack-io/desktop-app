import { test, expect } from '@playwright/test';
import { fixture, address, openDesktop } from './fixtures';

test('outages and invalid account keys show the error without requesting an activation payment', async ({page}) => {
  const state:any = structuredClone(fixture);
  state.account = {data:null,error:{code:'operation_timeout',message:'Account service is unavailable'}};
  await openDesktop(page,state);
  await expect(page.getByRole('button',{name:'Activate account',exact:true})).toHaveCount(0);
  await expect(page.getByText('Account service is unavailable',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Account',exact:true}).click();
  await expect(page.getByRole('button',{name:'Retry account lookup'})).toBeVisible();
  await expect(page.getByText('Lookup unavailable',{exact:true})).toBeVisible();
});

test('wallet creation uses typed passphrases exactly and requires matching confirmation', async ({page}) => {
  const state:any = structuredClone(fixture); state.wallet=null;
  await openDesktop(page,state);
  await page.getByRole('button',{name:'Create wallet',exact:true}).click();
  await page.getByLabel('Optional derivation passphrase',{exact:true}).fill('  keep my spaces  ');
  await page.getByRole('dialog').getByRole('button',{name:'Create wallet',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('do not match');
  expect(await page.evaluate(()=>(window as any).calls.some((r:any)=>r.action === 'create_wallet'))).toBe(false);
  await page.getByLabel('Confirm derivation passphrase',{exact:true}).fill('  keep my spaces  ');
  await page.getByRole('dialog').getByRole('button',{name:'Create wallet',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('heading',{name:'Your wallet is ready.'})).toBeFocused();
  expect(await page.evaluate(()=>(window as any).calls.find((r:any)=>r.action === 'create_wallet').passphrase)).toBe('  keep my spaces  ');
});

test('manual refresh retains recipient, amount, memo and UTF-8 count', async ({page}) => {
  await openDesktop(page);
  await page.getByRole('button',{name:'Send MMX'}).click();
  await page.getByLabel('Recipient address').fill(address);
  await page.getByLabel('Amount in MMX').fill('0.000001');
  await page.getByLabel('Memo (optional)').fill('é🔑');
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.getByLabel('Recipient address')).toHaveValue(address);
  await expect(page.getByLabel('Amount in MMX')).toHaveValue('0.000001');
  await expect(page.getByLabel('Memo (optional)')).toHaveValue('é🔑');
  await expect(page.locator('#memo-count')).toHaveText('6 / 64 UTF-8 bytes');
});

test('refresh updates authoritative funding fields while retaining the typed amount', async ({page}) => {
  await openDesktop(page);
  await page.getByRole('button',{name:'Add funds'}).click();
  await page.getByLabel('Amount in MMX').fill('2');
  await page.evaluate(()=>{
    const original=(window as any).__DESKTOP_TEST__;
    (window as any).__DESKTOP_TEST__=async(request:any)=>{
      const result=await original(request);
      if(request.action === 'snapshot') { result.keys.data.deposit_memo='new-account-memo'; result.activation_terms.data.deposit_address='mmx1new-authoritative-address'; }
      return result;
    };
  });
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.getByLabel('Recipient address')).toHaveValue('mmx1new-authoritative-address');
  await expect(page.getByLabel('Account deposit memo')).toHaveValue('new-account-memo');
  await expect(page.getByLabel('Amount in MMX')).toHaveValue('2');
});

test('fresh zero-balance activation offers receiving without submitting a payment', async ({page}) => {
  const state:any=structuredClone(fixture);
  state.account={data:null,error:{code:'account_not_activated',message:'API returned 401 Unauthorized: account_not_activated: activate it with ghost account activate'}};
  state.wallet.balance.data.balances[0].amount='0';
  await openDesktop(page,state);
  await page.getByRole('button',{name:'Activate account',exact:true}).click();
  await expect(page.getByText(/After 6 confirmations, choose Check activation/)).toBeVisible();
  await page.getByRole('button',{name:'Receive MMX first',exact:true}).click();
  await expect(page.locator('#receive-address')).toHaveText(address);
  expect(await page.evaluate(()=>(window as any).calls.some((r:any)=>r.action === 'prepare_send'))).toBe(false);
});

test('the backend unactivated response leads through GUI payment and account activation', async ({page}) => {
  const state:any=structuredClone(fixture);
  state.account={data:null,error:{code:'account_not_activated',message:'API returned 401 Unauthorized: account_not_activated: run ghost account activate'}};
  await openDesktop(page,state);
  await expect(page.getByText('Activation needed',{exact:true})).toBeVisible();
  await expect(page.getByText(/API returned 401/)).toHaveCount(0);
  await page.getByRole('link',{name:'Account',exact:true}).click();
  await expect(page.getByText(/API returned 401/)).toHaveCount(0);
  await page.getByRole('button',{name:'Activate account',exact:true}).click();
  await expect(page.getByLabel('Recipient address',{exact:true})).toHaveValue(address);
  await expect(page.getByLabel('Account deposit memo',{exact:true})).toHaveValue('gh-test-memo');
  await expect(page.getByLabel('Amount in MMX',{exact:true})).toHaveValue('1');
  await page.getByRole('button',{name:'Review payment',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).calls.some((r:any)=>r.action === 'broadcast'))).toBe(false);
  await page.getByRole('button',{name:'Confirm and send',exact:true}).click();
  await expect(page.getByRole('link',{name:'Account',exact:true})).toHaveAttribute('aria-current','page');
  await expect(page.getByRole('button',{name:'Check activation',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Activate account',exact:true})).toHaveCount(0);
  await page.evaluate(()=>{
    const original=(window as any).__DESKTOP_TEST__;
    (window as any).__DESKTOP_TEST__=async(request:any)=>{
      const result=await original(request);
      if(request.action === 'activate_account') {
        const snapshot=await original({action:'snapshot'});
        snapshot.account={data:{account_alias:'gh-new-account',status:'active',key_epoch:1},error:null};
      }
      return result;
    };
  });
  await page.getByRole('button',{name:'Check activation',exact:true}).click();
  await expect(page.getByRole('heading',{name:'gh-new-account',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Open Gigahost',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'prepare_send').length)).toBe(1);
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'activate_account').length)).toBe(1);
});

test('receive refresh falls back to a current address when the selection disappears', async ({page}) => {
  const state:any=structuredClone(fixture);
  state.wallet.addresses.data.addresses=[address,'mmx1previous-second-address'];
  await openDesktop(page,state);
  await page.getByRole('button',{name:'Receive',exact:true}).click();
  await page.getByLabel('Receiving address',{exact:true}).selectOption('mmx1previous-second-address');
  await page.evaluate(()=>{
    const original=(window as any).__DESKTOP_TEST__;
    (window as any).__DESKTOP_TEST__=async(request:any)=>{
      const result=await original(request);
      if(request.action === 'snapshot') result.wallet.addresses.data.addresses=['mmx1current-first-address','mmx1current-second-address'];
      return result;
    };
  });
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.locator('#receive-address')).toHaveText('mmx1current-first-address');
  await expect(page.getByLabel('Receiving address',{exact:true})).toHaveValue('mmx1current-first-address');
});

test('wallet tabs support arrows, Home and End while keeping keyboard focus', async ({page}) => {
  await openDesktop(page);
  await page.getByRole('link',{name:'Wallet',exact:true}).click();
  await page.getByRole('tab',{name:'Send',exact:true}).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab',{name:'Receive',exact:true})).toBeFocused();
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby','wallet-tab-receive');
  await page.keyboard.press('End');
  await expect(page.getByRole('tab',{name:'History',exact:true})).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab',{name:'Send',exact:true})).toBeFocused();
  await expect(page.getByRole('tab',{name:'Receive',exact:true})).toHaveAttribute('tabindex','-1');
});

test('authorization progress persists and failures stay inside the restore dialog', async ({page}) => {
  await openDesktop(page);
  await page.clock.install();
  await page.evaluate(()=>{
    const original=(window as any).__DESKTOP_TEST__;
    (window as any).__DESKTOP_TEST__=(request:any)=> request.action === 'approve_restore' ? new Promise((_,reject)=>{ (window as any).failRestore=()=>reject({message:'Destination could not be reached. Resume this request.'}); }) : original(request);
  });
  await page.getByRole('link',{name:'Account',exact:true}).click();
  await page.getByLabel('Approval link or request ID').fill('d991d038-bbfc-4a9b-82dd-0d1cf33281b7');
  await page.getByRole('button',{name:'Review request'}).click();
  await page.getByRole('button',{name:'Authorize restore',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('reviewed the restore');
  await page.getByLabel('I reviewed the destination and charge, and authorize this restore.').check();
  await page.getByRole('button',{name:'Authorize restore',exact:true}).click();
  await page.clock.fastForward(120_000);
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('This can take several minutes');
  await expect(page.getByRole('dialog')).toHaveAttribute('aria-busy','true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(()=>(window as any).failRestore());
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Destination could not be reached');
  await expect(page.getByRole('button',{name:'Authorize restore',exact:true})).toBeEnabled();
  await page.clock.fastForward(30_000);
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
});

test('removing an older recovery location saves the remaining registry', async ({page}) => {
  const state:any=structuredClone(fixture); state.settings.recovery_seed_files=['/tmp/first.seed','/tmp/second.seed'];
  await openDesktop(page,state);
  await page.getByRole('link',{name:'Settings',exact:true}).click();
  await page.locator('[data-remove-recovery="/tmp/first.seed"]').click();
  await expect(page.locator('.recovery-list')).not.toContainText('/tmp/first.seed');
  await expect(page.locator('.recovery-list')).toContainText('/tmp/second.seed');
  expect(await page.evaluate(()=>(window as any).calls.find((r:any)=>r.action === 'save_settings').settings.recovery_seed_files)).toEqual(['/tmp/second.seed']);
});

test('appearance changes keep the loaded passphrase and explicit forget clears it', async ({page}) => {
  await openDesktop(page);
  await page.getByRole('button',{name:'Send MMX'}).click();
  await page.getByRole('button',{name:'Unlock wallet',exact:true}).click();
  await page.getByLabel('Derivation passphrase',{exact:true}).fill('private test phrase');
  await page.getByRole('dialog').getByRole('button',{name:'Unlock wallet',exact:true}).click();
  await page.getByRole('link',{name:'Settings',exact:true}).click();
  await page.getByLabel('Theme',{exact:true}).selectOption('dark');
  await page.getByRole('button',{name:'Save settings',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'snapshot').at(-1).passphrase)).toBe('private test phrase');
  await page.getByRole('button',{name:'Forget derivation passphrase',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'snapshot').at(-1).passphrase)).toBe(null);
  await expect(page.getByRole('status')).toContainText('Wallet files remain unencrypted');
});

test('history distinguishes block rewards, other rewards, fees, and outgoing payments', async ({page}) => {
  const state:any=structuredClone(fixture);
  state.wallet.history.data.history=['REWARD','VDF_REWARD','PROJECT_REWARD','TXFEE','SPEND','RECEIVE'].map((type,index)=>({type,amount:'1',txid:String(index).repeat(64),is_pending:false,time_stamp:1700000000000}));
  await openDesktop(page,state);
  await page.getByRole('link',{name:'Wallet',exact:true}).click();
  await page.getByRole('tab',{name:'History',exact:true}).click();
  for(const [index,label] of ['Block reward','VDF reward','Project reward','Network fee','Sent','Received'].entries()) {
    await expect(page.locator('.desktop-table tbody tr').nth(index).locator('td').first()).toHaveText(label);
  }
});

test('a GitHub sign-up opens the sign-in, follows the claim and shows the new account', async ({page}) => {
  const state:any=structuredClone(fixture);
  state.account={data:null,error:{code:'account_not_activated',message:'run ghost account activate'}};
  await openDesktop(page,state);
  await page.getByRole('link',{name:'Account',exact:true}).click();
  await page.evaluate(()=>{
    const original=(window as any).__DESKTOP_TEST__;
    (window as any).__DESKTOP_TEST__=async(request:any)=>{
      if(['github_signup','github_status'].includes(request.action)) (window as any).calls.push(request);
      if(request.action === 'github_signup') return {claim_id:'claim-one',expires_at:new Date(Date.now()+600_000).toISOString()};
      if(request.action === 'github_status') {
        const snapshot=await original({action:'snapshot'});
        snapshot.account={data:{account_alias:'gh-trial001',status:'active',key_epoch:1,trial:{credit_left_microusd:'5000000',expires_at:'2099-01-01T00:00:00Z',limited:true}},error:null};
        return {status:'created',account_alias:'gh-trial001',github_login:'octocat',trial_credit:true,expires_at:'2099-01-01T00:00:00Z'};
      }
      return original(request);
    };
  });
  await page.getByRole('button',{name:'Sign up with GitHub',exact:true}).click();
  await expect(page.getByText('Waiting for GitHub',{exact:true})).toBeVisible();
  await expect(page.getByText('Trial credit left',{exact:true})).toBeVisible({timeout:10_000});
  await expect(page.getByText('$5.00',{exact:true}).first()).toBeVisible();
  await expect(page.getByText(/Trial limits hold until you add funds/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Sign up with GitHub',exact:true})).toHaveCount(0);
  const calls=await page.evaluate(()=>(window as any).calls.map((r:any)=>r.action));
  expect(calls).toContain('github_signup');
  expect(calls).toContain('github_status');
  await expect(page.getByText(/signed up with @octocat. The trial credit came with it./)).toBeVisible();
});

test('a GitHub link is followed to its end', async ({page}) => {
  await openDesktop(page);
  await page.getByRole('link',{name:'Account',exact:true}).click();
  await page.evaluate(()=>{
    const original=(window as any).__DESKTOP_TEST__;
    (window as any).__DESKTOP_TEST__=async(request:any)=>{
      if(['github_link','github_status','github_unlink'].includes(request.action)) (window as any).calls.push(request);
      if(request.action === 'github_link') return {claim_id:'claim-two',expires_at:new Date(Date.now()+600_000).toISOString()};
      if(request.action === 'github_status') return {status:'linked',account_alias:'gh-test-account',github_login:'octocat',trial_credit:false,expires_at:'2099-01-01T00:00:00Z'};
      if(request.action === 'github_unlink') return {unlinked:true,ended_sessions:0};
      return original(request);
    };
  });
  await expect(page.getByText('Not linked',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Link GitHub',exact:true}).click();
  await expect(page.getByText('Waiting for GitHub',{exact:true})).toBeVisible();
  await expect(page.getByText(/@octocat is linked./)).toBeVisible({timeout:10_000});
  expect(await page.evaluate(()=>(window as any).calls.map((r:any)=>r.action))).toEqual(expect.arrayContaining(['github_link','github_status']));
});

test('unlinking GitHub asks before it sends anything', async ({page}) => {
  const state:any=structuredClone(fixture);
  state.account.data.github={login:'octocat',linked_at:'2026-10-12T10:00:00Z'};
  await openDesktop(page,state);
  await page.getByRole('link',{name:'Account',exact:true}).click();
  await expect(page.getByText('@octocat (linked 2026-10-12)',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Unlink GitHub',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('Log in with GitHub stops working');
  expect(await page.evaluate(()=>(window as any).calls.some((r:any)=>r.action === 'github_unlink'))).toBe(false);
  await page.getByRole('dialog').getByRole('button',{name:'Unlink GitHub',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).calls.some((r:any)=>r.action === 'github_unlink'))).toBe(true);
});

test('an account key is imported from a pasted line, and replacing the current one is asked first', async ({page}) => {
  const state:any=structuredClone(fixture);
  state.keys={data:null,error:{code:'io_error',message:'No account key yet.'}};
  state.account={data:null,error:null};
  state.import_exists=true;
  await openDesktop(page,state);
  await page.getByRole('link',{name:'Account',exact:true}).click();
  await page.getByRole('button',{name:'Import account key',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByLabel('Or paste the account key line')).toHaveAttribute('type','password');
  // Both or neither of a file and a line is refused before anything is sent.
  await dialog.getByRole('button',{name:'Import account key',exact:true}).click();
  await expect(dialog).toContainText('one of the two');
  const line='gigahost-account-seed-v1:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
  await dialog.getByLabel('Or paste the account key line').fill(line);
  await dialog.getByRole('button',{name:'Import account key',exact:true}).click();
  await expect(dialog).toContainText('Your current account key is kept.');
  await dialog.getByRole('button',{name:'Replace',exact:true}).click();
  await expect(dialog).toContainText('The previous one is kept at:');
  await expect(dialog).toContainText('.replaced-20261019T120000Z');
  await expect(dialog).toContainText('this key has no account yet');
  const imports=await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'import_account'));
  expect(imports).toEqual([{action:'import_account',file:null,line,replace:false},{action:'import_account',file:null,line,replace:true}]);
  await expect(dialog).not.toContainText(line);
});
