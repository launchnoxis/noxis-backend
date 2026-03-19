const express = require('express');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const { getLaunch } = require('../services/db');

const router = express.Router();
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

// Known LP locker program IDs
const KNOWN_LOCKERS = [
  'FjKTQLSMFkbEHQvCdHkB9pGjzJC3dtzFEBGZbSxZJF9A', // Streamflow
  'strmRqUCoQUgGUan5YaTrFDyqzFbdLE4M7E4eEwDRup',  // Streamflow v2
  'Lock7kBijuQRtJgFKvHCZ7NQCX8sVN5MqoCBHRwX5No',  // Generic locker
  '7sDSHDbmqpZh3qiXCFSBnYGEKHuwnGT5Cxi1XHVkrSVT', // Raydium LP Locker
];

// Known vesting program IDs
const KNOWN_VESTING = [
  'strmRqUCoQUgGUan5YaTrFDyqzFbdLE4M7E4eEwDRup', // Streamflow
  'BF6SRV81PYGqBRLFbPgCLQdmH5AcjnDEcFXCZZX8hTVE', // Bonfida vesting
  'CChTq6PthWU82YZkbveA3WDf7s97BWhBK4Vx9bmsT743', // Grape vesting
];

async function checkMintAndFreeze(mintAddress) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const info = await connection.getParsedAccountInfo(mintPubkey);
    const parsed = info?.value?.data?.parsed;
    if (!parsed) return { mintRenounced: null, freezeRenounced: null };
    return {
      mintRenounced:   !parsed.info?.mintAuthority,
      freezeRenounced: !parsed.info?.freezeAuthority,
    };
  } catch {
    return { mintRenounced: null, freezeRenounced: null };
  }
}

async function checkLpLocked(mintAddress) {
  try {
    // Get all token accounts holding this mint
    const mintPubkey = new PublicKey(mintAddress);
    const accounts = await connection.getTokenLargestAccounts(mintPubkey);
    if (!accounts.value?.length) return { locked: false, confidence: 'low' };

    // Check if any large holders are known locker programs
    for (const acc of accounts.value.slice(0, 5)) {
      const accInfo = await connection.getParsedAccountInfo(new PublicKey(acc.address));
      const owner = accInfo?.value?.data?.parsed?.info?.owner;
      if (owner && KNOWN_LOCKERS.some(l => l === owner)) {
        return { locked: true, lockerProgram: owner, confidence: 'high' };
      }
    }

    // Also check via DexScreener for LP info
    const dexRes = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
      { timeout: 6000 }
    );
    const pair = dexRes.data?.pairs?.[0];
    if (pair?.liquidity?.usd > 0) {
      // Has liquidity but we couldn't confirm locker — medium confidence
      return { locked: null, confidence: 'medium', note: 'Liquidity present but locker not detected on-chain' };
    }

    return { locked: false, confidence: 'low' };
  } catch {
    return { locked: null, confidence: 'low', note: 'Could not verify' };
  }
}

async function checkDevVesting(creatorWallet) {
  if (!creatorWallet) return { vesting: null, confidence: 'low', note: 'Creator wallet unknown' };
  try {
    const creatorPubkey = new PublicKey(creatorWallet);
    // Check if creator is enrolled in any known vesting program
    for (const program of KNOWN_VESTING) {
      try {
        const programPubkey = new PublicKey(program);
        const accounts = await connection.getParsedProgramAccounts(programPubkey, {
          filters: [{ memcmp: { offset: 8, bytes: creatorWallet } }],
          commitment: 'confirmed',
        });
        if (accounts.length > 0) {
          return { vesting: true, program, confidence: 'high' };
        }
      } catch {}
    }
    return { vesting: null, confidence: 'medium', note: 'No vesting schedule found in known programs' };
  } catch {
    return { vesting: null, confidence: 'low', note: 'Could not verify' };
  }
}

// GET /api/verify/:mint
router.get('/:mint', async (req, res) => {
  const { mint } = req.params;

  try {
    new PublicKey(mint); // validate address
  } catch {
    return res.status(400).json({ error: 'Invalid mint address' });
  }

  try {
    // 1. Check our Noxis launch database first
    const noxisRecord = getLaunch(mint);

    // 2. Always check on-chain for mint/freeze (100% accurate)
    const { mintRenounced, freezeRenounced } = await checkMintAndFreeze(mint);

    // 3. Check LP lock on-chain (~80% accurate)
    const lpCheck = await checkLpLocked(mint);

    // 4. Check dev vesting if we know the creator (~65% accurate)
    const creatorWallet = noxisRecord?.creatorWallet || null;
    const vestingCheck = await checkDevVesting(creatorWallet);

    const isNoxisLaunch = !!noxisRecord;

    res.json({
      mint,
      isNoxisLaunch,
      noxisRecord: noxisRecord || null,
      checks: {
        mintRenounced: {
          result: mintRenounced,
          confidence: 'high',
          label: 'Mint Authority',
          note: mintRenounced === true
            ? 'Renounced — no new tokens can ever be minted'
            : mintRenounced === false
            ? 'NOT renounced — dev can mint unlimited tokens'
            : 'Could not verify',
        },
        freezeRenounced: {
          result: freezeRenounced,
          confidence: 'high',
          label: 'Freeze Authority',
          note: freezeRenounced === true
            ? 'Renounced — no wallet can ever be frozen'
            : freezeRenounced === false
            ? 'NOT renounced — dev can freeze holder wallets'
            : 'Could not verify',
        },
        lpLocked: {
          result: lpCheck.locked,
          confidence: lpCheck.confidence,
          label: 'LP Lock',
          note: lpCheck.note || (lpCheck.locked ? 'LP tokens held by a known locker program' : 'No LP lock detected'),
          ...(noxisRecord?.features?.lpLocked && { noxisVerified: true, lockDuration: noxisRecord.features.lpLockDuration }),
        },
        devVesting: {
          result: vestingCheck.vesting,
          confidence: vestingCheck.confidence,
          label: 'Dev Vesting',
          note: vestingCheck.note || (vestingCheck.vesting ? 'Active vesting schedule found' : 'No vesting detected'),
          ...(noxisRecord?.features?.devVesting && { noxisVerified: true, vestingMonths: noxisRecord.features.vestingMonths }),
        },
      },
    });
  } catch (err) {
    console.error('[verify]', err.message);
    res.status(500).json({ error: 'Verification failed', detail: err.message });
  }
});

module.exports = router;
