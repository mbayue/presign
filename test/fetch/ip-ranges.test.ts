import { describe, expect, test } from 'bun:test';
import { isBlockedIp } from '../../src/fetch/ip-ranges.ts';

describe('isBlockedIp', () => {
  test.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '0.1.2.3',
    '::1',
    '::',
    '[::1]',
    'fc00::1',
    'fdab:cdef::1',
    'fe80::1',
    'febf::1',
    'fe80::1%eth0',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '[::ffff:a00:1]',
    '::ffff:192.168.0.1',
    '0:0:0:0:0:ffff:a9fe:a9fe',
    'not-an-ip',
    '1.2.3',
  ])('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  test.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '172.15.255.255', '192.169.0.1', '2606:4700::1111', '::ffff:8.8.8.8', 'fec0::1'])(
    'allows %s',
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );
});
