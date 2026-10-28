type Outcome = { data?: unknown; error?: { code: string } | null };

export function payoutNeedsUpdate(payout: { state: string }): boolean {
  return ['queued', 'preparing', 'submitting', 'submitted'].includes(payout.state);
}
export function payoutLabel(state: string): string {
  return ({queued:'Queued',preparing:'Being prepared',submitting:'Being sent',submitted:'Waiting for confirmation',confirmed:'Confirmed',under_review:'Under review',action_required:'Waiting for support',cancelled:'Cancelled'} as Record<string,string>)[state] || state.replaceAll('_', ' ');
}
export function payoutNote(payout: {state: string; waiting_reason?: string | null}): string {
  if (payout.state === 'cancelled') return 'The amount is back in your earnings.';
  return ({exchange_rate:'Waiting for the MMX exchange rate.',wallet_liquidity:'Waiting to be sent. No action is needed.',possibly_sent:'Being checked on chain.'} as Record<string,string>)[payout.waiting_reason || ''] || '';
}

export function paymentNeedsUpdate(op: { transaction_id?: string | null; state: string; confirmations?: number | null }): boolean {
  return Boolean(op.transaction_id) && ['submitting', 'uncertain', 'broadcast', 'pending', 'included'].includes(op.state)
    && (op.state !== 'included' || (op.confirmations ?? 0) < 10);
}

// Activate only when the server explicitly says this key has no account.
export function accountState(keys: Outcome, account: Outcome): 'missing' | 'unavailable' | 'unactivated' | 'ready' {
  if (!keys?.data) return keys?.error?.code === 'account_key_missing' ? 'missing' : 'unavailable';
  if (account?.data) return 'ready';
  return ['account_not_activated', 'unknown_account'].includes(account?.error?.code || '') ? 'unactivated' : 'unavailable';
}

// Where a GitHub claim (a sign-up or a link) stands, from one reading of it:
// it waits for the GitHub sign-in until the backend answers that it was
// created, linked or refused
// (it refuses an expired claim itself, and finishes a sign-in made just
// before the expiry after it), or until the wait's limit runs out.
export type GithubStep = { state: 'waiting' } | { state: 'created' } | { state: 'linked' } | { state: 'refused'; reason: string } | { state: 'expired' };
const TRIAL_CLAIM_LIFETIME_MS = 10 * 60_000;
const TRIAL_EXCHANGE_MARGIN_MS = 2 * 60_000;
// The most a claim is followed, in milliseconds counted from now on a clock
// that does not jump: its expiry plus the exchange margin, and never less
// than a whole lifetime, since the claim was made a moment ago and this
// computer's clock may run ahead of the backend's. The backend's answer
// comes before this; it only ends a wait that no answer would.
export function githubWaitLimit(expiresAt: string, now = Date.now()): number {
  const remaining = Date.parse(expiresAt) - now;
  return Math.max(Number.isFinite(remaining) ? remaining : 0, TRIAL_CLAIM_LIFETIME_MS) + TRIAL_EXCHANGE_MARGIN_MS;
}
export function githubStep(claim: { status?: string; reason?: string | null } | null | undefined, waitedMs: number, limitMs: number): GithubStep {
  if (claim?.status === 'created') return { state: 'created' };
  if (claim?.status === 'linked') return { state: 'linked' };
  if (claim?.status === 'refused') return { state: 'refused', reason: claim.reason || 'The GitHub claim was refused.' };
  return waitedMs >= limitMs ? { state: 'expired' } : { state: 'waiting' };
}
// The account's linked GitHub account as one line, `@login (linked DATE)`, from
// `ghost account show`'s github ({login, linked_at}); null when none is linked.
export function githubLabel(github: { login?: string; linked_at?: string } | null | undefined): string | null {
  if (!github?.login) return null;
  const day = /^\d{4}-\d{2}-\d{2}/.exec(github.linked_at ?? '')?.[0];
  return day ? `@${github.login} (linked ${day})` : `@${github.login}`;
}
// Account activation agreement and
// `ghost account activate` say it: activation with GitHub opens the website's sign-up page, which says
// it too, but a deposit's automatic activation shows nothing else.
export const SIGNUP_AGREEMENT = 'By activating the account, with GitHub or with a deposit, you agree to the Terms of Service and the Acceptable Use Policy at gigahost.cloud/terms, and ask that the service starts at once.';
export const TRIAL_LIMITS = 'Trial limits hold until you add funds: instances of 1 vCPU with a shared IP on the platform’s own hosts, no outgoing mail, and no offering of hosts. Adding funds lifts them; the trial credit still ends on its date.';

export function historyLabel(type: string): string {
  return ({ RECEIVE: 'Received', SPEND: 'Sent', SEND: 'Sent', TXFEE: 'Network fee', REWARD: 'Block reward', VDF_REWARD: 'VDF reward', PROJECT_REWARD: 'Project reward' } as Record<string, string>)[type] || type?.replaceAll('_', ' ') || 'Activity';
}

// The account's website password, from `ghost account show`'s
// website_password: none, set, or past its expiry.
export function websitePasswordState(view: { created_at?: string; expires_at?: string | null } | null | undefined, now = Date.now()): 'none' | 'set' | 'expired' {
  if (!view?.created_at) return 'none';
  return view.expires_at && Date.parse(view.expires_at) <= now ? 'expired' : 'set';
}
// The expiry field: empty for none, else whole days from 1 to 3650;
// undefined when it is neither.
export function passwordExpiryDays(text: string): number | null | undefined {
  const value = text.trim();
  if (!value) return null;
  if (!/^[0-9]{1,4}$/.test(value)) return undefined;
  const days = Number(value);
  return days >= 1 && days <= 3650 ? days : undefined;
}
