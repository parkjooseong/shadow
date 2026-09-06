import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClientIpResolver, normalizeIp } from './client-ip.mjs';

const request = (peer, forwarded) => ({ socket: { remoteAddress: peer }, headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } });

test('normalizes equivalent IPv6 and IPv4-mapped addresses without accepting ports or scopes', () => {
  assert.equal(normalizeIp(' ::FFFF:192.0.2.8 '), '192.0.2.8');
  assert.equal(normalizeIp('0:0:0:0:0:ffff:c000:208'), '192.0.2.8');
  assert.equal(normalizeIp('2001:0DB8:0:0:0:0:0:0001'), '2001:db8::1');
  assert.equal(normalizeIp('::1'), '::1');
  for (const value of ['192.0.2.8:443', '[::1]:443', '[::1]', 'fe80::1%eth0', '127.01.0.1', 'proxy.example', 'unknown', '']) assert.equal(normalizeIp(value), null);
});

test('rejects invalid trusted-proxy configuration instead of broadening trust', () => {
  for (const value of ['*', '0.0.0.0/0', '192.0.2.0/24', 'localhost', '127.0.0.1,', ',127.0.0.1', '127.0.0.1:8787', 'fe80::1%lo', Array(65).fill('127.0.0.1').join(','), null]) {
    assert.throws(() => createClientIpResolver(value), /SHADOW_TRUSTED_PROXIES/);
  }
});

test('ignores forwarded headers from untrusted peers, including malformed attacker input', () => {
  for (const configuration of ['', '192.0.2.10']) {
    const resolve = createClientIpResolver(configuration);
    assert.equal(resolve(request('::ffff:203.0.113.5', '198.51.100.1')), '203.0.113.5');
    assert.equal(resolve(request('203.0.113.5', 'invalid, spoofed, chain')), '203.0.113.5');
    assert.equal(resolve(request(undefined, '198.51.100.1')), 'unknown');
  }
});

test('walks only trusted hops right to left and ignores spoofed addresses before the nearest untrusted hop', () => {
  const resolve = createClientIpResolver('192.0.2.10,2001:db8::1,192.0.2.20');
  assert.equal(resolve(request('::ffff:192.0.2.10', '198.51.100.7')), '198.51.100.7');
  assert.equal(resolve(request('192.0.2.10', '198.51.100.7, 2001:0db8:0:0::1, 192.0.2.20')), '198.51.100.7');
  assert.equal(resolve(request('192.0.2.10', '203.0.113.99, 198.51.100.7, 192.0.2.20')), '198.51.100.7');
  assert.equal(resolve(request('192.0.2.10')), '192.0.2.10');
});

test('rejects malformed or oversized forwarded chains from trusted peers', () => {
  const resolve = createClientIpResolver('127.0.0.1');
  const invalid = ['', 'unknown', '198.51.100.1,,192.0.2.5', '198.51.100.1,invalid', '198.51.100.1:1234', 'fe80::1%lo', Array(17).fill('198.51.100.1').join(','), ' '.repeat(1025), ['198.51.100.1']];
  for (const header of invalid) {
    assert.throws(() => resolve(request('127.0.0.1', header)), (error) => error.status === 400 && !error.message.includes('198.51.100.1'));
  }
});
