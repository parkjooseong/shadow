import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';

const app = createApp({ dbPath: ':memory:', origin: 'http://127.0.0.1' });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
try {
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(base);
  assert.equal(response.status, 200, 'Build the SPA before running this check.');
  const html = await response.text();
  const asset = html.match(/src="([^"]+\.js)"/);
  assert.ok(asset, 'The HTML must reference the built application.');
  assert.equal((await fetch(base + asset[1])).status, 200);
  assert.equal((await fetch(base + '/api/health')).status, 200);
  console.info('Built SPA, JavaScript asset and API serving: PASS');
} finally { await app.close(); }
