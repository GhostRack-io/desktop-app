/** Keep chain amounts and micro-USD out of floating point arithmetic. */
export function usd(value: string | number | undefined | null): string {
  if (value == null) return '—';
  const n = BigInt(value); const sign = n < 0n ? '−' : ''; const a = n < 0n ? -n : n;
  const cents = (a + 5_000n) / 10_000n;
  return sign + '$' + (cents / 100n).toLocaleString('en-US') + '.' + (cents % 100n).toString().padStart(2, '0');
}
export function usdExact(value: string | number | bigint | undefined | null): string {
  if (value == null) return '—';
  const n = BigInt(value), a = n < 0n ? -n : n;
  const fraction = (a % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return (n < 0n ? '−' : '') + '$' + (a / 1_000_000n).toLocaleString('en-US') + '.' + fraction;
}
export function mmx(atomic: string | number | bigint, decimals = 6): string {
  const n = BigInt(atomic), base = 10n ** BigInt(decimals);
  const fraction = (n % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (n / base).toString() + (fraction ? '.' + fraction : '');
}
function positiveDecimal(value: unknown, decimals: number): { units: bigint; scale: bigint } | null {
  if (typeof value !== 'string' || value.length > 40 || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) return null;
  const scale = 10n ** BigInt(fraction.length), units = BigInt(whole) * scale + BigInt(fraction || '0');
  return units > 0n ? { units, scale } : null;
}
/** Match settlement's floor to micro-USD and payout preparation's floor to atomic MMX. */
export function topUpUsd(amount: unknown, rate: unknown): string | null {
  const mmxAmount = positiveDecimal(amount, 6), quote = positiveDecimal(rate, 18);
  if (!mmxAmount || !quote) return null;
  return usdExact(mmxAmount.units * 1_000_000n * quote.units / (mmxAmount.scale * quote.scale));
}
export function payoutMmx(microusd: unknown, rate: unknown): string | null {
  const quote = positiveDecimal(rate, 18);
  if (!quote || typeof microusd !== 'string' || microusd.length > 20 || !/^\d+$/.test(microusd) || BigInt(microusd) <= 0n) return null;
  return mmx(BigInt(microusd) * quote.scale / quote.units) + ' MMX';
}
export function memoBytes(text: string): number { return new TextEncoder().encode(text).length; }
export function escape(text: unknown): string { return String(text ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!)); }
