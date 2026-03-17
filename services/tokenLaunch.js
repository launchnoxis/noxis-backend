/**
 * tokenLaunch.js
 * Builds the transaction that the frontend wallet will sign & send.
 * The server NEVER holds private keys — it only builds unsigned txs.
 *
 * Flow:
 *  1. Upload metadata to IPFS (Pinata)
 *  2. Build a Solana transaction:
 *       a. Create SPL mint account
 *       b. Create token metadata (Metaplex)
 *       c. Call pump.fun `create` instruction
 *       d. Optionally: dev buy (initial liquidity from launcher wallet)
 *  3. Return serialized transaction (base64) to frontend for wallet signing
 */

const {
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Keypair,
  TransactionInstruction,
} = require('@solana/web3.js');

const {
  TOKEN_PROGRAM_ID,
  MintLayout,
  createInitializeMintInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} = require('@solana/spl-token');

const {
  getConnection,
  getRecentBlockhash,
  getBondingCurvePDA,
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_GLOBAL,
  PUMP_FUN_FEE_RECIPIENT,
} = require('./solana');

const metadataService = require('./metadata');

// Metaplex Token Metadata program
const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
);

// pump.fun event authority
const PUMP_EVENT_AUTHORITY = new PublicKey(
  'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'
);

/**
 * Get Metaplex metadata PDA for a mint
 */
async function getMetadataPDA(mintPublicKey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mintPublicKey.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  );
  return pda;
}

/**
 * Encode the pump.fun `create` instruction data
 * Discriminator: [24, 30, 200, 40, 5, 28, 7, 119] (anchor IDL)
 */
function encodePumpCreateInstruction(name, symbol, metadataUri) {
  const discriminator = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);

  const nameBytes = Buffer.from(name, 'utf8');
  const nameLen = Buffer.alloc(4);
  nameLen.writeUInt32LE(nameBytes.length);

  const symbolBytes = Buffer.from(symbol, 'utf8');
  const symbolLen = Buffer.alloc(4);
  symbolLen.writeUInt32LE(symbolBytes.length);

  const uriBytes = Buffer.from(metadataUri, 'utf8');
  const uriLen = Buffer.alloc(4);
  uriLen.writeUInt32LE(uriBytes.length);

  return Buffer.concat([
    discriminator,
    nameLen,
    nameBytes,
    symbolLen,
    symbolBytes,
    uriLen,
    uriBytes,
  ]);
}

/**
 * Encode the pump.fun `buy` instruction data
 * Discriminator: [102, 6, 61, 18, 1, 218, 235, 234]
 */
function encodePumpBuyInstruction(tokenAmountBN, maxSolCostLamports) {
  const discriminator = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
  const amountBuf = Buffer.alloc(8);
  // Write as little-endian u64 (JS BigInt)
  const amount = BigInt(tokenAmountBN);
  amountBuf.writeBigUInt64LE(amount);
  const maxCostBuf = Buffer.alloc(8);
  maxCostBuf.writeBigUInt64LE(BigInt(maxSolCostLamports));
  return Buffer.concat([discriminator, amountBuf, maxCostBuf]);
}

/**
 * Build an unsigned launch transaction
 *
 * @param {object} params
 * @param {string} params.creatorWallet   - base58 public key of launcher
 * @param {string} params.name            - token name
 * @param {string} params.symbol          - token symbol (ticker)
 * @param {string} params.description     - token description
 * @param {string} params.imageUrl        - image URL (will be uploaded to IPFS)
 * @param {string} params.twitter         - optional
 * @param {string} params.telegram        - optional
 * @param {string} params.website         - optional
 * @param {number} params.devBuySol       - SOL amount for initial dev buy (0 = skip)
 * @param {number} params.slippageBps     - slippage in basis points (e.g. 500 = 5%)
 *
 * @returns {{ transaction: string, mintAddress: string, metadataUri: string }}
 */
