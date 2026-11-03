import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const source = await fs.readFile(new URL('../src/workflows.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const { accountState, historyLabel, paymentNeedsUpdate, websitePasswordState, passwordExpiryDays, githubLabel, githubStep, githubWaitLimit, SIGNUP_AGREEMENT, TRIAL_LIMITS } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
test('automatic payment checks stop at ten confirmations and exclude drafts and terminal failures', () => {
  const payment = {transaction_id:'transaction',state:'included'};
  for (const confirmations of [undefined,null,0,1,9]) assert.equal(paymentNeedsUpdate({...payment,confirmations}),true);
  for (const confirmations of [10,11,100]) assert.equal(paymentNeedsUpdate({...payment,confirmations}),false);
  for (const state of ['broadcast','pending','submitting','uncertain']) assert.equal(paymentNeedsUpdate({...payment,state}),true);
  for (const state of ['prepared','discarded','failed','expired','complete','authorized']) assert.equal(paymentNeedsUpdate({...payment,state}),false);
  assert.equal(paymentNeedsUpdate({state:'pending'}),false);
});
test('activation requires an explicit unactivated account, never an outage or rejected key', () => {
  const keys = {data:{deposit_memo:'memo'}};
  assert.equal(accountState(keys, {data:{account_alias:'gh-test'}}), 'ready');
  for (const code of ['account_not_activated','unknown_account']) assert.equal(accountState(keys, {error:{code}}), 'unactivated');
  for (const code of ['operation_timeout','network_error','invalid_auth_key','retired_auth_key','auth_key_retired','unauthorized','account_unavailable']) assert.equal(accountState(keys, {error:{code}}), 'unavailable');
  assert.equal(accountState({error:{code:'account_key_missing'}}, {}), 'missing');
  assert.equal(accountState({error:{code:'invalid_seed'}}, {error:{code:'account_not_activated'}}), 'unavailable');
});
test('fees and mining rewards cannot masquerade as sent payments', () => {
  assert.equal(historyLabel('SPEND'), 'Sent');
  assert.equal(historyLabel('SEND'), 'Sent');
  assert.equal(historyLabel('RECEIVE'), 'Received');
  assert.equal(historyLabel('TXFEE'), 'Network fee');
  assert.equal(historyLabel('REWARD'), 'Block reward');
  assert.equal(historyLabel('VDF_REWARD'), 'VDF reward');
  assert.equal(historyLabel('PROJECT_REWARD'), 'Project reward');
  assert.equal(historyLabel('FUTURE_EVENT'), 'FUTURE EVENT');
});
test('the website password reads as none, set or expired, and its expiry takes whole days', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  assert.equal(websitePasswordState(null, now), 'none');
  assert.equal(websitePasswordState(undefined, now), 'none');
  assert.equal(websitePasswordState({created_at:'2026-10-01T00:00:00Z'}, now), 'set');
  assert.equal(websitePasswordState({created_at:'2026-10-01T00:00:00Z',expires_at:null}, now), 'set');
  assert.equal(websitePasswordState({created_at:'2026-10-01T00:00:00Z',expires_at:'2026-12-01T00:00:00Z'}, now), 'set');
  assert.equal(websitePasswordState({created_at:'2026-01-01T00:00:00Z',expires_at:'2026-04-01T00:00:00Z'}, now), 'expired');
  assert.equal(passwordExpiryDays(''), null);
  assert.equal(passwordExpiryDays('  '), null);
  assert.equal(passwordExpiryDays('90'), 90);
  assert.equal(passwordExpiryDays(' 1 '), 1);
  assert.equal(passwordExpiryDays('3650'), 3650);
  for (const text of ['0','3651','-5','1.5','1e2','90 --print','ninety']) assert.equal(passwordExpiryDays(text), undefined, text);
});
test('a GitHub claim waits for the sign-in until it is created, refused or past its wait limit', () => {
  const limit = 12 * 60_000, before = limit - 1, after = limit;
  assert.deepEqual(githubStep({status:'pending'}, 0, limit), {state:'waiting'});
  assert.deepEqual(githubStep({status:'pending'}, before, limit), {state:'waiting'});
  assert.deepEqual(githubStep(null, before, limit), {state:'waiting'}, 'a reading that failed');
  assert.deepEqual(githubStep({status:'unknown'}, before, limit), {state:'waiting'}, 'a status of a newer release');
  assert.deepEqual(githubStep({status:'pending'}, after, limit), {state:'expired'});
  assert.deepEqual(githubStep(null, after, limit), {state:'expired'});
  assert.deepEqual(githubStep({status:'created',account_alias:'gh-trial001'}, after, limit), {state:'created'});
  assert.deepEqual(githubStep({status:'linked',account_alias:'gh-abcdefgh'}, before, limit), {state:'linked'});
  assert.deepEqual(githubStep({status:'refused',reason:'The GitHub account had a trial.'}, before, limit), {state:'refused',reason:'The GitHub account had a trial.'});
  assert.deepEqual(githubStep({status:'refused'}, before, limit), {state:'refused',reason:'The GitHub claim was refused.'});
  assert.match(TRIAL_LIMITS, /1 vCPU/);
});
test('a GitHub claim is followed past its expiry, for a whole lifetime and the exchange margin at least', () => {
  const now = Date.parse('2026-10-16T12:00:00Z'), at = seconds => new Date(now + seconds * 1000).toISOString();
  // The sign-in made at 9:55 of 10:00 finishes after the expiry: the wait is not over at it.
  assert.equal(githubWaitLimit(at(600), now), 12 * 60_000);
  assert.equal(githubStep({status:'pending'}, 10 * 60_000 + 1, githubWaitLimit(at(600), now))?.state, 'waiting');
  // A computer clock ahead of the backend's reads the expiry sooner; the wait is not cut short.
  assert.equal(githubWaitLimit(at(300), now), 12 * 60_000);
  assert.equal(githubWaitLimit(at(-30), now), 12 * 60_000);
  // A clock behind the backend's leaves more.
  assert.equal(githubWaitLimit(at(900), now), 17 * 60_000);
  assert.equal(githubWaitLimit('', now), 12 * 60_000);
});
test('the linked GitHub account reads as one line from the object ghost account show prints', () => {
  assert.equal(githubLabel({login:'octocat',linked_at:'2026-10-12T10:00:00Z'}), '@octocat (linked 2026-10-12)');
  assert.equal(githubLabel({login:'octocat'}), '@octocat');
  assert.equal(githubLabel({linked_at:'2026-10-12T10:00:00Z'}), null);
  assert.equal(githubLabel(null), null);
  assert.equal(githubLabel(undefined), null);
});
test('activating names the Terms and asks that the service starts at once, as the website and ghost do', () => {
  assert.match(SIGNUP_AGREEMENT, /^By activating the account, with GitHub or with a deposit, you agree to the Terms of Service and the Acceptable Use Policy/);
  assert.match(SIGNUP_AGREEMENT, /ghostrack\.io\/terms/);
  assert.match(SIGNUP_AGREEMENT, /ask that the service starts at once\.$/);
});
