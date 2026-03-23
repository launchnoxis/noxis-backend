/**
 * services/tokenLaunchLocal.js
 * Token launch via PumpPortal trade-local API.
 * The USER's wallet signs and pays - they become the creator.
 * Does NOT touch tokenLaunch.js (Lightning API).
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
  const metadataUri = res.data.metadataUri;
  if (!metadataUri) throw new Error('IPFS upload unexpected format: ' + JSON.stringify(res.data));
  console.log('[tokenLaunchLocal] IPFS metadata URI:', metadataUri);
  return metadataUri;
}

async function buildLocalLaunchTransaction({
  userPublicKey, name, symbol, description, imageUrl,
  twitter, telegram, website, devBuySol = 0, slippageBps = 500,
}) {
  const mintKeypair = Keypair.generate();
  console.log('[tokenLaunchLocal] Generated mint:', mintKeypair.publicKey.toBase58());
  const metadataUri = await uploadToPumpIpfs({ name, symbol, description, imageUrl, twitter, telegram, website });
  const requestBody = {
    publicKey: userPublicKey,
    action: 'create',
    tokenMetadata: { name, symbol, uri: metadataUri },
    mint: mintKeypair.publicKey.toBase58(),
    denominatedInSol: 'true',
    amount: devBuySol > 0 ? devBuySol : 0,
    slippage: Math.round(slippageBps / 100),
    priorityFee: 0.0005,
    pool: 'pump',
  };
  console.log('[tokenLaunchLocal] Calling trade-local:', JSON.stringify(requestBody, null, 2));
  const response = await fetch(PUMP_LOCAL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error('PumpPortal trade-local failed (' + response.status + '): ' + errorText);
  }
  const txData = await response.arrayBuffer();
  const tx = VersionedTransaction.deserialize(new Uint8Array(txData));
  tx.sign([mintKeypair]);
  console.log('[tokenLaunchLocal] Partially signed with mint keypair');
  const serializedTx = Buffer.from(tx.serialize()).toString('base64');
  return { transaction: serializedTx, mintAddress: mintKeypair.publicKey.toBase58(), metadataUri };
}

module.exports = { buildLocalLaunchTransaction };
