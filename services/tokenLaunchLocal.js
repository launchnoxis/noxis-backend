/**
 * services/tokenLaunchLocal.js
 * Token launch via PumpPortal trade-local API.
 * The USER's wallet signs and pays - they become the creator.
 */

const { Keypair, VersionedTransaction } = require('@solana/web3.js');
const axios = require('axios');
const FormData = require('form-data');

const PUMP_IPFS_API = 'https://pump.fun/api/ipfs';
const PUMP_LOCAL_API = 'https://pumpportal.fun/api/trade-local';

async function uploadToPumpIpfs({ name, symbol, description, imageUrl, twitter, telegram, website }) {
  const formData = new FormData();

  if (imageUrl && imageUrl.startsWith('data:')) {
    const matches = imageUrl.match(/^data:([A-Za-z-+\\/]+);base64,(.+)$/);
    if (matches) {
      const mimeType = matches[1];
      const buffer = Buffer.from(matches[2], 'base64');
      const ext = mimeType.split('/')[1] || 'png';
      formData.append('file', buffer, { filename: 'token.' + ext, contentType: mimeType });
    }
  } else if (imageUrl && imageUrl.startsWith('http')) {
    try {
      const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
      const contentType = imgRes.headers['content-type'] || 'image/png';
      const ext = contentType.split('/')[1] || 'png';
      formData.append('file', Buffer.from(imgRes.data), { filename: 'token.' + ext, contentType });
    } catch (e) {
      console.warn('[tokenLaunchLocal] Could not fetch image:', e.message);
    }
  }

  formData.append('name', name);
  formData.append('symbol', symbol);
  formData.append('description', description || '');
  if (twitter) formData.append('twitter', twitter);
  if (telegram) formData.append('telegram', telegram);
  if (website) formData.append('website', website);
  formData.append('showName', 'true');

  const res = await axios.post(PUMP_IPFS_API, formData, {
    headers: formData.getHeaders(),
    timeout: 30000,
  });

  // Return the full response so we can use metadata.name and metadata.symbol
  const metadataUri = res.data.metadataUri;
  const metadata = res.data.metadata || {};
  if (!metadataUri) throw new Error('IPFS upload unexpected format: ' + JSON.stringify(res.data));

  console.log('[tokenLaunchLocal] IPFS metadata URI:', metadataUri);
  console.log('[tokenLaunchLocal] IPFS metadata:', JSON.stringify(metadata));

  return { metadataUri, metadata };
}
async function buildLocalLaunchTransaction({
  userPublicKey,
  name,
  symbol,
  description,
  imageUrl,
  twitter,
  telegram,
  website,
  devBuySol = 0,
  slippageBps = 500,
}) {
  // Generate mint keypair
  const mintKeypair = Keypair.generate();
  console.log('[tokenLaunchLocal] Generated mint:', mintKeypair.publicKey.toBase58());

  // Upload metadata to IPFS via pump.fun
  const { metadataUri, metadata } = await uploadToPumpIpfs({
    name, symbol, description, imageUrl, twitter, telegram, website
  });

  // Build request body EXACTLY matching PumpPortal docs
  // Use metadata.name and metadata.symbol from IPFS response (as shown in official examples)
  const requestBody = {
    publicKey: userPublicKey,
    action: 'create',
    tokenMetadata: {
      name: metadata.name || name,
      symbol: metadata.symbol || symbol,
      uri: metadataUri
    },
    mint: mintKeypair.publicKey.toBase58(),
    denominatedInSol: 'true',
    amount: devBuySol > 0 ? devBuySol : 1,
    slippage: Math.round(slippageBps / 100),
    priorityFee: 0.0005,
    pool: 'pump'
  };

  console.log('[tokenLaunchLocal] Calling trade-local with body:', JSON.stringify(requestBody, null, 2));

  // Use axios instead of fetch for reliable server-to-server HTTP
  let response;
  try {
    response = await axios.post(PUMP_LOCAL_API, requestBody, {
      headers: { 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      timeout: 30000,
      validateStatus: () => true, // don't throw on non-2xx so we can log the error
    });
  } catch (netErr) {
    console.error('[tokenLaunchLocal] Network error calling PumpPortal:', netErr.message);
    throw new Error('Network error calling PumpPortal: ' + netErr.message);
  }

  console.log('[tokenLaunchLocal] PumpPortal response status:', response.status);
  console.log('[tokenLaunchLocal] PumpPortal response headers:', JSON.stringify(response.headers));

  if (response.status !== 200) {
    const errorText = Buffer.from(response.data).toString('utf-8');
    console.error('[tokenLaunchLocal] PumpPortal error body:', errorText);
    console.error('[tokenLaunchLocal] Request was:', JSON.stringify(requestBody, null, 2));
    throw new Error('PumpPortal trade-local failed (' + response.status + '): ' + errorText);
  }

  // Deserialize and partially sign with mint keypair
  const tx = VersionedTransaction.deserialize(new Uint8Array(response.data));
  tx.sign([mintKeypair]);
  console.log('[tokenLaunchLocal] Partially signed with mint keypair');

  const serializedTx = Buffer.from(tx.serialize()).toString('base64');

  return {
    transaction: serializedTx,
    mintAddress: mintKeypair.publicKey.toBase58(),
    metadataUri
  };
}

module.exports = { buildLocalLaunchTransaction };
