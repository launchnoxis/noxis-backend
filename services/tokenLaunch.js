const { Keypair } = require('@solana/web3.js');
const axios = require('axios');
const FormData = require('form-data');

const PUMP_PORTAL_API = 'https://pumpportal.fun/api/trade-local';
const PUMP_IPFS_API = 'https://pump.fun/api/ipfs';

async function uploadToPumpIpfs({ name, symbol, description, imageUrl, twitter, telegram, website }) {
  const formData = new FormData();

  // Handle image
  if (imageUrl && imageUrl.startsWith('data:')) {
    const matches = imageUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (matches) {
      const mimeType = matches[1];
      const buffer = Buffer.from(matches[2], 'base64');
      const ext = mimeType.split('/')[1] || 'png';
      formData.append('file', buffer, { filename: `token.${ext}`, contentType: mimeType });
    }
  } else if (imageUrl && imageUrl.startsWith('http')) {
    try {
      const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
      const contentType = imgRes.headers['content-type'] || 'image/png';
      const ext = contentType.split('/')[1] || 'png';
      formData.append('file', Buffer.from(imgRes.data), { filename: `token.${ext}`, contentType });
    } catch (e) {
      console.warn('[tokenLaunch] Could not fetch image:', e.message);
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

  console.log('[tokenLaunch] IPFS response:', JSON.stringify(res.data));
  return res.data.metadataUri;
}

async function buildLaunchTransaction({
  creatorWallet, name, symbol, description, imageUrl,
  twitter, telegram, website, devBuySol = 0, slippageBps = 500,
}) {
  const mintKeypair = Keypair.generate();

  const metadataUri = await uploadToPumpIpfs({ name, symbol, description, imageUrl, twitter, telegram, website });
  console.log('[tokenLaunch] Metadata URI:', metadataUri);

  const amount = devBuySol >= 0.1 ? devBuySol : 0.1;

  const bs58 = require('bs58');
  const mintSecretKeyBase58 = bs58.encode(mintKeypair.secretKey);

  const body = {
    publicKey: creatorWallet,
    action: 'create',
    tokenMetadata: {
      name: name,
      symbol: symbol,
      uri: metadataUri,
    },
    mint: mintSecretKeyBase58,
    denominatedInSol: 'true',
    amount: amount,
    slippage: 10,
    priorityFee: 0.0005,
    pool: 'pump',
  };

  console.log('[tokenLaunch] Request to PumpPortal:', JSON.stringify({
    ...body,
    mint: body.mint.slice(0, 8) + '...',
  }));

  const response = await fetch(PUMP_PORTAL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  console.log('[tokenLaunch] PumpPortal status:', response.status);

  if (!response.ok) {
    const errText = await response.text();
    console.error('[tokenLaunch] PumpPortal error body:', errText);
    throw new Error(`PumpPortal error ${response.status}: ${errText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const txBuffer = Buffer.from(arrayBuffer);
  const base64Tx = txBuffer.toString('base64');

  return {
    transaction: base64Tx,
    mintAddress: mintKeypair.publicKey.toBase58(),
    mintKeypairBytes: Array.from(mintKeypair.secretKey),
    metadataUri,
    isVersioned: true,
  };
}

module.exports = { buildLaunchTransaction };
