const { Connection, clusterApiUrl, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const NETWORK = process.env.SOLANA_NETWORK || 'devnet';

const RPC_URL =
  NETWORK === 'mainnet-beta'
    ? process.env.SOLANA_RPC_URL || clusterApiUrl('mainnet-beta')
    : process.env.SOLANA_DEVNET_RPC_URL || clusterApiUrl('devnet');

// Singleton connection — reuse across requests
let _connection = null;

function getConnection() {
  if (!_connection) {
    _connection = new Connection(RPC_URL, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60_000,
    });
  }
  return _connection;
}

// ─── pump.fun program addresses ───────────────────────────────────────────────
const PUMP_FUN_PROGRAM_ID = new PublicKey(
  process.env.PUMP_FUN_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
);
const PUMP_FUN_GLOBAL = new PublicKey(
  process.env.PUMP_FUN_GLOBAL_STATE || '4wTV81evi4fSFoQtZUbnTim7MMYXNTXpT1pfpBUavUVp'
);
const PUMP_FUN_FEE_RECIPIENT = new PublicKey(
  process.env.PUMP_FUN_FEE_RECIPIENT || 'CebN5WGQ4jvEPvsVU4EoHEpgznyQHeP3t7VCfgwGxU6K'
);

/**
 * Derive the bonding curve PDA for a given mint
 */
async function getBondingCurvePDA(mintPublicKey) {
  const [pda] = await PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mintPublicKey.toBuffer()],
    PUMP_FUN_PROGRAM_ID
  );
  return pda;
}

/**
 * Get SOL balance for a wallet address
 */
async function getSolBalance(walletAddress) {
  const connection = getConnection();
  const pubkey = new PublicKey(walletAddress);
  const lamports = await connection.getBalance(pubkey);
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Get recent blockhash for transaction building
 */
async function getRecentBlockhash() {
  const connection = getConnection();
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('confirmed');
  return { blockhash, lastValidBlockHeight };
}

/**
 * Send a pre-signed raw transaction (base64 encoded)
 */
async function sendRawTransaction(base64Tx) {
  const connection = getConnection();
  const txBuffer = Buffer.from(base64Tx, 'base64');
  const sig = await connection.sendRawTransaction(txBuffer, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });
  return sig;
}

/**
 * Confirm a transaction by signature
 */
async function confirmTransaction(signature, lastValidBlockHeight) {
  const connection = getConnection();
  const { blockhash } = await getRecentBlockhash();
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed'
  );
  if (result.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
  }
  return true;
}

module.exports = {
  getConnection,
  getSolBalance,
  getRecentBlockhash,
  sendRawTransaction,
  confirmTransaction,
  getBondingCurvePDA,
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_GLOBAL,
  PUMP_FUN_FEE_RECIPIENT,
  NETWORK,
  RPC_URL,
};
