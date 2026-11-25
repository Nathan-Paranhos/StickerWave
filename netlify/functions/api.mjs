import { getStore } from '@netlify/blobs';
import { handleWebApiRequest } from '../../server/api.mjs';
import { createBlobsStore } from '../../server/stores.mjs';

let cachedStore = null;

export default async function handler(request) {
  if (!cachedStore) {
    cachedStore = createBlobsStore(getStore({ name: 'stickerwave-db', consistency: 'strong' }));
  }
  return handleWebApiRequest(request, cachedStore);
}
