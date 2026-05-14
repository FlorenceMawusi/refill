require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { Pool } = require('pg');
const multer = require('multer');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const sharp = require('sharp');
const heicConvert = require('heic-convert');

const app = express();
app.set('trust proxy', 1);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ── DATABASE ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      google_id  VARCHAR(255) UNIQUE NOT NULL,
      email      VARCHAR(255),
      name       VARCHAR(255),
      avatar     VARCHAR(500),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tracker_state (
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
      state      JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Database ready');
}

// ── SESSION ──
app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-CHANGE-IN-PRODUCTION',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: true,
    sameSite: 'lax',
    httpOnly: true,
  },
}));

// ── PASSPORT / GOOGLE OAUTH ──
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: `${process.env.BASE_URL}/auth/google/callback`,
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (google_id, email, name, avatar)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (google_id) DO UPDATE
         SET email=$2, name=$3, avatar=$4
       RETURNING *`,
      [
        profile.id,
        profile.emails?.[0]?.value || null,
        profile.displayName || null,
        profile.photos?.[0]?.value || null,
      ]
    );
    done(null, rows[0]);
  } catch (err) {
    done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    done(null, rows[0] || null);
  } catch (err) {
    done(err);
  }
});

app.use(passport.initialize());
app.use(passport.session());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
};

// ── AUTH ROUTES ──
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => res.redirect('/')
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// ── API: CURRENT USER ──
app.get('/api/me', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ user: null });
  res.json({
    user: {
      name: req.user.name,
      email: req.user.email,
      avatar: req.user.avatar,
    },
  });
});

// ── API: TRACKER STATE ──
app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT state FROM tracker_state WHERE user_id = $1',
      [req.user.id]
    );
    res.json(rows[0]?.state || {});
  } catch (err) {
    console.error('GET /api/state error:', err);
    res.status(500).json({ error: 'Failed to load state' });
  }
});

app.post('/api/state', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO tracker_state (user_id, state, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET state = $2, updated_at = NOW()`,
      [req.user.id, req.body]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/state error:', err);
    res.status(500).json({ error: 'Failed to save state' });
  }
});

// ── API: PARSE PRESCRIPTION ──
app.post('/api/parse', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const originalName = (req.file.originalname || '').toLowerCase();
  const isPdf = req.file.mimetype === 'application/pdf'
    || (req.file.mimetype === 'application/octet-stream' && originalName.endsWith('.pdf'))
    || originalName.endsWith('.pdf');

  const supportedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const needsConversion = !isPdf && !supportedImageTypes.includes(req.file.mimetype);

  let fileBuffer = req.file.buffer;
  let finalMimeType = req.file.mimetype;

  if (needsConversion) {
    const isHeic = req.file.mimetype === 'image/heic' || req.file.mimetype === 'image/heif'
      || originalName.endsWith('.heic') || originalName.endsWith('.heif');
    try {
      if (isHeic) {
        fileBuffer = await heicConvert({ buffer: req.file.buffer, format: 'JPEG', quality: 0.9 });
      } else {
        fileBuffer = await sharp(req.file.buffer).jpeg({ quality: 90 }).toBuffer();
      }
      finalMimeType = 'image/jpeg';
    } catch (err) {
      console.error('Conversion error:', err.message);
      return res.status(422).json({ error: 'Unsupported file format. Please upload a PDF, JPEG, PNG, or HEIC.' });
    }
  }

  const base64 = fileBuffer.toString('base64');

  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image',    source: { type: 'base64', media_type: finalMimeType, data: base64 } };

  const prompt = `You are reading a prescription or medication schedule document. Extract ALL medications listed.

For each medication return a JSON array. Each item must have:
- name: medication name (string)
- dose: numeric dose amount (number or null)
- unit: unit like mg, mcg, ml, IU, etc (string)
- type: "drops" if it is a liquid taken as drops, otherwise "pill"
- dailyDose: how many pills/capsules per day (number, default 1)
- dropsPerDay: if type is drops, total drops per day (number, else 0)
- totalSupply: total pills or ml in the package if mentioned (number or null)

Return ONLY a valid JSON array, no explanation, no markdown fences.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [contentBlock, { type: 'text', text: prompt }],
        }],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const text = data.content?.map(b => b.text || '').join('').trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const meds = JSON.parse(clean);

    if (!Array.isArray(meds) || meds.length === 0) {
      return res.status(422).json({ error: 'No medications found in the document' });
    }

    res.json(meds);
  } catch (err) {
    console.error('POST /api/parse error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── START ──
initDb()
  .then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Rx Tracker running → http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
