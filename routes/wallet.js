const express = require('express');
const { getSolBalance, getRecentBlockhash, NETWORK } = require('../services/solana');
const { PublicKey } = require('@solana/web3.js');

const router = express.Router();

// ─── GET /api/wallet/balance/:address ────────────────────────────────────────
router.get('/balance/:address', async (req, res, next) => {
  try {
    new PublicKey(req.params.address); // validate
    const sol = await getSolBalance(req.params.address);
    res.json({ address: req.params.address, sol: parseFloat(sol.toFixed(6)), network: NETWORK });
  } catch (err) {
    if (err.message.includes('Invalid public key')) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }
    next(err);
  }
});

// ─── GET /api/wallet/nonce ────────────────────────────────────────────────────
// Returns a fresh blockhash for transaction building
router.get('/nonce', async (req, res, next) => {
  try {
    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash();
    res.json({ blockhash, lastValidBlockHeight });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/wallet/tokens/:address ─────────────────────────────────────────
// Get SPL token accounts for a wallet
router.get('/tokens/:address', async (req, res, next) => {
  try {
    const { getConnection } = require('../services/solana');
    const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
    const connection = getConnection();
    const owner = new PublicKey(req.params.address);

    const accounts = await connection.getParsedTokenAccountsByOwner(owner, {
      programId: TOKEN_PROGRAM_ID,
    });

    const tokens = accounts.value
      .map((acc) => {
        const info = acc.account.data.parsed.info;
        return {
          mint: info.mint,
          amount: info.tokenAmount.uiAmount,
          decimals: info.tokenAmount.decimals,
          ata: acc.pubkey.toBase58(),
        };
      })
      .filter((t) => t.amount > 0);

    res.json({ address: req.params.address, tokens });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/wallet/network ──────────────────────────────────────────────────
router.get('/network', (req, res) => {
  res.json({ network: NETWORK, rpc: process.env.SOLANA_RPC_URL || 'devnet' });
});

module.exports = router;
