import type { Decimal } from '../scan/types.ts';

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/** Parses /^\d+(\.\d+)?$/ exactly; null for anything else (signs, exponents, empty, leading/trailing dot). */
export function parseDecimal(s: string): Decimal | null {
  const m = DECIMAL_RE.exec(s);
  if (!m) return null;
  const whole = m[1]!;
  const frac = m[2] ?? '';
  return { digits: BigInt(whole + frac), scale: frac.length };
}

/** Plain notation, no exponent. Keeps the scale (so "1.50" prints as "1.50"). */
export function formatDecimal(d: Decimal): string {
  if (d.scale === 0) return d.digits.toString();
  const s = d.digits.toString().padStart(d.scale + 1, '0');
  return `${s.slice(0, s.length - d.scale)}.${s.slice(s.length - d.scale)}`;
}

/** Numeric equality (1.5 == 1.50). */
export function decimalEquals(a: Decimal, b: Decimal): boolean {
  const scale = Math.max(a.scale, b.scale);
  return a.digits * 10n ** BigInt(scale - a.scale) === b.digits * 10n ** BigInt(scale - b.scale);
}

/** Base units; null when the value has more fractional digits than `decimals` allows (Req 3.3). */
export function toBaseUnits(d: Decimal, decimals: number): bigint | null {
  if (d.scale > decimals) return null;
  return d.digits * 10n ** BigInt(decimals - d.scale);
}

/** Formats raw base units with `decimals`, trimming trailing fractional zeros. */
export function formatUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  if (decimals === 0) return `${negative ? '-' : ''}${abs.toString()}`;
  const s = abs.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export const U64_MAX = 18_446_744_073_709_551_615n;
