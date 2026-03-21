const { Keypair } = require('@solana/web3.js');
const axios = require('axios');
const FormData = require('form-data');

const PUMP_LIGHTNING_API = 'https://pumpportal.fun/api/trade';
const PUMP_IPFS_API = 'https://pump.fun/api/ipfs';
const PUMP_API_KEY = process.env.PUMP_PORTAL_API_KEY;

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
  const bs58Encode = bs58Module.encode || bs58Module.default?.encode || bs58Module.default;

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

  const secretKeyBytes = new Uint8Array(mintKeypair.secretKey);
  const mintSecretKeyEncoded = bs58Encode(secretKeyBytes);

  const body = {
    action: 'create',
    tokenMetadata: { name, symbol, uri: metadataUri },
    mint: mintSecretKeyEncoded,
    denominatedInSol: 'true',
    amount: devBuySol > 0 ? devBuySol : 0.1,
    slippage: 10,
    priorityFee: 0.003,
    pool: 'pump',
  };

  console.log('[tokenLaunch] Calling Lightning API for:', name, symbol);

  const response = await fetch(`${PUMP_LIGHTNING_API}?api-key=${PUMP_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const responseText = await response.text();
  console.log('[tokenLaunch] Lightning API status:', response.status, '| body:', responseText.slice(0, 300));

  if (!response.ok) {
    throw new Error(`PumpPortal Lightning error ${response.status}: ${responseText}`);
  }

  const data = JSON.parse(responseText);
  if (!data.signature) throw new Error(`No signature returned: ${responseText}`);

  const { Connection } = require('@solana/web3.js');
  const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

  let confirmed = false;
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const status = await connection.getSignatureStatus(data.signature);
      const conf = status?.value?.confirmationStatus;
      console.log(`[tokenLaunch] Confirmation attempt ${i+1}: ${conf}`);
      if (conf === 'confirmed' || conf === 'finalized') { confirmed = true; break; }
      if (status?.value?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.value.err)}`);
    } catch (e) {
      if (e.message.includes('Transaction failed')) throw e;
    }
  }

  if (!confirmed) console.warn('[tokenLaunch] Could not confirm — may still land');
  console.log('[tokenLaunch] Token launched! Signature:', data.signature);

  return {
    signature: data.signature,
    mintAddress: mintKeypair.publicKey.toBase58(),
    metadataUri,
    pumpFunUrl: `https://pump.fun/${mintKeypair.publicKey.toBase58()}`,
    explorerUrl: `https://solscan.io/tx/${data.signature}`,
  };
}

module.exports = { buildLaunchTransaction };
