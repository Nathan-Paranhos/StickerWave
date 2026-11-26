import { getStore } from '@netlify/blobs';
import { runGatewayKeepalive } from '../../server/api.mjs';
import { createBlobsStore } from '../../server/stores.mjs';

let cachedStore = null;

// Netlify Scheduled Function: pings the configured WhatsApp Gateway /health every 10 min on production deploys
// to reduce cold starts / idle sleep on Render Free (within Render's 15-min idle window).
export const config = {
  schedule: '*/10 * * * *',
};

export default async function handler() {
  if (!cachedStore) {
    cachedStore = createBlobsStore(getStore({ name: 'stickerwave-db', consistency: 'strong' }));
  }
  const result = await runGatewayKeepalive({ store: cachedStore, allowLocalHttp: false });
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
