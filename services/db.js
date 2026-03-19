const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'launches.json');

// Ensure data directory exists
function ensureDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readDB() {
  ensureDir();
  if (!fs.existsSync(DB_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeDB(data) {
  ensureDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Log a new launch — called after successful token creation
function logLaunch({ mintAddress, creatorWallet, name, symbol, features }) {
  try {
    const db = readDB();
    db[mintAddress] = {
      mintAddress,
      creatorWallet,
      name,
      symbol,
      launchedAt: new Date().toISOString(),
      features: {
        mintRenounced:    features.mintRenounced    ?? true,
        freezeRenounced:  features.freezeRenounced  ?? true,
        lpLocked:         features.lpLocked         ?? false,
        devVesting:       features.devVesting        ?? false,
        lpLockDuration:   features.lpLockDuration   || null,
        vestingMonths:    features.vestingMonths     || null,
      },
    };
    writeDB(db);
    console.log('[db] Logged launch:', mintAddress);
  } catch (e) {
    // Never crash the launch if logging fails
    console.warn('[db] Failed to log launch:', e.message);
  }
}

// Look up a mint in our database
function getLaunch(mintAddress) {
  const db = readDB();
  return db[mintAddress] || null;
}

// Get all launches
function getAllLaunches() {
  return readDB();
}

module.exports = { logLaunch, getLaunch, getAllLaunches };
