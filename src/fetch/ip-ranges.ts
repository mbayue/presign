/**
 * IP range guard (Req 14.2). Blocks loopback, private, link-local and
 * unspecified ranges for IPv4 and IPv6, including IPv4-mapped IPv6 forms.
 * Anything that cannot be parsed as an IP address is treated as blocked
 * (fail closed).
 */
import { isIP } from 'node:net';

type V4Range = { base: number; prefix: number };

const V4_BLOCKED: readonly V4Range[] = [
  { base: ipv4(0, 0, 0, 0), prefix: 8 }, // unspecified / "this network"
  { base: ipv4(10, 0, 0, 0), prefix: 8 }, // private
  { base: ipv4(127, 0, 0, 0), prefix: 8 }, // loopback
  { base: ipv4(169, 254, 0, 0), prefix: 16 }, // link-local
  { base: ipv4(172, 16, 0, 0), prefix: 12 }, // private
  { base: ipv4(192, 168, 0, 0), prefix: 16 }, // private
];

function ipv4(a: number, b: number, c: number, d: number): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function parseIpv4(s: string): number | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function isBlockedV4(n: number): boolean {
  return V4_BLOCKED.some(({ base, prefix }) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((n & mask) >>> 0) === base;
  });
}

/** Parses an IPv6 address into eight 16-bit groups. Supports `::` and a trailing dotted IPv4. */
function parseIpv6(input: string): number[] | null {
  let s = input;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);

  // Rewrite a trailing dotted IPv4 (e.g. ::ffff:127.0.0.1) as two hex groups.
  const lastColon = s.lastIndexOf(':');
  if (lastColon >= 0 && s.includes('.', lastColon)) {
    const v4 = parseIpv4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = parseGroups(halves[0] ?? '');
  if (head === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;

  const rest = parseGroups(halves[1] ?? '');
  if (rest === null) return null;
  const known = head.length + rest.length;
  if (known > 7) return null;
  return [...head, ...new Array<number>(8 - known).fill(0), ...rest];
}

function isBlockedV6(g: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const first96Zero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;

  if (first96Zero && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: and ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local

  const embedded = ((g6 << 16) | g7) >>> 0;
  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d).
  const mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff;
  if (mapped || first96Zero) return isBlockedV4(embedded);
  return false;
}

/** True when `ip` is in a blocked range or is not a parseable IP address. Accepts `[v6]` brackets. */
export function isBlockedIp(ip: string): boolean {
  const s = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const v4 = parseIpv4(s);
  if (v4 !== null) return isBlockedV4(v4);
  const v6 = parseIpv6(s);
  if (v6 !== null) return isBlockedV6(v6);
  return true;
}

/** True when `host` (a URL hostname, possibly bracketed) is an IP literal. */
export function isIpLiteral(host: string): boolean {
  const s = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return isIP(s) !== 0;
}
