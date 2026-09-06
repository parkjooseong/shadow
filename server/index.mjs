import { createApp } from './app.mjs';
import { createIntegrationService } from './integrations/index.mjs';

const port = Number(process.env.PORT || process.env.SHADOW_PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const app = createApp({ integrationFactory: ({ store }) => createIntegrationService({ store }) });
app.server.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.info(`SHADOW server listening on port ${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
