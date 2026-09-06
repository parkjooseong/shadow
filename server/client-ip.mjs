import { isIP } from 'node:net';

const MAX_TRUSTED_PROXIES = 64;
const MAX_FORWARDED_HOPS = 16;
const MAX_FORWARDED_BYTES = 1024;

export function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  const address = value.trim();
  // Scoped addresses and host:port values are not stable, global IP identities.
  if (address.includes('%')) return null;
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6) return null;
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function createClientIpResolver(configuration = '') {
  if (typeof configuration !== 'string' || Buffer.byteLength(configuration) > 4096) {
    throw new Error('SHADOW_TRUSTED_PROXIES must be a comma-separated list of exact proxy IP addresses.');
  }
  const entries = configuration.trim() ? configuration.split(',') : [];
  const trusted = new Set(entries.map(normalizeIp));
  if (entries.length > MAX_TRUSTED_PROXIES || trusted.has(null)) {
    throw new Error('SHADOW_TRUSTED_PROXIES accepts up to 64 exact IPv4/IPv6 addresses; hostnames, CIDRs, ports and empty entries are not supported.');
  }

  return (req) => {
    const peer = normalizeIp(req.socket.remoteAddress) ?? 'unknown';
    if (!trusted.has(peer)) return peer;
    const header = req.headers['x-forwarded-for'];
    if (header === undefined) return peer;
    const invalidHeader = () => Object.assign(new Error('전달 IP 헤더가 올바르지 않습니다. 프록시 설정을 확인해 주세요.'), { status: 400 });
    if (typeof header !== 'string' || Buffer.byteLength(header) > MAX_FORWARDED_BYTES) throw invalidHeader();
    const hops = header.split(',');
    if (hops.length > MAX_FORWARDED_HOPS) throw invalidHeader();
    const addresses = hops.map(normalizeIp);
    if (addresses.some((address) => address === null)) throw invalidHeader();
    let client = peer;
    for (let index = addresses.length - 1; index >= 0; index--) {
      if (!trusted.has(client)) break;
      client = addresses[index];
    }
    return client;
  };
}
