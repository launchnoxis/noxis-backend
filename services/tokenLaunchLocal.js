/**
 * services/tokenLaunchLocal.js
 * Token launch via PumpPortal trade-local API.
 * The USER's wallet signs and pays - they become the creator.
 *
 * IMPORTANT: PumpPortal trade-local "create" action does NOT support
 * amount > 0 (dev buy in same tx). It crashes with toBuffer() error.
 *
 * Flow:
 *   1. buildLocalLaunchTransaction() - creates token (amount=0)
 *   2. Frontend signs & sends create tx, waits for on-chain confirmation
 *   3. buildBuyTransaction() - builds a separate buy tx (token now exists on bonding curve)
 *   4. Frontend signs & sends buy tx
 */

const { Keypair, VersionedTransaction, Connection } = require('@solana/web3.js');
const axios = require('axios');
const FormData = require('form-data');

const PUMP_IPFS_API = 'https://pump.fun/api/ipfs';
const PUMP_LOCAL_API = 'https://pumpportal.fun/api/trade-local';
const HELIUS_RPC = 'https://mainnet.helius-rpc.com/?api-key=' + (process.env.HELIUS_API_KEY || 'df6e4ab9-4411-414a-93e7-1ef173635b18');

async function uploadToPumpIpfs({ name, symbol, description, imageUrl, twitter, telegram, website }) {
  const formData = new FormData();
  if (imageUrl && imageUrl.startsWith('data:')) {
    const matches = imageUrl.match(/^data:([A-Za-z-+\\/]+);base64,(.+)$/);
    if (matches) {
      const buffer = Buffer.from(matches[2], 'base64');
      const ext = matches[1].split('/')[1] || 'png';
      formData.append('file', buffer, { filename: 'token.' + ext, contentType: matches[1] });
    }
  } else if (imageUrl && imageUrl.startsWith('http')) {
    try {
      const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
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
    timeout: 30000
  });
  const metadataUri = res.data.metadataUri;
  const metadata = res.data.metadata || {};
  if (!metadataUri) throw new Error('IPFS upload failed: ' + JSON.stringify(res.data));
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

/**
 * Build the CREATE transaction only (amount=0).
 * Returns the partially-signed tx (signed by mint keypair) for the user wallet to co-sign.
 */
async function buildLocalLaunchTransaction({
  userPublicKey, name, symbol, description, imageUrl,
  twitter, telegram, website, devBuySol = 0, slippageBps = 500,
}) {
  const mintKeypair = Keypair.generate();
  const mintAddress = mintKeypair.publicKey.toBase58();
  console.log('[tokenLaunchLocal] Generated mint:', mintAddress);

  const { metadataUri, metadata } = await uploadToPumpIpfs({
    name, symbol, description, imageUrl, twitter, telegram, website
  });

  // Build CREATE transaction (always amount=0, dev buy is separate after confirmation)
  const createBody = {
    publicKey: userPublicKey,
    action: 'create',
    tokenMetadata: {
      name: metadata.name || name,
      symbol: metadata.symbol || symbol,
      uri: metadataUri
    },
    mint: mintAddress,
    denominatedInSol: 'true',
    amount: 0,
    slippage: Math.round(slippageBps / 100),
    priorityFee: 0.0005,
    pool: 'pump'
  };

  const createResult = await callTradeLocal(createBody);
  if (!createResult.ok) {
    throw new Error('PumpPortal create failed (' + createResult.status + '): ' + createResult.error);
  }

  const createTx = VersionedTransaction.deserialize(new Uint8Array(createResult.data));
  createTx.sign([mintKeypair]);
  console.log('[tokenLaunchLocal] Create tx partially signed with mint keypair');

  return {
    transaction: Buffer.from(createTx.serialize()).toString('base64'),
    mintAddress,
    metadataUri,
  };
}

/**
 * Build a BUY transaction for an existing token on the bonding curve.
 * This must be called AFTER the create tx is confirmed on-chain.
 */
async function buildBuyTransaction({ userPublicKey, mint, amountSol, slippageBps = 500 }) {
  console.log('[tokenLaunchLocal] Building buy tx for', amountSol, 'SOL on mint:', mint);

  const buyBody = {
    publicKey: userPublicKey,
    action: 'buy',
    mint: mint,
    denominatedInSol: 'true',
    amount: amountSol,
    slippage: Math.round(slippageBps / 100),
    priorityFee: 0.0005,
    pool: 'pump'
  };

  const buyResult = await callTradeLocal(buyBody);
  if (!buyResult.ok) {
    throw new Error('PumpPortal buy failed (' + buyResult.status + '): ' + buyResult.error);
  }

  const buyTx = VersionedTransaction.deserialize(new Uint8Array(buyResult.data));
  console.log('[tokenLaunchLocal] Buy tx built successfully');

  return {
    transaction: Buffer.from(buyTx.serialize()).toString('base64'),
  };
}

module.exports = { buildLocalLaunchTransaction, buildBuyTransaction };
