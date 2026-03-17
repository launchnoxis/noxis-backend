/**
 * vesting.js
 * Builds vesting schedule transactions.
 *
 * Strategy: Since pump.fun tokens are SPL tokens, we implement vesting
 * by locking tokens in a PDA-controlled escrow account that releases
 * linearly over the vesting period.
 *
 * For production, integrate with an established vesting program like:
 *   - Streamflow (streamflow.finance)
 *   - Vesting Contract by Solana Labs
 * Here we build the transaction structure and show how to call Streamflow.
 */

const {
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} = require('@solana/spl-token');
const { getConnection, getRecentBlockhash } = require('./solana');

// Streamflow vesting program (mainnet)
const STREAMFLOW_PROGRAM_ID = new PublicKey(
  'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m'
);

/**
 * Build a vesting schedule using Streamflow protocol.
 * Returns an unsigned transaction for the frontend wallet to sign.
 *
 * @param {object} p
 * @param {string} p.senderWallet       - wallet that owns the tokens (dev)
 * @param {string} p.recipientWallet    - wallet that receives vested tokens (same dev or team)
 * @param {string} p.mintAddress        - token mint
 * @param {number} p.totalTokens        - total tokens to vest
 * @param {number} p.cliffSeconds       - cliff in seconds from now
 * @param {number} p.vestingSeconds     - total vesting duration in seconds
 * @param {number} p.releaseFrequency   - release every N seconds (e.g. 86400 = daily)
 */
async function buildVestingTransaction({
  senderWallet,
  recipientWallet,
  mintAddress,
  totalTokens,
  cliffSeconds,
  vestingSeconds,
  releaseFrequency = 86400,
}) {
  const connection = getConnection();
  const sender = new PublicKey(senderWallet);
  const recipient = new PublicKey(recipientWallet);
  const mint = new PublicKey(mintAddress);

  const startTime = Math.floor(Date.now() / 1000) + 10; // 10s buffer
  const cliffTime = startTime + cliffSeconds;
  const endTime = startTime + vestingSeconds;

  // Amount per release period
  const periods = Math.floor(vestingSeconds / releaseFrequency);
  const amountPerPeriod = Math.floor(totalTokens / periods);

  // Derive Streamflow escrow PDAs
  const [escrowPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('strm'),
      sender.toBuffer(),
      mint.toBuffer(),
      Buffer.from(startTime.toString()),
    ],
    STREAMFLOW_PROGRAM_ID
  );

  const senderTokenAccount = await getAssociatedTokenAddress(mint, sender);
  const escrowTokenAccount = await getAssociatedTokenAddress(mint, escrowPDA, true);

  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: sender });

  // Create escrow token account if needed
  tx.add(
    createAssociatedTokenAccountInstruction(sender, escrowTokenAccount, escrowPDA, mint)
  );

  // Transfer tokens to escrow
  tx.add(
    createTransferInstruction(
      senderTokenAccount,
      escrowTokenAccount,
      sender,
      BigInt(totalTokens * Math.pow(10, 6)), // 6 decimals
      [],
      TOKEN_PROGRAM_ID
    )
  );

  // NOTE: In production you'd add the Streamflow `create` instruction here
  // using their TypeScript SDK: @streamflow/stream
  // The SDK handles the full PDA derivation and instruction encoding.
  // See: https://docs.streamflow.finance/sdk

  const scheduleInfo = {
    escrowAddress: escrowPDA.toBase58(),
    startTime,
    cliffTime,
    endTime,
    amountPerPeriod,
    totalTokens,
    releaseFrequency,
    periodsTotal: periods,
  };

  return {
    transaction: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    scheduleInfo,
    lastValidBlockHeight,
  };
}

/**
 * Calculate vesting schedule details (no transaction — for UI preview)
 */
function calculateVestingSchedule({
  totalTokens,
  cliffDays,
  vestingMonths,
  releaseFrequencyDays = 1,
}) {
  const cliffSeconds = cliffDays * 86400;
  const vestingSeconds = vestingMonths * 30 * 86400;
  const periods = Math.floor(vestingSeconds / (releaseFrequencyDays * 86400));
  const tokensPerPeriod = totalTokens / periods;
  const cliffDate = new Date(Date.now() + cliffSeconds * 1000);
  const endDate = new Date(Date.now() + vestingSeconds * 1000);

  const schedule = [];
  for (let i = 1; i <= Math.min(periods, 12); i++) {
    const releaseDate = new Date(
      cliffDate.getTime() + i * releaseFrequencyDays * 86400 * 1000
    );
    schedule.push({
      period: i,
      date: releaseDate.toISOString().split('T')[0],
      tokens: Math.floor(tokensPerPeriod),
      cumulative: Math.floor(tokensPerPeriod * i),
      percentage: ((tokensPerPeriod * i) / totalTokens) * 100,
    });
  }

  return {
    cliffDate: cliffDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0],
    periodsTotal: periods,
    tokensPerPeriod: Math.floor(tokensPerPeriod),
    schedule,
  };
}

module.exports = { buildVestingTransaction, calculateVestingSchedule };
