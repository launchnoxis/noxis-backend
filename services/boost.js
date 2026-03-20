/**
 * boost.js — Real volume engine using 3 funded sub-wallets
 * Buy/sell cycles via PumpPortal Lightning API
 */

const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { Keypair } = require('@solana/web3.js');

const PUMP_PORTAL_API = 'https://pumpportal.fun/api/trade';
const PUMP_API_KEY = process.env.PUMP_PORTAL_API_KEY;

// ─── Load sub-wallets from env ─────────────────────────────────────────────
function loadSubWallets() {
  const wallets = [];
  const bs58Module = require('bs58');
  const bs58Decode = bs58Module.decode || bs58Module.default?.decode || bs58Module.default;

  for (let i = 1; i <= 3; i++) {
    const privKey = process.env[`BOOST_WALLET_${i}_PRIVKEY`];
    const pubKey  = process.env[`BOOST_WALLET_${i}_PUBKEY`];
    if (privKey && pubKey) {
      try {
        const keypair = Keypair.fromSecretKey(bs58Decode(privKey));
        wallets.push({ keypair, pubKey: keypair.publicKey.toBase58(), index: i });
        console.log(`[boost] Loaded sub-wallet ${i}: ${keypair.publicKey.toBase58().slice(0,8)}...`);
      } catch (e) {
        console.warn(`[boost] Failed to load sub-wallet ${i}:`, e.message);
      }
    }
  }
  return wallets;
}

const SUB_WALLETS = loadSubWallets();

// ─── Job store ──────────────────────────────────────────────────────────────
const activeJobs = new Map();
const jobHistory = new Map();

// ─── Execute one trade via trade-local + sub-wallet signing ─────────────────
async function executeTrade({ wallet, mintAddress, action, solAmount }) {
  const { Connection, VersionedTransaction } = require('@solana/web3.js');
  const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

  const body = {
    publicKey: wallet.pubKey,
    action,
    mint: mintAddress,
    amount: action === 'buy' ? solAmount : '100%',
    denominatedInSol: action === 'buy' ? 'true' : 'false',
    slippage: 15,
    priorityFee: 0.003,
    pool: 'pump',
  };

  // trade-local returns an unsigned transaction
  const response = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`trade-local failed ${response.status}: ${text.slice(0, 200)}`);
  }

  // Response is raw transaction bytes
  const txBytes = await response.arrayBuffer();
  const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));

  // Sign with sub-wallet keypair
  tx.sign([wallet.keypair]);

  // Submit to Solana
  const signature = await connection.sendTransaction(tx, { skipPreflight: true });
  console.log(`[boost] Submitted ${action} tx: ${signature.slice(0, 20)}...`);

  // Wait for confirmation
  const { value } = await connection.confirmTransaction(signature, 'confirmed');
  if (value?.err) throw new Error(`Transaction failed: ${JSON.stringify(value.err)}`);

  return signature;
}

// ─── Execute one buy/sell cycle ─────────────────────────────────────────────
async function executeCycle(job) {
  if (SUB_WALLETS.length === 0) {
    console.warn('[boost] No sub-wallets configured — add BOOST_WALLET_1_PRIVKEY etc to Railway');
    job.errors++;
    return;
  }

  try {
    // Pick a random sub-wallet
    const wallet = SUB_WALLETS[Math.floor(Math.random() * SUB_WALLETS.length)];

    // Add ±20% variance to trade amount
    const variance = 0.8 + Math.random() * 0.4;
    const tradeAmount = parseFloat((job.solPerTrade * variance).toFixed(4));

    const isBuy = job.cycleCount % 2 === 0;
    const action = isBuy ? 'buy' : 'sell';

    console.log(`[boost] ${job.jobId} ${action.toUpperCase()} ${tradeAmount} SOL via wallet ${wallet.index}`);

    const signature = await executeTrade({
      wallet,
      mintAddress: job.mintAddress,
      action,
      solAmount: tradeAmount,
    });

    job.cycleCount++;
    job.tradesExecuted++;
    job.lastTradeAt = Date.now();
    if (isBuy) job.totalVolumeSol += tradeAmount;

    const record = {
      ts: Date.now(),
      action,
      amountSol: tradeAmount,
      wallet: wallet.pubKey.slice(0, 8) + '...',
      signature,
      status: 'success',
    };

    const history = jobHistory.get(job.jobId) || [];
    history.push(record);
    jobHistory.set(job.jobId, history.slice(-50));

    console.log(`[boost] ${job.jobId} ${action} success: ${signature.slice(0, 20)}...`);
  } catch (err) {
    job.errors++;
    console.error(`[boost] ${job.jobId} cycle error:`, err.message);
    const history = jobHistory.get(job.jobId) || [];
    history.push({ ts: Date.now(), status: 'error', error: err.message });
    jobHistory.set(job.jobId, history.slice(-50));
    if (job.errors > 10) {
      console.warn(`[boost] ${job.jobId} too many errors, stopping job`);
      stopVolumeJob(job.jobId);
    }
  }
}

// ─── Start job ───────────────────────────────────────────────────────────────
function startVolumeJob({ mintAddress, dailySolTarget, frequencyMinutes, maxTradeSol, ownerWallet }) {
  if (SUB_WALLETS.length === 0) {
    throw new Error('No boost sub-wallets configured on backend. Add BOOST_WALLET_1_PRIVKEY, BOOST_WALLET_2_PRIVKEY, BOOST_WALLET_3_PRIVKEY to Railway environment variables.');
  }

  const jobId = uuidv4();
  const job = {
    jobId,
    mintAddress,
    ownerWallet,
    dailySolTarget,
    frequencyMinutes,
    maxTradeSol,
    solPerTrade: maxTradeSol, // use maxTradeSol directly — daily target is just for display
    status: 'active',
    tradesExecuted: 0,
    cycleCount: 0,
    totalVolumeSol: 0,
    startedAt: Date.now(),
    lastTradeAt: null,
    errors: 0,
  };

  const cronExpr = `*/${Math.max(1, Math.floor(frequencyMinutes))} * * * *`;
  const cronJob = cron.schedule(cronExpr, () => executeCycle(job));
  job._cron = cronJob;

  activeJobs.set(jobId, job);
  jobHistory.set(jobId, []);

  console.log(`[boost] Job ${jobId} started — ${mintAddress} — ${maxTradeSol.toFixed(4)} SOL/trade every ${frequencyMinutes}min`);
  return { jobId, ...sanitizeJob(job) };
}

function stopVolumeJob(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) return { error: 'Job not found' };
  if (job._cron) job._cron.stop();
  job.status = 'stopped';
  return { jobId, status: 'stopped' };
}

function getJobStatus(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) return null;
  return { ...sanitizeJob(job), history: (jobHistory.get(jobId) || []).slice(-20) };
}

function listJobs(ownerWallet) {
  const jobs = [];
  for (const [, job] of activeJobs) {
    if (!ownerWallet || job.ownerWallet === ownerWallet) jobs.push(sanitizeJob(job));
  }
  return jobs;
}

function getSubWallets() {
  return SUB_WALLETS.map(w => ({ index: w.index, pubKey: w.pubKey }));
}

function sanitizeJob(job) {
  const { _cron, ...safe } = job;
  return safe;
}

module.exports = { startVolumeJob, stopVolumeJob, getJobStatus, listJobs, getSubWallets };