async function buildLaunchTransaction(params) {
  const {
    creatorWallet,
    name,
    symbol,
    description,
    imageUrl,
    twitter,
    telegram,
    website,
    devBuySol = 0,
    slippageBps = 500,
  } = params;

  const connection = getConnection();
  const creator = new PublicKey(creatorWallet);

  // ── 1. Generate a new random mint keypair ─────────────────────────────────
  // The mint keypair is ephemeral — frontend must also sign with it.
  // We return its public key; the FULL keypair bytes are returned so
  // the frontend can add it as a partial signer.
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  // ── 2. Upload metadata to IPFS ────────────────────────────────────────────
  const metadataUri = await metadataService.uploadMetadata({
    name,
    symbol,
    description,
    imageUrl,
    twitter,
    telegram,
    website,
  });

  // ── 3. Derive PDAs ────────────────────────────────────────────────────────
  const bondingCurvePDA = await getBondingCurvePDA(mint);
  const metadataPDA = await getMetadataPDA(mint);

  const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
    [bondingCurvePDA.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bmd') // ATA program
  );

  const creatorATA = await getAssociatedTokenAddress(mint, creator);

  // ── 4. Build instructions ─────────────────────────────────────────────────
  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: creator });

  // 4a. Create mint account
  const mintRent = await connection.getMinimumBalanceForRentExemption(
    MintLayout.span
  );
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: creator,
      newAccountPubkey: mint,
      lamports: mintRent,
      space: MintLayout.span,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      mint,
      6, // decimals
      creator,
      null // freeze authority — will be renounced
    )
  );

  // 4b. pump.fun `create` instruction
  const pumpCreateData = encodePumpCreateInstruction(name, symbol, metadataUri);
  tx.add(
    new TransactionInstruction({
      programId: PUMP_FUN_PROGRAM_ID,
      keys: [
        { pubkey: mint, isSigner: true, isWritable: true },
        { pubkey: new PublicKey('TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM'), isSigner: false, isWritable: false }, // mpl token metadata
        { pubkey: metadataPDA, isSigner: false, isWritable: true },
        { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: creator, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bmd'), isSigner: false, isWritable: false },
        { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: pumpCreateData,
    })
  );

  // 4c. Optional dev buy (initial liquidity)
  if (devBuySol > 0) {
    const solLamports = Math.floor(devBuySol * LAMPORTS_PER_SOL);
    // Estimate tokens: pump.fun initial price ~0.000000028 SOL per token
    // Use conservative estimate and apply slippage
    const estimatedTokens = BigInt(Math.floor((devBuySol / 0.000000028) * 0.9));
    const maxSolCost = BigInt(
      Math.floor(solLamports * (1 + slippageBps / 10000))
    );

    // Create ATA for creator to receive tokens
    tx.add(
      createAssociatedTokenAccountInstruction(creator, creatorATA, creator, mint)
    );

    const buyData = encodePumpBuyInstruction(estimatedTokens, maxSolCost);
    tx.add(
      new TransactionInstruction({
        programId: PUMP_FUN_PROGRAM_ID,
        keys: [
          { pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false },
          { pubkey: PUMP_FUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
          { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
          { pubkey: creatorATA, isSigner: false, isWritable: true },
          { pubkey: creator, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
          { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
          { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: buyData,
      })
    );
  }

  // ── 5. Partial-sign with mint keypair (server side) ───────────────────────
  tx.partialSign(mintKeypair);

  // ── 6. Serialize (without requiring all signatures) ───────────────────────
  const serialized = tx.serialize({ requireAllSignatures: false });

  return {
    transaction: serialized.toString('base64'),
    mintAddress: mint.toBase58(),
    mintKeypairBytes: Array.from(mintKeypair.secretKey), // frontend needs this to co-sign
    metadataUri,
    lastValidBlockHeight,
  };
}

module.exports = { buildLaunchTransaction };
