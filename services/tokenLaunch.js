const { Keypair, VersionedTransaction, Connection } = require('@solana/web3.js');
const axios = require('axios');
const FormData = require('form-data');

const PUMP_LOCAL_API = 'https://pumpportal.fun/api/trade-local';
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
  mintSecretKey, // pre-generated bs58 secret key from frontend
}) {
  const bs58Module = require('bs58');
  const bs58Decode = bs58Module.decode || bs58Module.default?.decode || bs58Module.default;
  const bs58Encode = bs58Module.encode || bs58Module.default?.encode || bs58Module.default;

  // Use pre-generated keypair if provided, otherwise generate new one
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

  // Upload metadata to IPFS
  const metadataUri = await uploadToPumpIpfs({ name, symbol, description, imageUrl, twitter, telegram, website });
  console.log('[tokenLaunch] Metadata URI:', metadataUri);

  // Call trade-local — returns unsigned transaction bytes
  // User's wallet (creatorWallet) pays gas and dev buy
  const body = {
    publicKey: creatorWallet,
    action: 'create',
    tokenMetadata: { name, symbol, uri: metadataUri },
    mint: mintKeypair.publicKey.toBase58(), // public key only for trade-local
    denominatedInSol: 'true',
    amount: devBuySol > 0 ? devBuySol : 0.1,
    slippage: 10,
    priorityFee: 0.003,
    pool: 'pump',
  };

  console.log('[tokenLaunch] Calling trade-local for:', name, symbol);

  const response = await fetch(PUMP_LOCAL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PumpPortal trade-local error ${response.status}: ${text.slice(0, 300)}`);
  }

  // Response is raw transaction bytes
  const txBytes = await response.arrayBuffer();
  const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));

  // Sign with mint keypair (required — mint must co-sign token creation)
  tx.sign([mintKeypair]);

  // Return partially-signed transaction for frontend wallet to sign + submit
  const txBase64 = Buffer.from(tx.serialize()).toString('base64');
  console.log('[tokenLaunch] Transaction built, awaiting user signature for:', mintKeypair.publicKey.toBase58());

  return {
    transaction: txBase64,           // frontend signs this with user wallet
    mintAddress: mintKeypair.publicKey.toBase58(),
    metadataUri,
    pumpFunUrl: `https://pump.fun/${mintKeypair.publicKey.toBase58()}`,
    signature: null,                 // filled in after frontend submits
  };
}

module.exports = { buildLaunchTransaction };
