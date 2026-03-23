/**
 * services/tokenLaunchLocal.js
 * Token launch via PumpPortal trade-local API.
 * The USER's wallet signs and pays - they become the creator.
 */

const { Keypair, VersionedTransaction, Connection } = require('@solana/web3.js');
const axios = require('axios');
const FormData = require('form-data');

const PUMP_IPFS_API = 'https://pump.fun/api/ipfs';
const PUMP_LOCAL_API = 'https://pumpportal.fun/api/trade-local';
const HELIUS_RPC = 'https://mainnet.helius-rpc.com/?api-key=' + (process.env.HELIUS_API_KEY || 'df6e4ab9-4411-414a-93e7-1ef173635b18');
const MIN_SOL_FOR_CREATE = 0.05; // ~0.02 creation fee + rent + tx fees buffer

async function getWalletBalance(publicKey) {
  try {
    const conn = new Connection(HELIUS_RPC, 'confirmed');
    const balance = await conn.getBalance(new (require('@solana/web3.js').PublicKey)(publicKey));
    return balance / 1e9; // lamports to SOL
  } catch (e) {
    console.warn('[tokenLaunchLocal] Could not check balance:', e.message);
    return null;
  }
}

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
  const metadata = res.data.metadata || {};
  if (!metadataUri) throw new Error('IPFS upload failed: ' + JSON.stringify(res.data));

  console.log('[tokenLaunchLocal] IPFS URI:', metadataUri);
  return { metadataUri, metadata };
}
async function callTradeLocal(requestBody) {
  console.log('[tokenLaunchLocal] Calling trade-local:', JSON.stringify(requestBody, null, 2));

  const response = await axios.post(PUMP_LOCAL_API, requestBody, {
    headers: { 'Content-Type': 'application/json' },
    responseType: 'arraybuffer',
    timeout: 30000,
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    const errorText = Buffer.from(response.data).toString('utf-8');
    console.error('[tokenLaunchLocal] PumpPortal', response.status, errorText);
    return { ok: false, status: response.status, error: errorText };
  }
  return { ok: true, data: response.data };
}

async function buildLocalLaunchTransaction({
  userPublicKey, name, symbol, description, imageUrl,
  twitter, telegram, website, devBuySol = 0, slippageBps = 500,
}) {
  const mintKeypair = Keypair.generate();
  const mintAddress = mintKeypair.publicKey.toBase58();
  console.log('[tokenLaunchLocal] Generated mint:', mintAddress);

  // Check wallet balance
  const balance = await getWalletBalance(userPublicKey);
  console.log('[tokenLaunchLocal] Wallet balance:', balance, 'SOL');

  let effectiveDevBuy = devBuySol;
  let balanceWarning = null;

  if (balance !== null) {
    const maxDevBuy = Math.max(0, balance - MIN_SOL_FOR_CREATE);
    if (devBuySol > maxDevBuy) {
      console.warn('[tokenLaunchLocal] Wallet has', balance, 'SOL, max dev buy ~', maxDevBuy.toFixed(4));
      if (maxDevBuy < 0.001) {
        effectiveDevBuy = 0;
        balanceWarning = 'Wallet has ' + balance.toFixed(4) + ' SOL. Creating token without dev buy (need more SOL for dev buy).';
      } else {
        effectiveDevBuy = Math.floor(maxDevBuy * 100) / 100;
        balanceWarning = 'Dev buy reduced to ' + effectiveDevBuy + ' SOL (wallet has ' + balance.toFixed(4) + ' SOL).';
      }
    }
  }

  // Upload metadata to IPFS
  const { metadataUri, metadata } = await uploadToPumpIpfs({
    name, symbol, description, imageUrl, twitter, telegram, website
  });

  // Build request body matching PumpPortal docs exactly
  const requestBody = {
    publicKey: userPublicKey,
    action: 'create',
    tokenMetadata: {
      name: metadata.name || name,
      symbol: metadata.symbol || symbol,
      uri: metadataUri
    },
    mint: mintAddress,
    denominatedInSol: 'true',
    amount: effectiveDevBuy,
    slippage: Math.round(slippageBps / 100),
    priorityFee: 0.0005,
    pool: 'pump'
  };

  // First attempt with dev buy
  let result = await callTradeLocal(requestBody);

  // If 400 and had dev buy, retry without dev buy
  if (!result.ok && result.status === 400 && effectiveDevBuy > 0) {
    console.warn('[tokenLaunchLocal] Retrying with amount=0 (likely insufficient funds for dev buy)');
    requestBody.amount = 0;
    balanceWarning = 'Dev buy of ' + effectiveDevBuy + ' SOL failed (insufficient funds). Token created without dev buy.';
    effectiveDevBuy = 0;
    result = await callTradeLocal(requestBody);
  }

  if (!result.ok) {
    throw new Error('PumpPortal trade-local failed (' + result.status + '): ' + result.error);
  }

  // Deserialize and partially sign with mint keypair
  const tx = VersionedTransaction.deserialize(new Uint8Array(result.data));
  tx.sign([mintKeypair]);
  console.log('[tokenLaunchLocal] Partially signed with mint keypair');

  return {
    transaction: Buffer.from(tx.serialize()).toString('base64'),
    mintAddress,
    metadataUri,
    devBuyAmount: effectiveDevBuy,
    balanceWarning
  };
}

module.exports = { buildLocalLaunchTransaction };
