const { Keypair, VersionedTransaction } = require('@solana/web3.js');
const axios = require('axios');
const FormData = require('form-data');

const PUMP_TRADE_LOCAL = 'https://pumpportal.fun/api/trade-local';
const PUMP_IPFS_API = 'https://pump.fun/api/ipfs';

async function uploadToPumpIpfs({ name, symbol, description, imageUrl, twitter, telegram, website }) {
  const formData = new FormData();

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

  return res.data.metadataUri;
}

async function buildLaunchTransaction({
  creatorWallet, name, symbol, description, imageUrl,
  twitter, telegram, website, devBuySol = 0.1,
  mintSecretKey,
}) {
  const bs58Module = require('bs58');
  const bs58Decode = bs58Module.decode || bs58Module.default?.decode || bs58Module.default;

  // Use pre-generated keypair if provided
  let mintKeypair;
  if (mintSecretKey) {
    try {
      mintKeypair = Keypair.fromSecretKey(bs58Decode(mintSecretKey));
      console.log('[tokenLaunch] Using pre-generated mint:', mintKeypair.publicKey.toBase58());
    } catch(e) {
      console.warn('[tokenLaunch] Invalid mintSecretKey, generating new:', e.message);
      mintKeypair = Keypair.generate();
    }
  } else {
    mintKeypair = Keypair.generate();
  }

  const metadataUri = await uploadToPumpIpfs({ name, symbol, description, imageUrl, twitter, telegram, website });
  console.log('[tokenLaunch] Metadata URI:', metadataUri);

  // trade-local with action: 'create' — returns base58 encoded transaction
  const body = {
    publicKey: creatorWallet,
    action: 'create',
    tokenMetadata: {
      name,
      symbol,
      uri: metadataUri,
    },
    mint: mintKeypair.publicKey.toBase58(),
    denominatedInSol: 'true',
    amount: devBuySol > 0 ? devBuySol : 0.1,
    slippage: 10,
    priorityFee: 0.003,
    pool: 'pump',
    isMayhemMode: 'false',
  };

  console.log('[tokenLaunch] Calling trade-local create for:', name, symbol);

  const response = await fetch(PUMP_TRADE_LOCAL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('[tokenLaunch] trade-local error:', text.slice(0, 300));
    throw new Error(`PumpPortal trade-local error ${response.status}: ${text.slice(0, 200)}`);
  }

  // Response is raw binary transaction bytes
  const txBytes = await response.arrayBuffer();
  const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));

  // Sign with mint keypair (backend)
  // User's wallet will sign on the frontend
  tx.sign([mintKeypair]);

  const txBase64 = Buffer.from(tx.serialize()).toString('base64');
  console.log('[tokenLaunch] Built tx for mint:', mintKeypair.publicKey.toBase58());

  return {
    transaction: txBase64,
    mintAddress: mintKeypair.publicKey.toBase58(),
    metadataUri,
    pumpFunUrl: `https://pump.fun/${mintKeypair.publicKey.toBase58()}`,
  };
}

module.exports = { buildLaunchTransaction };
