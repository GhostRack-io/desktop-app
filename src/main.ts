import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import QRCode from 'qrcode';
import { usd, usdExact, mmx, topUpUsd, payoutMmx, memoBytes, escape as e } from './money';
import { accountState, historyLabel, paymentNeedsUpdate, payoutNeedsUpdate, payoutLabel, payoutNote, websitePasswordState, passwordExpiryDays, githubLabel, githubStep, githubWaitLimit, SIGNUP_AGREEMENT, TRIAL_LIMITS } from './workflows';

type Json = any;
type Page = 'home' | 'wallet' | 'account' | 'payouts' | 'settings';
const pages = ['home','wallet','account','payouts','settings'];
let snapshot: Json = null;
let page: Page = 'home';
let tab = 'send';
let passphrase: string | null = null;
let busy = false;
let polling = false;
let lastPollAt = Date.now();
let lastError = '';
let generation = 0;
let purpose = 'send';
let toastTimer: ReturnType<typeof setTimeout>;
let modalReturnFocus: HTMLElement | null = null;
let deferredFocus: HTMLElement | null = null;
// The GitHub claim (a sign-up or a link) being followed: waiting for the GitHub sign-in, or how it ended.
let githubClaim: Json = null;
// An import waiting for the choice to replace the current account key; the
// pasted line, if any, lives only here until the dialog closes.
let pendingImport: { file: string | null, line: string | null } | null = null;
const main = document.querySelector<HTMLElement>('#main')!;
const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
const native = Boolean((window as any).__TAURI_INTERNALS__);
async function call(request: Json): Promise<Json> {
  // Browser previews have no signing authority. Tests install an explicit IPC mock.
  if ((window as any).__DESKTOP_TEST__) return (window as any).__DESKTOP_TEST__(request);
  if (!native) throw { message: 'Open the installed Gigahost desktop app to use your keys.' };
  return invoke('desktop', { request });
}
function notify(message: string, error = false) {
  if (dialog.open) {
    const status = dialog.querySelector<HTMLElement>(error ? '#dialog-error' : '#dialog-status')!;
    status.textContent = message; status.hidden = false;
    if (error) dialog.querySelector<HTMLElement>('#dialog-status')!.hidden = true;
    status.scrollIntoView({ block: 'nearest' });
    return;
  }
  const toast = document.querySelector<HTMLElement>('#toast')!;
  toast.textContent = message; toast.dataset.tone = error ? 'danger' : 'success'; toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 12000 : 6000);
}
function message(error: Json) { return error?.message || 'The operation could not be completed.'; }
function data(name: string) { return snapshot?.[name]?.data; }
function walletData(name: string) { return snapshot?.wallet?.[name]?.data; }
function badge(text: string, tone = 'info') { return `<span class="badge" data-tone="${e(tone)}">${e(text.replaceAll('_', ' '))}</span>`; }
function fact(label: string, value: unknown, code = false, className = '') { return `<div class="fact${className ? ' '+e(className) : ''}"><dt>${e(label)}</dt><dd${code ? ' class="code"' : ''}>${e(value ?? '—')}</dd></div>`; }
function button(label: string, action: string, primary = false, disabled = false) { return `<button type="button" class="btn${primary ? ' btn--primary' : ''}" data-action="${e(action)}"${disabled ? ' disabled' : ''}>${e(label)}</button>`; }
function header(title: string, lead: string, action = '') { return `<header class="page-top"><div><span class="eyebrow">${e(page === 'home' ? 'YOUR WORKSPACE' : page === 'wallet' ? 'MMX WALLET' : page === 'account' ? 'GIGAHOST ACCOUNT' : page === 'payouts' ? 'PROVIDER EARNINGS' : 'PREFERENCES')}</span><h1>${e(title)}</h1><p>${e(lead)}</p></div>${action}</header>`; }
function errorLine(result: Json) { return result?.error ? `<p class="error-inline">${e(result.error.message)}</p>` : ''; }
function field(label: string, name: string, value = '', type = 'text', hint = '', required = false) { return `<div class="field-local"><label for="${name}">${e(label)}</label><input id="${name}" name="${name}" type="${type}" value="${e(value)}"${required ? ' required' : ''}${['amount','payout-amount'].includes(name) ? ' inputmode="decimal"' : ''} autocomplete="off">${hint ? `<small>${e(hint)}</small>` : ''}</div>`; }
function accountReady() { return Boolean(data('account')?.account_alias); }
function matchingActivation(op:Json) { return op.kind === 'activation' && op.ghost_seed_file === snapshot.ghost_seed_file && op.api_url === snapshot.settings.api_url && op.account_memo === data('keys')?.deposit_memo; }
function activationSubmitted() { return Boolean(snapshot?.operations?.some((op:Json)=>matchingActivation(op) && ['submitting','uncertain','broadcast','pending','included'].includes(op.state))); }
function walletReady() { return Boolean(snapshot?.wallet); }
function walletBalance() { return walletData('balance')?.balances?.[0]?.amount ?? '—'; }
function exchangeRate() {
  const quote = data('activation_terms')?.mmx_exchange_rate;
  return quote && Date.parse(quote.expires_at) > Date.now() ? quote.usd_per_mmx : null;
}
async function refresh(quiet = false) {
  const version = ++generation;
  document.querySelector('#connection')!.textContent = 'Refreshing…';
  try {
    const next = await call({ action: 'snapshot', passphrase });
    if (version !== generation) return false;
    snapshot = next; lastError = '';
    document.documentElement.dataset.theme = next.settings.theme === 'system' ? '' : next.settings.theme;
    document.querySelector('#connection')!.textContent = 'Updated ' + new Date(next.refreshed_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (!quiet || !busy) renderPreservingInputs();
    return true;
  } catch (error) {
    if (version !== generation) return false;
    lastError = message(error); document.querySelector('#connection')!.textContent = snapshot ? 'Showing saved view' : 'Unavailable';
    if (!quiet) notify(lastError, true); if (!quiet || !busy) renderPreservingInputs();
    return false;
  }
}
function renderPreservingInputs() {
  const editing = main.dataset.editing;
  const inputs = [...main.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')].filter(input => !(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) || !input.readOnly).map(input => ({ id: input.id, value: input.value, checked: input instanceof HTMLInputElement ? input.checked : false }));
  const focus = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const focused = main.contains(focus) ? focus?.id : null;
  const focusSelector = focused ? '#' + CSS.escape(focused) : main.contains(focus) && focus?.dataset.action ? `[data-action="${CSS.escape(focus.dataset.action)}"]` : main.contains(focus) && focus?.dataset.status ? `[data-status="${CSS.escape(focus.dataset.status)}"]` : main.contains(focus) && focus?.closest('form')?.id ? `#${CSS.escape(focus.closest('form')!.id)} button[type=submit]` : null;
  const selection = focus && focused && (focus instanceof HTMLTextAreaElement || focus instanceof HTMLInputElement && ['text','password','url'].includes(focus.type)) ? [focus.selectionStart, focus.selectionEnd] : null;
  render();
  for (const saved of inputs) {
    const input = document.getElementById(saved.id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    if (input && main.contains(input)) { if (!(input instanceof HTMLSelectElement) || [...input.options].some(option => option.value === saved.value)) input.value = saved.value; if (input instanceof HTMLInputElement) input.checked = saved.checked; }
  }
  if (editing) main.dataset.editing = editing;
  updatePayoutAddressButton();
  const next = focusSelector ? main.querySelector<HTMLElement>(focusSelector) : null;
  if (next && !dialog.open) { if (next instanceof HTMLButtonElement && next.disabled) deferredFocus = next; else next.focus({ preventScroll: true }); if (selection && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) next.setSelectionRange(selection[0], selection[1]); }
  if (page === 'wallet' && tab === 'receive') { const select = document.querySelector<HTMLSelectElement>('#receive-select'); if (select) document.querySelector('#receive-address')!.textContent = select.value; void drawQR(); }
  updateMemoCount();
}
function updateMemoCount() { const memo = document.querySelector<HTMLInputElement>('#memo'); if (memo) document.querySelector('#memo-count')!.textContent = `${memoBytes(memo.value)} / 64 UTF-8 bytes`; }
function updatePayoutAddressButton() {
  const input=document.querySelector<HTMLInputElement>('#payout-address');
  const button=document.querySelector<HTMLButtonElement>('#payout-address-form button[type=submit]');
  if (!input || !button) return;
  const address=input.value.trim();
  button.disabled=busy || !address || address === data('provider_balance')?.payout_address || payoutDrafts().some((op:Json)=>op.kind === 'payout_address' && ['prepared','submitting','uncertain'].includes(op.state));
}
function resetSendForm() {
  purpose = 'send';
  if (page === 'wallet' && tab === 'send') { render(); updateMemoCount(); }
}
function fundingActions() {
  const state = accountState(snapshot.keys, snapshot.account);
  if (state === 'unavailable') return button('Retry account lookup', 'refresh', true);
  if (state === 'missing') return button('Create account key', 'create-account', true);
  if (state === 'ready') return button('Add funds', 'top-up', true);
  return activationSubmitted() ? button('Check activation', 'activate', true) : button('Activate account', 'activation', true);
}
// A GitHub sign-up or link in progress: waiting for the sign-in, or why it did not finish.
function githubPanel() {
  if (!githubClaim) return '';
  const link = githubClaim.purpose === 'link', again = link ? 'link-github' : 'github-signup';
  if (githubClaim.state === 'waiting') return `<div class="notice-local" role="status"><strong>Waiting for GitHub</strong><p>Sign in with GitHub in your browser within 10 minutes. This page updates when ${link ? 'GitHub is linked' : 'your account is ready'}.</p><div class="toolbar-row">${button('Start again',again)}${button('Cancel','cancel-github')}</div></div>`;
  return `<p class="error-inline">${e(githubClaim.state === 'expired' ? 'The link expired. Start again.' : githubClaim.reason)}</p>`;
}
// What a finished claim says: the GitHub login and whether the trial credit came with it; a sign-up
// without it says why, and that a deposit adds funds.
function githubDone(reading: Json) {
  const who = reading?.github_login ? `@${reading.github_login}` : 'GitHub';
  const credit = reading?.trial_credit ? ' The trial credit came with it.' : '';
  const why = reading?.trial_credit_refusal ? `: ${reading.trial_credit_refusal}` : '';
  if (reading?.status === 'linked') return `${who} is linked.${credit || (why ? ` No trial credit${why}.` : '')}`;
  if (reading?.trial_credit) return `Account created, signed up with ${who}.${credit}`;
  return `Account created, signed up with ${who}. No trial credit${why}. Add funds with an MMX deposit.`;
}
async function startGithub(action: 'github_signup' | 'github_link') {
  githubClaim = null;
  const claim = await call({ action });
  githubClaim = { state: 'waiting', purpose: action === 'github_link' ? 'link' : 'signup', claim_id: claim.claim_id, expires_at: claim.expires_at };
  renderPreservingInputs();
  void followGithub(claim.claim_id);
}
// The account's trial: credit left, when it ends, and what it may rent.
function trialFacts(view: Json) {
  if (!view) return '';
  const when = (at: string) => new Date(at).toLocaleString();
  return `<dl class="facts-list">${fact('Trial credit left',usd(view.credit_left_microusd))}${fact(view.ended_at ? 'Trial credit ended' : 'Trial credit ends',when(view.ended_at || view.expires_at))}</dl>${view.limited ? `<p class="quiet">${e(TRIAL_LIMITS)}</p>` : ''}`;
}
async function followGithub(claimId: string) {
  const started = performance.now(), limit = githubWaitLimit(githubClaim?.expires_at ?? '');
  while (githubClaim?.claim_id === claimId && githubClaim.state === 'waiting') {
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (githubClaim?.claim_id !== claimId || githubClaim.state !== 'waiting') return;
    // A reading that fails (a lost connection) is tried again; the backend's answer ends the wait,
    // not this computer's clock passing the link's expiry, since a sign-in made just before it still finishes.
    const reading = await call({ action: 'github_status', claim_id: claimId }).catch(() => null);
    const step = githubStep(reading, performance.now() - started, limit);
    if (step.state === 'waiting') continue;
    if (step.state === 'created' || step.state === 'linked') { githubClaim = null; await refresh(); notify(githubDone(reading)); return; }
    githubClaim = { ...githubClaim, ...step, claim_id: claimId };
    renderPreservingInputs();
  }
}
// How to activate with a deposit, and what activating agrees to, wherever activation is offered.
function fundingNote() {
  const agreement = `<p class="quiet" data-signup-agreement>${e(SIGNUP_AGREEMENT)}</p>`;
  const terms = data('activation_terms');
  if (!terms) return errorLine(snapshot.activation_terms) + agreement;
  const automatic = snapshot.operations.some((op:Json)=>matchingActivation(op) && paymentNeedsUpdate(op));
  return `<p class="quiet">Send at least ${e(mmx(terms.minimum_deposit_mmx_atomic))} MMX with your account memo. After ${e(terms.minimum_confirmations)} confirmations, ${automatic ? 'we’ll check activation automatically. You can also choose Check activation' : 'choose Check activation'}. Partial deposits count toward the minimum. Wait for credit before sending again.</p>${agreement}`;
}
function render() {
  main.dataset.view = page;
  delete main.dataset.editing;
  for (const a of document.querySelectorAll('[data-page]')) a.setAttribute('aria-current', (a as HTMLElement).dataset.page === page ? 'page' : 'false');
  if (!snapshot) { main.innerHTML = header('Welcome to Gigahost.', 'Your wallet, account, and service credit in one place.') + `<div class="notice-local"><strong>${native ? 'Could not load your workspace' : 'Desktop preview'}</strong><p>${e(lastError || 'The local desktop app connects your keys to Gigahost.')}</p>${button('Try again', 'refresh')}</div>`; return; }
  main.innerHTML = (lastError ? `<div class="notice-local warning"><strong>Showing the last loaded view</strong><p>${e(lastError)}</p></div>` : '') + ({ home: homeView, wallet: walletView, account: accountView, payouts: payoutsView, settings: settingsView }[page])();
  if (page === 'wallet' && tab === 'send' && purpose !== 'send') for (const name of ['target','memo']) (document.getElementById(name) as HTMLInputElement | null)?.setAttribute('readonly','');
  if (page === 'wallet' && tab === 'receive') drawQR();
  updatePayoutAddressButton();
  if (busy) disableActions(true);
}
function homeView() {
  const account = data('account'), state = accountState(snapshot.keys, snapshot.account);
  const setup = !walletReady() || !data('keys');
  return header(setup ? 'Make yourself at home.' : 'Your account, at a glance.', setup ? 'Get started with two private keys. We’ll guide you through the rest.' : 'Manage your money here. Run your infrastructure on Gigahost.', button('Refresh', 'refresh')) +
    (setup ? `<div class="setup-grid"><section class="setup-step"><span class="step">01 / YOUR MMX WALLET</span><h2>${walletReady() ? 'Wallet connected.' : 'A place for your MMX.'}</h2><p>Send, receive, and fund your Gigahost account. Your wallet also works on its own.</p><div class="toolbar-row">${walletReady() ? button('Open wallet', 'wallet') : button('Create wallet', 'create-wallet', true) + button('Use existing', 'existing-wallet')}</div></section><section class="setup-step"><span class="step">02 / YOUR GIGAHOST ACCOUNT</span><h2>${data('keys') ? 'Account key connected.' : 'Your key to Gigahost.'}</h2><p>This separate key signs account actions and protects hosted backups. Save a private copy.</p>${errorLine(snapshot.keys)}<div class="toolbar-row">${data('keys') ? button('Open account', 'account') : button('Create account key', 'create-account', true) + button('Import account key', 'import-account') + button('Use existing', 'existing-account')}</div></section></div>` : '') +
    `<div class="balance-grid"><section class="balance-block primary"><div class="balance-label"><h2>MMX wallet</h2>${badge(walletData('balance') ? 'Connected' : walletReady() ? 'Needs attention' : 'Not set up', walletData('balance') ? 'success' : 'warning')}</div><div class="balance-number">${e(walletBalance())}<span>MMX</span></div><p class="balance-note">${walletData('balance') ? 'Available on the MMX network. Full payment precision.' : 'Connect or unlock a wallet to check your balance.'}</p><div class="balance-actions">${button('Send MMX', 'send', false, !walletReady())}${button('Receive', 'receive', false, !walletReady())}${snapshot?.wallet?.balance?.error?.code === 'passphrase_required' ? button('Unlock wallet', 'unlock', true) : ''}</div>${errorLine(snapshot.wallet?.balance)}</section><section class="balance-block"><div class="balance-label"><h2>Gigahost service credit</h2>${badge(account ? account.status : state === 'unactivated' ? 'Activation needed' : state === 'missing' ? 'Not set up' : 'Unavailable', account ? 'success' : 'warning')}</div><div class="balance-number">${usd(data('account_balance')?.available_microusd)}<span>USD</span></div><p class="balance-note">${account ? `${usd(data('account_balance')?.reserved_microusd)} reserved · pays for your Gigahost services` : state === 'unactivated' ? 'Fund your account with MMX to activate it.' : state === 'missing' ? 'Create or select your account key.' : 'Account lookup failed. Retry before making a payment.'}</p><div class="balance-actions">${fundingActions()}${button('Open Gigahost', 'login', false, !account)}</div>${state === 'unactivated' ? '' : errorLine(account ? snapshot.account_balance : snapshot.account)}${state === 'unactivated' ? fundingNote() : ''}</section></div>` +
    `<section class="section"><div class="section__header"><h2 class="section-title">Recent activity</h2>${account ? `<span class="note">${e(account.account_alias)}</span>` : ''}</div>${operationsView(4)}${!snapshot.operations.length ? `<div class="empty"><h3>A fresh start.</h3><p>Your payments, key rotations, and restore approvals will appear here.</p></div>` : ''}</section>`;
}
function walletView() {
  if (!walletReady()) return header('Your MMX wallet.', 'Create a wallet or connect an existing key file.') + `<div class="toolbar-row">${button('Create wallet', 'create-wallet', true)}${button('Import recovery words', 'import-wallet')}${button('Choose wallet file', 'existing-wallet')}</div>`;
  const tabs = `<div class="tabs-local" role="tablist" aria-label="Wallet actions">${['send','receive','history'].map(t => `<button id="wallet-tab-${t}" role="tab" aria-selected="${tab === t}" aria-controls="wallet-panel" tabindex="${tab === t ? 0 : -1}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>`;
  let content = '';
  if (tab === 'send') content = `<div class="split"><form id="send-form" class="form-grid">${purpose !== 'send' ? `<div class="notice-local"><strong>${purpose === 'activation' ? 'Activate your account' : 'Add Gigahost credit'}</strong><p>The account’s deposit address and memo are filled in and checked before payment.</p>${purpose === 'activation' ? fundingNote() : ''}${purpose === 'activation' && (!walletData('balance') || /^0(?:\.0+)?$/.test(String(walletBalance()))) ? `<p>First receive MMX into your wallet, then return here to activate your account.</p>${button('Receive MMX first','receive')}` : ''}</div>` : ''}${field('Recipient address','target',purpose === 'send' ? '' : data('activation_terms')?.deposit_address || '', 'text','An MMX address beginning with mmx1.',purpose === 'send')}${field('Amount in MMX','amount',purpose === 'activation' && data('activation_terms') ? mmx(data('activation_terms').minimum_deposit_mmx_atomic) : '', 'text','Use the exact amount. Network fees are shown in the next step.',true)}${field(purpose === 'send' ? 'Memo (optional)' : 'Account deposit memo','memo',purpose === 'send' ? '' : data('keys')?.deposit_memo || '', 'text','64 UTF-8 bytes maximum.')}<p id="memo-count" class="note"></p><div class="toolbar-row"><button class="btn btn--primary" type="submit">Review payment</button>${purpose !== 'send' ? button('Reset', 'send') : ''}</div></form><aside class="stack"><section class="panel"><h2 class="section-title">Available to send</h2><div class="balance-number" style="font-size:2rem">${e(walletBalance())}<span>MMX</span></div>${errorLine(snapshot.wallet.balance)}${button('Unlock wallet', 'unlock')}</section><p class="quiet">You’ll review the recipient, amount, memo, and estimated fee before sending. Closing the review does not broadcast a payment.</p>${purpose !== 'send' ? button('Pay from another wallet', 'external-funding') : ''}</aside></div>`;
  if (tab === 'receive') content = receiveView();
  if (tab === 'history') content = historyView();
  return header('Your MMX wallet.', 'Send and receive MMX without a local node.', button('Refresh', 'refresh')) + tabs + `<div id="wallet-panel" role="tabpanel" tabindex="0" aria-labelledby="wallet-tab-${tab}">${content}</div>` + `<section class="section"><h2 class="section-title">Saved payments</h2>${operationsView(10,true)}</section><p class="note">Wallet: ${e(snapshot.wallet.file)}</p>`;
}
function receiveView() {
  const addresses = walletData('addresses')?.addresses || [];
  if (!addresses.length) return `<div class="empty"><h3>Unlock your wallet.</h3><p>Enter its derivation passphrase to display addresses.</p>${button('Unlock wallet','unlock',true)}${errorLine(snapshot.wallet.addresses)}</div>`;
  return `<div class="receive-grid"><div class="stack"><div class="address-box"><span class="eyebrow">YOUR RECEIVING ADDRESS</span><p id="receive-address" class="address-text">${e(addresses[0])}</p><div class="toolbar-row">${button('Copy address','copy-address',true)}${addresses.length > 1 ? `<select id="receive-select" aria-label="Receiving address">${addresses.map((a:string,i:number) => `<option value="${e(a)}">Address ${i+1}</option>`).join('')}</select>` : ''}</div></div><p class="quiet">Send MMX to this address. A memo is optional for ordinary transfers. The QR contains the address only.</p>${field('Requested amount (optional)','receive-amount','','text')}${field('Requested memo (optional)','receive-memo','','text')}<div class="toolbar-row">${button('Copy payment details','copy-receive')}</div></div><div class="qr-wrap"><canvas id="receive-qr" aria-label="Receiving address QR code"></canvas></div></div>`;
}
function historyView() {
  const rows = walletData('history')?.history || [];
  if (!rows.length) return `<div class="empty"><h3>No payments to show yet.</h3><p>New MMX receipts and payments appear automatically.</p>${errorLine(snapshot.wallet.history)}</div>`;
  return `<div class="table-wrap"><table class="desktop-table history-table"><thead><tr><th>Payment</th><th>Date</th><th>Transaction</th><th>Status</th><th>MMX</th></tr></thead><tbody>${rows.map((r:Json) => `<tr><td>${e(historyLabel(r.type))}${r.memo != null ? `<span class="memo">${e(r.memo)}</span>` : ''}</td><td class="history-date">${e(r.time_stamp ? new Date(r.time_stamp).toLocaleDateString() : '—')}</td><td><span class="code" title="${e(r.txid)}">${e(String(r.txid).slice(0,12))}…</span></td><td>${badge(r.is_pending ? 'Pending' : 'Confirmed',r.is_pending ? 'working' : 'success')}</td><td class="num">${e(r.amount)}</td></tr>`).join('')}</tbody></table></div>`;
}
function accountView() {
  const account = data('account'), keys = data('keys'), state = accountState(snapshot.keys, snapshot.account);
  return header(account?.account_alias || 'Your Gigahost account.', 'Your identity, keys, website access, and backup approvals.', button('Open Gigahost','login',true,!account)) +
    (!keys ? `<div class="empty"><h3>Set up your account key.</h3><p>This key is separate from your MMX wallet. It protects your account and hosted backups.</p>${errorLine(snapshot.keys)}<div class="toolbar-row">${button('Create account key','create-account',true)}${button('Import account key','import-account')}${button('Use existing key','existing-account')}</div></div>` :
    `<div class="split"><section class="section stack"><div class="section__header"><h2 class="section-title">Account details</h2>${badge(account?.status || (state === 'unactivated' ? 'Activation needed' : 'Unavailable'),account ? 'success' : 'warning')}</div><dl class="facts-list">${fact('Account',account?.account_alias || (state === 'unactivated' ? 'Not activated' : 'Lookup unavailable'))}${fact('Available credit',usd(data('account_balance')?.available_microusd))}${fact('Reserved credit',usd(data('account_balance')?.reserved_microusd))}${fact('Deposit memo',keys.deposit_memo,true)}${fact('Key epoch',account?.key_epoch || '—')}${state === 'ready' ? fact('GitHub',githubLabel(account?.github) || 'Not linked') : ''}</dl>${trialFacts(account?.trial)}<div class="toolbar-row">${fundingActions()}${state === 'unactivated' && !activationSubmitted() ? button('Sign up with GitHub','github-signup') : ''}${state === 'ready' ? (account?.github ? button('Unlink GitHub','unlink-github') : button('Link GitHub','link-github')) : ''}${button('Copy deposit details','external-funding')}</div>${githubPanel()}${state === 'unactivated' ? fundingNote() + (activationSubmitted() ? '' : button('Check activation','activate')) : ''}${state === 'unactivated' ? '' : errorLine(account ? snapshot.account_balance : snapshot.account)}</section><section class="section stack"><h2 class="section-title">Keep your keys safe</h2><p class="quiet">A saved account key protects your account and encrypted hosted backups. After rotation, keep earlier account keys for backups made with them.</p><div class="toolbar-row">${button('Back up account key','export-account')}${button('Rotate account keys','rotate')}</div><div class="key-location">${e(snapshot.ghost_seed_file)}</div><p class="note">Key files are private files, stored without encryption.</p>${button('End website sessions','revoke')}</section></div>${passwordView()}<section class="section stack"><h2 class="section-title">Authorize a hosted restore</h2><p class="quiet">Choose the backup and destination on the website. Open its approval link here to review and authorize access with your recovery key.</p><form id="restore-form" class="toolbar-row"><div class="field-local" style="flex:1"><label for="restore-reference">Approval link or request ID</label><input id="restore-reference" name="reference" placeholder="Paste the Gigahost approval link" required></div><button class="btn" type="submit">Review request</button></form></section>`)
    + depositsView() + `<section class="section"><h2 class="section-title">Saved operations</h2>${operationsView(20)}</section>`;
}
// The website password: whether one is set, until when, and the actions
// that set a new one or remove it. The password itself is never kept: the
// app shows a new one once, in a dialog that forgets it on closing.
function passwordView() {
  const account = data('account');
  if (!account) return '';
  const view = account.website_password, state = websitePasswordState(view);
  const when = (at: string) => new Date(at).toLocaleString();
  return `<section class="section stack"><div class="section__header"><h2 class="section-title">Website password</h2>${badge(state === 'none' ? 'Not set' : state === 'expired' ? 'Expired' : 'Set', state === 'set' ? 'success' : state === 'expired' ? 'warning' : 'info')}</div><p class="quiet">Log in on the Gigahost website with your account alias and a generated password when this app is not at hand. Only this app or the ghost CLI can set it; the website cannot.</p>${view ? `<dl class="facts-list">${fact('Set',when(view.created_at))}${fact(state === 'expired' ? 'Expired' : 'Expires',view.expires_at ? when(view.expires_at) : 'Never')}</dl>` : ''}<div class="toolbar-row">${button(view ? 'Set a new password' : 'Set a password','website-password',!view)}${view ? button('Remove the password','remove-password') : ''}</div></section>`;
}
function settingsView() {
  const s = snapshot.settings;
  const pathField = (label:string,name:string,value:string,hint:string) => `<div class="field-local"><label for="${name}">${label}</label><div class="path-input"><input id="${name}" name="${name}" value="${e(value)}" autocomplete="off"><button class="btn" type="button" data-pick="${name}">Browse</button></div><small>${e(hint)}</small></div>`;
  return header('Make it yours.', 'Use the default key locations or choose files wherever you keep them.') + `<form id="settings-form" class="form-grid"><section class="section stack"><h2 class="section-title">Key locations</h2>${pathField('MMX wallet file','wallet_file',s.wallet_file || '', 'Leave empty to use the wallet selected by mmxwallet.')}${snapshot.wallets?.data?.wallets?.length ? `<div class="field-local"><label for="wallet-choice">Discovered wallets</label><select id="wallet-choice"><option value="">Choose a wallet…</option>${snapshot.wallets.data.wallets.map((w:Json) => `<option value="${e(w.wallet_file)}">${e(w.fingerprint)} · ${e(w.address ? w.address.slice(0,20)+'…' : 'Passphrase needed')}</option>`).join('')}</select></div>` : ''}${pathField('Gigahost account key','ghost_seed_file',s.ghost_seed_file || '', 'Leave empty to follow Ghost’s standard location.')}<div class="field-pair">${field('MMX derivation account','account_index',String(s.account_index),'number')}${field('Addresses to scan','num_addresses',String(s.num_addresses),'number','1–10 addresses')}</div></section><section class="section stack"><h2 class="section-title">Appearance</h2><div class="field-local"><label for="theme">Theme</label><select id="theme" name="theme">${['system','light','dark'].map(t => `<option${s.theme === t ? ' selected' : ''} value="${t}">${t[0].toUpperCase()+t.slice(1)}</option>`).join('')}</select></div></section><details class="section"><summary>Advanced connection settings</summary><div class="stack" style="padding-top:20px">${field('Gigahost API','api_url',s.api_url,'url')}${field('Gigahost website','website_url',s.website_url,'url','Login and approval links must match this trusted website.')}${field('MMX RPC','rpc_url',s.rpc_url,'url','Use HTTPS. HTTP is supported only for local development.')}</div></details><div class="toolbar-row"><button class="btn btn--primary" type="submit">Save settings</button>${button('Forget derivation passphrase','lock',false,passphrase === null)}</div></form><section class="section stack"><h2 class="section-title">Recovery material</h2><div class="toolbar-row">${button('Back up wallet file','export-wallet',false,!walletReady())}${button('Show recovery words','mnemonic',false,!walletReady())}</div><p class="quiet">Uninstalling the app leaves your keys and app data in place. A wallet passphrase changes key derivation; it does not encrypt the file.</p><p class="note">Forgetting a derivation passphrase clears it from this app window. Wallets without a passphrase remain usable.</p></section><section class="section stack"><h2 class="section-title">Older Gigahost account keys</h2><p class="quiet">Keep earlier account keys for hosted backups made before rotation. Removing a location here leaves the account key file on disk.</p>${button('Add account key','add-recovery')}${s.recovery_seed_files?.length ? `<ul class="recovery-list">${s.recovery_seed_files.map((p:string) => `<li><span class="key-location">${e(p)}</span><div class="toolbar-row"><button class="btn" data-export-recovery="${e(p)}">Back up account key</button><button class="btn btn--quiet" data-remove-recovery="${e(p)}">Remove location</button></div></li>`).join('')}</ul>` : '<p class="note">No older account keys registered yet.</p>'}</section>`;
}
function payoutDrafts() {
  return snapshot.operations.filter((op:Json)=>['payout','payout_address'].includes(op.kind) && op.api_url === snapshot.settings.api_url && op.review.account_alias === data('account')?.account_alias && ['prepared','submitting','uncertain','failed'].includes(op.state));
}
function payoutsView() {
  const top = header('Earnings and payouts.', 'Receive your Gigahost provider earnings in MMX.', button('Refresh','refresh'));
  if (!accountReady()) return top + `<div class="empty"><h3>Connect your Gigahost account.</h3><p>Activate your account to manage payout addresses and earnings.</p>${button('Open account','account',true)}</div>`;
  const balance = data('provider_balance');
  if (!balance) return top + `<div class="empty"><h3>${snapshot.provider_balance?.error ? 'Could not load earnings.' : 'No earnings yet.'}</h3><p>${snapshot.provider_balance?.error ? 'Refresh to try again.' : 'Provider earnings become available when you rent out servers on Gigahost.'}</p>${errorLine(snapshot.provider_balance)}</div>` + payoutHistory();
  const drafts = payoutDrafts(), locked = drafts.some((op:Json)=>op.kind === 'payout' && ['prepared','submitting','uncertain'].includes(op.state));
  const addressLocked = drafts.some((op:Json)=>op.kind === 'payout_address' && ['prepared','submitting','uncertain'].includes(op.state));
  const available = BigInt(balance.available_payout_microusd || 0) > 0n && !balance.sla_settlement_pending;
  const walletAddress = walletData('addresses')?.addresses?.[0];
  return top + `<div class="payout-balances">${[['Available now',balance.available_payout_microusd],['Held',balance.held_microusd],['On the way',balance.on_the_way_microusd]].map(([label,value])=>`<section class="balance-block"><h2 class="section-title">${e(label)}</h2><div class="balance-number">${usdExact(value)}</div></section>`).join('')}</div>${balance.sla_settlement_pending ? '<div class="notice-local warning">An outage on one of your hosts is not settled yet. A payout becomes available once it is.</div>' : ''}<div class="split"><section class="section stack"><h2 class="section-title">Request a payout</h2>${!balance.payout_address ? '<p class="quiet">Set a payout address first.</p>' : `<p class="quiet">Paid to <span class="code payout-address" title="${e(balance.payout_address)}">${e(balance.payout_address)}</span></p>`}${!available ? '<p class="quiet">Nothing is available to pay out now.</p>' : ''}${locked ? '<p class="quiet">Review your saved payout request before preparing another.</p>' : ''}<form id="payout-form" class="form-grid">${field('Amount in USD (optional)','payout-amount','','text','Leave empty to pay out everything available. Use at most two decimal places.')}<div class="toolbar-row"><button class="btn btn--primary" type="submit"${!balance.payout_address || !available || locked ? ' disabled' : ''}>Review payout</button></div></form></section><section class="section stack"><h2 class="section-title">Payout address</h2><form id="payout-address-form" class="form-grid">${field('MMX payout address','payout-address',balance.payout_address || '', 'text','An MMX address you control.',true)}<div class="toolbar-row">${button('Use wallet address','use-wallet-payout-address',false,!walletAddress || addressLocked)}<button class="btn" type="submit"${addressLocked ? ' disabled' : ''}>Update address</button></div></form>${addressLocked ? '<p class="quiet">Review the saved address change before preparing another.</p>' : ''}</section></div>${drafts.length ? `<section class="section stack"><h2 class="section-title">Saved payout reviews</h2>${drafts.map((op:Json)=>payoutDraft(op)).join('')}</section>` : ''}` + payoutHistory();
}
function payoutDraft(op:Json) {
  return `<article class="operation"><div><h3>${op.kind === 'payout' ? 'Payout · '+usdExact(op.review.amount_microusd) : 'Payout address change'}</h3>${badge(op.state,['uncertain','failed'].includes(op.state) ? 'warning' : 'info')}</div><div class="toolbar-row"><button class="btn btn--small" data-review-payout="${e(op.id)}">${['uncertain','submitting'].includes(op.state) ? 'Review saved request' : 'Review'}</button>${['prepared','failed'].includes(op.state) ? `<button class="btn btn--small btn--quiet" data-discard-payout="${e(op.id)}">Discard</button>` : ''}</div></article>`;
}
function payoutHistory() {
  const rows:Json[] = data('payouts') || [];
  return `<section class="section stack"><h2 class="section-title">Payout history</h2>${errorLine(snapshot.payouts)}${!rows.length ? `<p class="quiet">${snapshot.payouts?.error ? 'Payout history is unavailable. Refresh to try again.' : 'No payouts yet.'}</p>` : `<div class="table-wrap"><table class="desktop-table payout-table"><thead><tr><th>Requested</th><th>Amount</th><th>Status</th><th>Transaction</th></tr></thead><tbody>${rows.map((r:Json)=>`<tr><td>${e(new Date(r.requested_at).toLocaleString())}<span class="memo code" title="${e(r.destination_address)}">${e(r.destination_address)}</span></td><td>${usdExact(r.amount_microusd)}<span class="memo">${r.amount_mmx_atomic == null ? 'MMX amount set when prepared' : e(mmx(r.amount_mmx_atomic))+' MMX'}</span></td><td>${badge(payoutLabel(r.state),r.state === 'confirmed' ? 'success' : ['under_review','action_required'].includes(r.state) ? 'warning' : payoutNeedsUpdate(r) ? 'working' : 'info')}${payoutNote(r) ? `<span class="memo">${e(payoutNote(r))}</span>` : ''}<button class="btn btn--small" data-action="refresh">Check status</button></td><td>${r.chain_transaction_id ? `<span class="code" title="${e(r.chain_transaction_id)}">${e(r.chain_transaction_id.slice(0,12))}…</span>` : '—'}</td></tr>`).join('')}</tbody></table></div>`}</section>`;
}
function cacheOperation(op:Json) { snapshot.operations=[...snapshot.operations.filter((saved:Json)=>saved.id !== op.id),op]; }
function payoutReview(op:Json) {
  const address = op.kind === 'payout_address', retry = ['uncertain','submitting'].includes(op.state);
  const confirmable = op.state === 'prepared' || retry;
  modal(address ? 'Review payout address.' : 'Review your payout.', `${retry ? '<div class="notice-local warning">The saved request may already have succeeded. Retrying uses the same request.</div>' : ''}<dl class="facts-list">${address ? fact('Current address',op.review.previous_address || 'Not set',true,'payment-address') : ''}${fact(address ? 'New address' : 'Recipient',op.review.address,true,'payment-address')}${address ? '' : fact('Amount',usdExact(op.review.amount_microusd)) + fact('Estimated MMX value',payoutMmx(op.review.amount_microusd,exchangeRate()) ?? 'Unavailable')}</dl>${address ? '' : '<p class="quiet">Paid in MMX at the exchange rate when the payout is prepared.</p>'}`,confirmable ? `<button class="btn btn--primary" data-confirm-payout="${e(op.id)}">${address ? 'Save payout address' : retry ? 'Retry same payout' : 'Confirm payout'}</button>` : '', 'payment');
}
function operationsView(limit:number, paymentsOnly=false) {
  return [...snapshot.operations].filter((op:Json)=>!paymentsOnly || op.transaction_id).reverse().slice(0,limit).map((op:Json) => {
    if (['payout','payout_address'].includes(op.kind) && ['prepared','submitting','uncertain','failed'].includes(op.state)) return payoutDraft(op);
    const payment = Boolean(op.transaction_id), active = !['discarded','complete','authorized','included','failed','expired'].includes(op.state);
    let actions = '';
    if (payment) { actions = `<button class="btn btn--small" data-status="${e(op.id)}">Check status</button>` + (op.state === 'prepared' ? `<button class="btn btn--small" data-review-payment="${e(op.id)}">Review</button><button class="btn btn--small btn--quiet" data-discard="${e(op.id)}">Discard</button>` : ['uncertain','submitting','broadcast','pending'].includes(op.state) ? `<button class="btn btn--small" data-review-payment="${e(op.id)}">Review same payment</button>` : ''); }
    else if (op.kind === 'restore' && active) actions = `<button class="btn btn--small" data-review-restore="${e(op.id)}">${op.state === 'prepared' ? 'Review' : 'Resume authorization'}</button>`;
    else if (op.kind === 'rotation' && active) actions = `<button class="btn btn--small" data-rotation="${e(op.id)}">${op.state === 'prepared' ? 'Review' : 'Review / check rotation'}</button>`;
    return `<article class="operation"><div><h3>${e(({send:'MMX payment',top_up:'Gigahost top-up',activation:'Account activation payment',restore:'Hosted restore',rotation:'Account key rotation',payout:'Payout request',payout_address:'Payout address change'} as Json)[op.kind] || op.kind)}${payment ? ' · '+e(op.review.amount)+' MMX' : op.kind === 'payout' ? ' · '+usdExact(op.review.amount_microusd) : ''}</h3><span class="note">${e(new Date(op.created_at*1000).toLocaleString())}${payment ? ` · ${e(op.transaction_id.slice(0,12))}…` : ''}${payment && op.confirmations != null ? ` · ${e(op.confirmations >= 10 ? '10+' : op.confirmations)} confirmations` : ''}</span>${badge(op.state === 'included' ? 'Confirmed' : op.state,['complete','authorized','included'].includes(op.state) ? 'success' : ['uncertain','needs_resume','failed','expired'].includes(op.state) ? 'warning' : active ? 'working' : 'info')}</div><div class="toolbar-row">${actions}</div></article>`;
  }).join('');
}
function modal(title:string, body:string, actions:string = '', layout = '') {
  dialog.dataset.layout = layout;
  if (!dialog.open) modalReturnFocus = document.activeElement as HTMLElement | null;
  document.querySelector<HTMLElement>('#toast')!.hidden = true;
  document.querySelector('#dialog-content')!.innerHTML = `<div class="modal-body"><div class="modal-head"><h2 id="dialog-title" tabindex="-1">${e(title)}</h2><button class="close-button" data-close aria-label="Close dialog">×</button></div>${body}<p id="dialog-status" class="notice-local" role="status" aria-live="polite" hidden></p><p id="dialog-error" class="notice-local warning" role="alert" aria-live="assertive" hidden></p><div class="modal-actions">${button('Close','close')}${actions}</div></div>`;
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0; dialog.setAttribute('aria-busy', String(busy));
  document.querySelector<HTMLElement>('#dialog-title')!.focus({ preventScroll: true });
  if (busy) disableActions(true);
}
function closeModal() { if (busy) return; pendingImport = null; dialog.close(); document.querySelector('#dialog-content')!.textContent = ''; }
async function operate(task:()=>Promise<unknown>, success?:string) {
  if (busy) return;
  ++generation;
  busy = true; dialog.setAttribute('aria-busy', 'true'); disableActions(true);
  const error = dialog.querySelector<HTMLElement>('#dialog-error'); if (error) error.hidden = true;
  try { await task(); if (success) notify(success); }
  catch (error) { notify(message(error),true); }
  finally { busy = false; dialog.setAttribute('aria-busy', 'false'); disableActions(false); }
}
function disableActions(disabled:boolean) { for (const b of document.querySelectorAll<HTMLButtonElement>('button')) { if (disabled && !b.disabled) { b.dataset.busyDisabled='true'; b.disabled=true; } else if (!disabled && b.dataset.busyDisabled) { b.disabled=false; delete b.dataset.busyDisabled; } } if (!disabled) { updatePayoutAddressButton(); if (deferredFocus?.isConnected && !dialog.open) deferredFocus.focus({preventScroll:true}); deferredFocus=null; } }
function paymentReview(op:Json) {
  const r = op.review;
  const retry = op.state !== 'prepared';
  const funding = ['top_up','activation'].includes(op.kind);
  modal(retry ? 'Review the saved payment.' : 'Review your payment.', `${retry ? '<div class="notice-local warning"><strong>This payment may already have been accepted.</strong><p>We’ll check its ID first. A retry uses the exact same signed transaction.</p></div>' : ''}<dl class="facts-list">${fact('Recipient',r.target,true,'payment-address')}${fact('Amount',r.amount+' MMX')}${funding ? fact('Estimated USD value',topUpUsd(r.amount,exchangeRate()) ?? 'Unavailable') : ''}${fact('Memo',r.memo ?? 'None',true)}${fact('Estimated fee',r.fee+' MMX')}</dl>${funding ? '<p class="quiet">Final credit uses the exchange rate when your deposit is credited.</p>' : ''}${op.kind === 'activation' ? fundingNote() : ''}`, `<button class="btn btn--primary" data-broadcast="${e(op.id)}">${retry ? 'Check and resend same payment' : 'Confirm and send'}</button>`, 'payment');
}
async function drawQR() { const address = document.querySelector('#receive-address')?.textContent || ''; const canvas = document.querySelector<HTMLCanvasElement>('#receive-qr'); if (canvas && address) await QRCode.toCanvas(canvas,address,{ width:200,margin:4,errorCorrectionLevel:'M' }); }
async function pickFile():Promise<string|null> { if (!native) return null; const result = await open({ multiple:false,directory:false }); return typeof result === 'string' ? result : null; }
async function exportKey(kind:string) { if (!native) throw {message:'Key export is available in the installed desktop app.'}; const destination = await save({title:'Save a private key backup',defaultPath:kind === 'wallet' ? 'mmx-wallet-backup.dat' : 'gigahost-account-backup.seed'}); if (destination) { await call({action:'export_key',kind,destination}); notify('Private backup saved. Keep it somewhere safe.'); } }
async function restoreReview(op:Json) {
  const r = op.review, operation = r.request.operation, replacing = operation.kind === 'restore_backup';
  const destination = replacing ? (r.destination.name || r.destination.hostname || r.destination.instance_id || operation.instance_id) : (operation.hostname || r.destination.name || operation.offering_id);
  modal('Review hosted restore.', `<div class="notice-local warning"><strong>${replacing ? 'This replaces the destination filesystem.' : 'This creates a new instance from your backup.'}</strong><p>${replacing ? 'Files currently on the destination will be overwritten.' : 'The new instance also incurs the offering’s ongoing charges.'}</p></div><dl class="facts-list">${fact('Account',r.account.account_alias)}${fact('Backup',r.backup.backup_id,true)}${fact('Source instance',r.backup.instance_id,true)}${fact('Destination',destination,true)}${fact('Restore charge',r.restore_charge_microusd == null ? 'Unavailable — do not authorize' : usdExact(r.restore_charge_microusd))}${fact('Charge already committed',r.charge_already_committed ? 'Yes, continuing the existing job' : 'No')}${fact('Expires',r.request.expires_at)}${fact('Recovery fingerprint',r.backup.recipient_key_fingerprint,true)}</dl>${!replacing ? offeringPrices(r.destination, operation) : ''}<div class="field-local"><label for="restore-recovery">Account key</label><div class="path-input"><input id="restore-recovery" value="${e(r.matching_recovery_files?.[0] || '')}" placeholder="Select the account key that protects this backup"><button class="btn" data-pick="restore-recovery">Browse</button></div><small>An older backup may need an account key retained before rotation.</small></div><label class="check-local"><input type="checkbox" id="restore-confirm">I reviewed the destination and charge, and authorize this restore.</label>`, `<button class="btn btn--primary" data-approve="${e(op.id)}"${r.restore_charge_microusd == null ? ' disabled' : ''}>${op.state === 'prepared' ? 'Authorize restore' : 'Resume authorization'}</button>`);
}
function rotationReview(op:Json) {
  modal('Rotate account keys.', `<div class="notice-local warning"><strong>Keep both account keys.</strong><p>This revokes existing account keys and website sessions. Your account and balance stay the same. Earlier hosted backups may still need the old account key.</p></div><dl class="facts-list">${fact('Account',op.review.account.account_alias)}${fact('Current account key',op.ghost_seed_file,true)}${fact('Replacement account key',op.replacement_seed_file,true)}${fact('New recovery fingerprint',op.review.replacement.keys.recovery_key_fingerprint,true)}</dl><div class="toolbar-row"><button class="btn" data-export-replacement="${e(op.id)}">Back up replacement account key</button></div><p class="quiet">Save private copies of both account keys before continuing.</p><label class="check-local"><input type="checkbox" id="rotation-confirm">I have backed up both account keys and understand that sessions will end.</label>`, `<button class="btn btn--primary" data-rotate-confirm="${e(op.id)}">${op.state === 'prepared' ? 'Rotate account keys' : 'Check and retry same rotation'}</button>`);
}
async function importAccount(request:{file:string|null,line:string|null}, replace:boolean) {
  let result:Json;
  try { result=await call({action:'import_account',file:request.file,line:request.line,replace}); }
  catch(error:any) {
    if (error?.code === 'account_key_exists' && !replace) {
      pendingImport=request;
      modal('Replace your current account key?', `<p class="quiet">This app’s account key file already holds a different key:</p><div class="key-location">${e(snapshot.ghost_seed_file)}</div><div class="notice-local warning"><strong>Your current account key is kept.</strong><p>It is saved beside the new one as a .replaced- file. Keep it while it protects earlier hosted backups.</p></div>`, button('Replace','confirm-import-replace',true));
      return;
    }
    throw error;
  }
  pendingImport=null;
  dialog.close();
  await refresh();
  const said = result.result === 'already_imported' ? 'This account key was already in use. Nothing changed.' : result.result === 'replaced' ? 'Account key imported. The previous one is kept at:' : 'Account key imported.';
  modal('Your account key is imported.', `<p class="quiet">${e(said)}</p>${result.result === 'replaced' ? `<div class="key-location">${e(result.replaced_file)}</div>` : ''}<p class="quiet">This app now uses:</p><div class="key-location">${e(result.seed_file)}</div>${result.account ? `<p class="quiet">Account ${e(result.account.account_alias)} · ${e(result.account.status)}</p>` : result.account_note ? `<p class="quiet">${e(result.account_note)}</p>` : ''}${result.note ? `<p class="note">${e(result.note)}</p>` : ''}`);
}
async function action(name:string) {
  if (name === 'close') return closeModal();
  if (name === 'refresh') return refresh();
  if (name === 'use-wallet-payout-address') { const address=walletData('addresses')?.addresses?.[0], input=document.querySelector<HTMLInputElement>('#payout-address'); if(address && input) { input.value=address; updatePayoutAddressButton(); input.focus(); } return; }
  if (pages.includes(name)) { location.hash=name; return; }
  if (name === 'send' || name === 'receive') { purpose='send'; tab=name; if (page !== 'wallet') location.hash='wallet'; else render(); return; }
  if (name === 'top-up' || name === 'activation') { const state = accountState(snapshot.keys, snapshot.account); if (state !== (name === 'top-up' ? 'ready' : 'unactivated')) { notify('Refresh account details before funding this account.',true); return; } purpose=name === 'top-up' ? 'top_up' : 'activation'; tab='send'; if (page !== 'wallet') location.hash='wallet'; else render(); if (!walletReady()) await action('external-funding'); return; }
  if (name === 'unlock') { modal('Unlock your wallet.', `<form id="unlock-form" class="form-grid">${field('Derivation passphrase','passphrase','','password','Kept only in this app window until you forget it, change wallets, or quit.',true)}<button class="btn btn--primary" type="submit">Unlock wallet</button></form>`); return; }
  if (name === 'lock') { passphrase=null; await refresh(); notify('Derivation passphrase forgotten. Wallet files remain unencrypted.'); return; }
  if (name === 'create-wallet' || name === 'import-wallet') { modal(name === 'import-wallet' ? 'Restore your MMX wallet.' : 'Create your MMX wallet.', `<form id="wallet-create-form" class="form-grid" data-import="${name === 'import-wallet'}">${name === 'import-wallet' ? `<div class="field-local"><label for="mnemonic">24 recovery words</label><textarea name="mnemonic" id="mnemonic" rows="4" required autocomplete="off" spellcheck="false"></textarea></div>` : '<p class="quiet">Your wallet key is generated on this computer. Back it up before receiving funds.</p>'}${field('Optional derivation passphrase','new-passphrase','','password','Keep this passphrase with your backup. It does not encrypt the wallet file.')}${name === 'create-wallet' ? field('Confirm derivation passphrase','confirm-passphrase','','password','Re-enter it exactly, including spaces.') : '<p class="note">Use the exact passphrase used with these recovery words, including spaces.</p>'}${field('Custom wallet file (optional)','new-file','','text','Leave empty for the standard wallet directory.')}<button class="btn" type="button" data-new-path="new-file">Choose another location</button><button class="btn btn--primary" type="submit">${name === 'import-wallet' ? 'Restore wallet' : 'Create wallet'}</button></form>`); return; }
  if (name === 'existing-wallet' || name === 'existing-account') { const path = await pickFile(); if (path) await operate(async()=>{ const settings={...snapshot.settings,[name === 'existing-wallet' ? 'wallet_file':'ghost_seed_file']:path}; await call({action:'save_settings',settings}); if (name === 'existing-wallet') passphrase=null; await refresh(); }); return; }
  if (name === 'create-account') { modal('Create your account key.', `<p class="quiet">This key signs account actions and protects hosted backups. It is separate from your MMX wallet.</p><form id="account-create-form" class="form-grid">${field('Custom account key file (optional)','account-file','','text','Leave empty for Ghost’s default location. Existing files are never replaced.')}<button class="btn" type="button" data-new-path="account-file">Choose another location</button><button class="btn btn--primary" type="submit">Create account key</button></form>`); return; }
  if (name === 'import-account') { pendingImport=null; modal('Import your account key.', `<p class="quiet">Use a key made on the Gigahost website or on another computer: the downloaded account.seed file, or the line that begins with gigahost-account-seed-v1: from your password manager. The key is saved as this app’s account key file; the file you choose stays where it is.</p><form id="account-import-form" class="form-grid">${field('Account key file','import-file','','text','Choose the file, or paste the line below instead.')}<button class="btn" type="button" data-pick="import-file">Choose file</button>${field('Or paste the account key line','import-line','','password','It is hidden as you paste it and sent only to the bundled ghost tool.')}<button class="btn btn--primary" type="submit">Import account key</button></form>`); return; }
  if (name === 'confirm-import-replace') { const request=pendingImport; if (!request) return; return operate(()=>importAccount(request,true)); }
  if (name === 'add-recovery') { const path = await pickFile(); if (path) await operate(async()=>{ await call({action:'save_settings',settings:{...snapshot.settings,recovery_seed_files:[...new Set([...snapshot.settings.recovery_seed_files,path])]}}); await refresh(); },'Account key location added.'); return; }
  if (name === 'external-funding') { const terms=data('activation_terms'), keys=data('keys'); if (!terms || !keys) { notify('Create an account key and refresh activation terms first.',true); return; } modal('Fund Gigahost from another wallet.', `<p class="quiet">Send MMX with this exact memo. We’ll detect confirmed deposits and credit your account. A delayed receipt does not mean you should pay again.</p>${accountState(snapshot.keys,snapshot.account) === 'unactivated' ? fundingNote() : ''}<dl class="facts-list">${fact('Deposit address',terms.deposit_address,true)}${fact('Required memo',keys.deposit_memo,true)}${fact('Activation minimum',mmx(terms.minimum_deposit_mmx_atomic)+' MMX')}${fact('Confirmations',terms.minimum_confirmations)}</dl>`,button('Copy deposit details','copy-deposit',true)); return; }
  if (name === 'copy-deposit') { await writeText(`Address: ${data('activation_terms').deposit_address}\nMemo: ${data('keys').deposit_memo}`); notify('Deposit address and memo copied.'); return; }
  if (name === 'copy-address') { await writeText(document.querySelector('#receive-address')!.textContent!); notify('Address copied.'); return; }
  if (name === 'copy-receive') { const amount=(document.querySelector('#receive-amount') as HTMLInputElement).value, memo=(document.querySelector('#receive-memo') as HTMLInputElement).value; if (memoBytes(memo)>64) { notify('Memo exceeds 64 UTF-8 bytes.',true); return; } await writeText(`Address: ${document.querySelector('#receive-address')!.textContent}${amount ? '\nAmount: '+amount+' MMX' : ''}${memo ? '\nMemo: '+memo : ''}`); notify('Payment details copied.'); return; }
  if (name.startsWith('export-')) return operate(()=>exportKey(name.slice(7)));
  if (name === 'mnemonic') { modal('Show wallet recovery words?', '<p class="quiet">Anyone with these words and any derivation passphrase can control your wallet. Show them only in a private place.</p>',button('Show recovery words','reveal-mnemonic',true)); return; }
  if (name === 'reveal-mnemonic') return operate(async()=>{ const result=await call({action:'reveal_mnemonic',passphrase}); modal('Your wallet recovery words.',`<div class="secret-box">${e(result.mnemonic)}</div><p class="quiet">Write down all 24 words in order. Save your derivation passphrase separately if you use one.</p>`); });
  if (name === 'login') return operate(()=>call({action:'login'}),'Gigahost opened in your browser.');
  if (name === 'github-signup' || name === 'link-github') return operate(()=>startGithub(name === 'link-github' ? 'github_link' : 'github_signup'),'Your browser opened. Sign in with GitHub to finish.');
  if (name === 'cancel-github') { githubClaim=null; renderPreservingInputs(); return; }
  if (name === 'unlink-github') { modal('Unlink GitHub?', '<p class="quiet">Log in with GitHub stops working for this account, and the website sessions a GitHub login began end. Your keys, password and login links still work. The trial credit is not given again if you link the same GitHub account later.</p>', button('Unlink GitHub','confirm-unlink-github',true)); return; }
  if (name === 'confirm-unlink-github') return operate(async()=>{ await call({action:'github_unlink'}); dialog.close(); await refresh(); },'GitHub unlinked.');
  if (name === 'activate') return operate(async()=>{ await call({action:'activate_account'}); await refresh(); },'Account activated.');
  if (name === 'website-password') { modal('Set a new website password.', `<form id="password-form" class="form-grid"><p class="quiet">Gigahost draws a password of 16 characters and shows it once. It replaces the current password, and the website sessions that one began end.</p>${field('Expire after days (optional)','password-expiry','','text','1 to 3650 days. Leave empty for a password that does not expire.')}<button class="btn btn--primary" type="submit">Set a new password</button></form>`); return; }
  if (name === 'remove-password') { modal('Remove the website password?', '<p class="quiet">Password login on the website stops, and the website sessions the password began end. Login links from this app and the ghost CLI still work.</p>', button('Remove the password','confirm-remove-password',true)); return; }
  if (name === 'confirm-remove-password') return operate(async()=>{ await call({action:'remove_website_password'}); dialog.close(); await refresh(); },'Website password removed.');
  if (name === 'copy-password') { const shown = document.querySelector('#new-password')?.textContent; if (shown) { await writeText(shown); notify('Password copied.'); } return; }
  if (name === 'revoke') { modal('End website sessions?', '<p class="quiet">This signs out every browser session and cancels unused login links.</p>',button('End all sessions','confirm-revoke',true)); return; }
  if (name === 'confirm-revoke') return operate(async()=>{ await call({action:'revoke_sessions'}); dialog.close(); },'Website sessions ended.');
  if (name === 'rotate') { if (!accountReady()) { notify('Activate the account before rotating its keys.',true); return; } modal('Prepare replacement account keys.',`<form id="rotation-form" class="form-grid"><p class="quiet">Choose a new account key file. Your current account key remains untouched. You’ll back up the replacement and review the rotation before it happens.</p>${field('Replacement account key file','replacement-file',snapshot.ghost_seed_file+'.replacement-'+Date.now(),'text','Choose a new file. Existing files are never replaced.',true)}<button class="btn" type="button" data-new-path="replacement-file">Choose another location</button><button class="btn btn--primary" type="submit">Generate replacement</button></form>`); return; }
}
document.addEventListener('click',async(event)=>{
  if ((event.target as HTMLElement).closest('.skip-link')) { event.preventDefault(); main.focus({preventScroll:true}); main.scrollIntoView({block:'start'}); return; }
  const target=(event.target as HTMLElement).closest<HTMLElement>('button'); if (!target || busy) return;
  if (target.hasAttribute('data-close')) return closeModal();
  if (target.dataset.action) { try { await action(target.dataset.action); } catch(error) { notify(message(error),true); } return; }
  if (target.dataset.tab) { selectTab(target.dataset.tab); return; }
  if (target.dataset.removeRecovery) return operate(async()=>{ await call({action:'save_settings',settings:{...snapshot.settings,recovery_seed_files:snapshot.settings.recovery_seed_files.filter((path:string)=>path !== target.dataset.removeRecovery)}}); await refresh(); },'Recovery location removed. The account key file remains on disk.');
  if (target.dataset.exportRecovery) return operate(async()=>{ if (!native) throw {message:'Key export is available in the installed desktop app.'}; const destination=await save({title:'Back up older account key',defaultPath:'gigahost-recovery-backup.seed'}); if(destination) { await call({action:'export_recovery_key',source:target.dataset.exportRecovery,destination}); notify('Account key backup saved.'); } });
  if (target.dataset.newPath) { if (!native) return; const destination=await save({title:target.dataset.newPath === 'new-file' ? 'Choose wallet file location' : 'Choose account key location',defaultPath:(document.getElementById(target.dataset.newPath) as HTMLInputElement).value}); if(destination) (document.getElementById(target.dataset.newPath) as HTMLInputElement).value=destination; return; }
  if (target.dataset.reviewPayout) return operate(async()=>{ const op=await call({action:'payout_review',id:target.dataset.reviewPayout}); cacheOperation(op); payoutReview(op); });
  if (target.dataset.discardPayout) return operate(async()=>{ cacheOperation(await call({action:'discard_payout',id:target.dataset.discardPayout})); renderPreservingInputs(); });
  if (target.dataset.confirmPayout) return operate(async()=>{
    const id=target.dataset.confirmPayout;
    let op:Json;
    try { op=await call({action:'confirm_payout',id}); }
    catch(error) { const saved=await call({action:'payout_review',id}).catch(()=>null); if(saved) { cacheOperation(saved); renderPreservingInputs(); payoutReview(saved); } throw error; }
    cacheOperation(op);
    if(op.kind === 'payout') {
      if(op.review.result) snapshot.payouts={data:[op.review.result,...(data('payouts') || []).filter((row:Json)=>row.payout_id !== op.review.result.payout_id)],error:null};
      const amount=document.querySelector<HTMLInputElement>('#payout-amount'); if(amount) amount.value='';
    } else if(data('provider_balance')) data('provider_balance').payout_address=op.review.address;
    dialog.close(); location.hash='payouts'; await refresh();
    notify(op.kind === 'payout' ? 'Payout requested. Its status updates automatically.' : 'Payout address saved.');
  });
  if (target.dataset.pick) { const path=await pickFile(); if(path) (document.getElementById(target.dataset.pick) as HTMLInputElement).value=path; return; }
  if (target.dataset.exportReplacement) return operate(async()=>{ if (!native) throw {message:'Key export is available in the installed desktop app.'}; const destination=await save({title:'Back up replacement account key',defaultPath:'gigahost-replacement-backup.seed'}); if(destination) { await call({action:'export_replacement_key',id:target.dataset.exportReplacement,destination}); notify('Replacement account key backup saved.'); } });
  const id = target.dataset.broadcast || target.dataset.status || target.dataset.discard || target.dataset.reviewPayment || target.dataset.reviewRestore || target.dataset.approve || target.dataset.rotation || target.dataset.rotateConfirm;
  const op = snapshot?.operations?.find((o:Json)=>o.id === id);
  if (target.dataset.reviewPayment) return paymentReview(op);
  if (target.dataset.reviewRestore) return restoreReview(op);
  if (target.dataset.rotation) { if(['prepared','uncertain','submitting'].includes(op.state)) rotationReview(op); else await operate(async()=>{ await call({action:'reconcile_rotation',id}); await refresh(); },'Rotation confirmed. Replacement key selected.'); return; }
  if (target.dataset.broadcast) return operate(async()=>{
    const r=await call({action:'broadcast',id});
    if (['broadcast','pending','included'].includes(r.status)) resetSendForm();
    dialog.close(); await refresh();
    if (op.kind === 'activation') location.hash='account';
    notify(r.status === 'broadcast' ? 'Payment submitted. Status updates automatically until 10 confirmations.' : 'Payment status: '+r.status);
  });
  if (target.dataset.status) return operate(async()=>{ const r=await call({action:'payment_status',id}); await refresh(); notify(r.status === 'unknown' ? 'This RPC does not know the transaction yet. It may still have been accepted.' : `${r.status.replaceAll('_',' ')} · ${r.confirmations} confirmations`); });
  if (target.dataset.discard) return operate(async()=>{ await call({action:'discard_payment',id}); await refresh(); });
  if (target.dataset.approve) { if(!(document.querySelector('#restore-confirm') as HTMLInputElement).checked) { notify('Confirm that you reviewed the restore first.',true); return; } const recovery=(document.querySelector('#restore-recovery') as HTMLInputElement).value.trim(); return operate(async()=>{ notify('Waiting for the destination and authorizing the backup. This can take several minutes.'); await call({action:'approve_restore',id,recovery_seed_file:recovery || null}); dialog.close(); await refresh(); },'Restore authorized. Follow its progress on the website.'); }
  if (target.dataset.rotateConfirm) { if(!(document.querySelector('#rotation-confirm') as HTMLInputElement).checked) { notify('Back up both account keys and confirm before rotating.',true); return; } return operate(async()=>{ await call({action:'rotate_keys',id}); dialog.close(); await refresh(); },'Keys rotated. The old account key remains available for earlier backups.'); }
});
document.addEventListener('submit',async(event)=>{
  const form=event.target as HTMLFormElement; event.preventDefault(); if(busy) return;
  const values=new FormData(form), text=(name:string)=>String(values.get(name) || '').trim();
  if(form.id === 'payout-address-form' && text('payout-address') === data('provider_balance')?.payout_address) return;
  if(['payout-form','payout-address-form'].includes(form.id)) return operate(async()=>{
    modal('Preparing your review.', '<p class="quiet">Checking your account and payout details…</p>');
    try {
      const op=await call(form.id === 'payout-form' ? {action:'prepare_payout',amount:text('payout-amount')} : {action:'prepare_payout_address',address:text('payout-address')});
      cacheOperation(op); renderPreservingInputs(); payoutReview(op);
    } catch(error) { modal('Could not prepare review.', '<p class="quiet">Refresh your earnings and check the details.</p>'); throw error; }
  });
  if(form.id === 'send-form') {
    const memo=String(values.get('memo') || '');
    if(memoBytes(memo)>64) { notify('Memo exceeds 64 UTF-8 bytes.',true); return; }
    return operate(async()=>{
      modal('Preparing your payment.', '<p class="quiet">Checking funds and estimating the network fee…</p>');
      let op:Json;
      try { op=await call({action:'prepare_send',target:text('target'),amount:text('amount'),memo:purpose === 'send' ? memo || null : null,passphrase,purpose}); }
      catch(error) { modal('Could not prepare payment.', '<p class="quiet">Your payment has not been sent.</p>'); throw error; }
      snapshot.operations=[...snapshot.operations.filter((saved:Json)=>saved.id !== op.id),op];
      renderPreservingInputs();
      paymentReview(op);
    });
  }
  if(form.id === 'unlock-form') { passphrase=String(values.get('passphrase') || ''); dialog.close(); await refresh(); return; }
  if(form.id === 'wallet-create-form') { const importing=form.dataset.import === 'true'; const pass=String(values.get('new-passphrase') || '') || null; if (!importing && String(values.get('confirm-passphrase') || '') !== (pass || '')) { notify('The derivation passphrases do not match. Re-enter both before creating the wallet.',true); return; } const mnemonic=importing ? text('mnemonic') : null; return operate(async()=>{ await call({action:'create_wallet',file:text('new-file') || null,mnemonic,passphrase:pass}); form.reset(); passphrase=pass; dialog.close(); await refresh(); modal('Your wallet is ready.',`<p class="quiet">Save a private backup before receiving funds. A derivation passphrase, if used, is needed alongside your recovery material.</p>`,button('Back up wallet file','export-wallet',true)+button('Show recovery words','mnemonic')); }); }
  if(form.id === 'account-import-form') {
    const file=text('import-file') || null, line=String(values.get('import-line') || '').trim() || null;
    if ((file === null) === (line === null)) { notify('Choose an account key file or paste the account key line, one of the two.',true); return; }
    return operate(()=>importAccount({file,line},false));
  }
  if(form.id === 'account-create-form') return operate(async()=>{ await call({action:'create_account',file:text('account-file') || null}); dialog.close(); await refresh(); modal('Your account key is ready.',`<p class="quiet">Back up this account key before activating your account. It protects your account and future hosted backups.</p><div class="key-location">${e(snapshot.ghost_seed_file)}</div>`,button('Back up account key','export-account',true)); });
  if(form.id === 'settings-form') { const settings={...snapshot.settings,wallet_file:text('wallet_file') || null,ghost_seed_file:text('ghost_seed_file') || null,recovery_seed_files:snapshot.settings.recovery_seed_files,account_index:Number(text('account_index')),num_addresses:Number(text('num_addresses')),theme:text('theme'),rpc_url:text('rpc_url'),api_url:text('api_url'),website_url:text('website_url')}; const walletChanged=settings.wallet_file !== snapshot.settings.wallet_file || settings.account_index !== snapshot.settings.account_index; return operate(async()=>{ await call({action:'save_settings',settings}); if (walletChanged) passphrase=null; await refresh(); },'Settings saved.'); }
  if(form.id === 'password-form') {
    const days = passwordExpiryDays(text('password-expiry'));
    if (days === undefined) { notify('Choose an expiry of 1 to 3650 days, or leave it empty.',true); return; }
    // The password lives only in the dialog that shows it; closing the
    // dialog empties it.
    return operate(async()=>{ const set=await call({action:'set_website_password',expires_in_days:days}); modal('Your new website password.', `<p class="quiet">It is shown only this once: keep it in a password manager. It replaced the previous password and ended the website sessions that one began.</p><p id="new-password" class="address-text code">${e(set.password)}</p>${set.expires_at ? `<p class="note">It expires ${e(new Date(set.expires_at).toLocaleString())}.</p>` : ''}`, button('Copy password','copy-password',true)); await refresh(true); }).then(()=>renderPreservingInputs());
  }
  if(form.id === 'restore-form') return operate(async()=>{ const op=await call({action:'inspect_restore',reference:text('reference')}); await refresh(); await restoreReview(op); });
  if(form.id === 'rotation-form') return operate(async()=>{ const op=await call({action:'prepare_rotation',file:text('replacement-file')}); form.reset(); await refresh(); rotationReview(op); });
});
document.addEventListener('input',(event)=>{ const input=event.target as HTMLInputElement; if(main.contains(input)) main.dataset.editing='true'; if(input.id === 'memo') updateMemoCount(); if(input.id === 'payout-address') updatePayoutAddressButton(); });
document.addEventListener('change',async(event)=>{ const input=event.target as HTMLInputElement; if(input.id === 'wallet-choice') (document.querySelector('#wallet_file') as HTMLInputElement).value=input.value; if(input.id === 'receive-select') { document.querySelector('#receive-address')!.textContent=input.value; await drawQR(); } });
function selectTab(next: string) { tab=next; purpose='send'; render(); document.querySelector<HTMLElement>(`#wallet-tab-${tab}`)!.focus(); }
document.addEventListener('keydown',event=>{
  const target=(event.target as HTMLElement).closest<HTMLElement>('[data-tab]'); if (!target || busy) return;
  const tabs=['send','receive','history'], current=tabs.indexOf(target.dataset.tab!);
  const next=event.key === 'ArrowRight' ? tabs[(current+1)%3] : event.key === 'ArrowLeft' ? tabs[(current+2)%3] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[2] : null;
  if (next) { event.preventDefault(); selectTab(next); }
});
dialog.addEventListener('cancel',event=>{ if(busy) event.preventDefault(); });
dialog.addEventListener('close',()=>{ if(dialog.open) return; document.querySelector('#dialog-content')!.textContent=''; if(modalReturnFocus?.isConnected) modalReturnFocus.focus({preventScroll:true}); else main.focus({preventScroll:true}); modalReturnFocus=null; });
window.addEventListener('hashchange',()=>{ const hash=location.hash.slice(1); page=(pages.includes(hash) ? hash : 'home') as Page; render(); window.scrollTo({top:0}); main.focus({preventScroll:true}); });
document.querySelector('#theme-toggle')!.addEventListener('click',async()=>{ if(!snapshot || busy) return; const current=snapshot.settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : snapshot.settings.theme; const theme=current === 'dark' ? 'light' : 'dark'; await operate(async()=>{ await call({action:'save_settings',settings:{...snapshot.settings,theme}}); snapshot.settings.theme=theme; document.documentElement.dataset.theme=theme; },`Theme: ${theme}`); });
async function receiveApproval(reference:string) { if(busy) { notify('Finish the current action, then paste the approval link on the Account screen.',true); return; } await operate(async()=>{ const op=await call({action:'inspect_restore',reference}); location.hash='account'; await refresh(); await restoreReview(op); }); }
page=(pages.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home') as Page;
await refresh(true);
if(native) {
  await listen<string>('restore-link',event=>receiveApproval(event.payload));
  const startup=await invoke<string|null>('startup_approval'); if(startup) await receiveApproval(startup);
}
// Submitted payments keep updating through inclusion, up to ten confirmations.
// Background reads preserve forms and dialogs and never broadcast or retry a payment.
setInterval(()=>void pollActivity(),10_000);
window.addEventListener('focus',()=>void pollActivity(true));
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState === 'visible') void pollActivity(true); });

async function pollActivity(force = false) {
  if (busy || polling || document.visibilityState !== 'visible') return;
  const payments = (snapshot?.operations || []).filter(paymentNeedsUpdate);
  const payoutsActive = (data('payouts') || []).some(payoutNeedsUpdate);
  if (!force && !payments.length && !payoutsActive && Date.now()-lastPollAt < 30_000) return;
  const version = generation;
  const checkActivation = payments.some(matchingActivation);
  polling=true; lastPollAt=Date.now();
  try {
    for(const op of payments) {
      if (busy || version !== generation) return;
      await call({action:'payment_status',id:op.id}).catch(()=>{});
    }
    if (busy || version !== generation || !await refresh(true)) return;
    if (checkActivation && !busy && !dialog.open && accountState(snapshot.keys,snapshot.account) === 'unactivated' && snapshot.operations.some((op:Json)=>matchingActivation(op) && op.state === 'included' && op.confirmations >= data('activation_terms')?.minimum_confirmations)) {
      const activationVersion = generation;
      await call({action:'activate_account'}).catch(()=>{});
      if (!busy && activationVersion === generation) await refresh(true);
    }
  } finally { polling=false; }
}
function depositsView() {
  if (!accountReady()) return '';
  const rows=data('deposits')?.items || [];
  return `<section class="section stack"><h2 class="section-title">Gigahost deposits</h2><p class="quiet">Network inclusion and service credit are separate steps. Deposits can take time to appear; wait for credit before sending again.</p>${errorLine(snapshot.deposits)}${!rows.length ? '<p class="note">No deposits detected yet.</p>' : `<div class="table-wrap"><table class="desktop-table"><thead><tr><th>Transaction</th><th>MMX received</th><th>Status</th><th>USD credited</th></tr></thead><tbody>${rows.map((r:Json)=>`<tr><td><span class="code" title="${e(r.transaction_id)}">${e(String(r.transaction_id).slice(0,12))}…</span><span class="memo">${e(r.observed_at ? new Date(r.observed_at).toLocaleString() : '')}</span></td><td>${mmx(r.amount_mmx_atomic)}</td><td>${badge(r.state,r.state === 'credited' ? 'success' : 'warning')}</td><td>${usdExact(r.amount_microusd)}</td></tr>`).join('')}</tbody></table></div>`}</section>`;
}
function offeringPrices(offering:Json, operation:Json) {
  const network=(offering.network_prices || []).find((p:Json)=>p.gateway_tier === (operation.gateway_tier ?? null));
  return `<section class="stack"><h3 class="section-title">New instance charges</h3><dl class="facts-list">${fact('Creation charge',usdExact(offering.instance_creation_charge_microusd))}${fact('Balance reserved',usdExact(offering.balance_reservation_microusd))}${fact('Base / 30-day month',usdExact(offering.base_price_microusd_per_month))}${fact('At full CPU use / month',usdExact(offering.full_utilization_price_microusd_per_month))}${fact('Gateway base / month',usdExact(network?.gateway_base_charge_microusd_per_month))}${fact('Traffic / TiB',usdExact(network?.combined_microusd_per_tib))}</dl><p class="quiet">Gateway placement can add a reservation and charges. Review its selected tier and location on the website.</p></section>`;
}
