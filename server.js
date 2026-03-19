require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const tokenRoutes = require('./routes/token');
const walletRoutes = require('./routes/wallet');
const vestingRoutes = require('./routes/vesting');
const boostRoutes = require('./routes/boost');

const app = express();
const PORT = process.env.PORT || 8080;

// ─── Security ────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'https://noxis-phi.vercel.app',
    'https://noxis.fun',
    'https://www.noxis.fun',
    /\.vercel\.app$/,
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  message: { error: 'Too many requests — slow down.' },
});
app.use('/api/', limiter);

// ─── Parsing ─────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/token', tokenRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/vesting', vestingRoutes);
app.use('/api/boost', boostRoutes);

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ─── Error handler ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

app.listen(PORT, () => {
  console.log(`\n🖤 Noxis backend running on http://localhost:${PORT}`);
  console.log(`   Network: ${process.env.SOLANA_NETWORK || 'devnet'}`);
  console.log(`   CORS:    ${process.env.FRONTEND_URL || 'http://localhost:5173'}\n`);
});

module.exports = app;
