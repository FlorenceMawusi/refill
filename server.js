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
const nodemailer = require('nodemailer');
const cron = require('node-cron');

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

// ── REFILL REMINDERS ──
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addedTotal(row) {
  if (row.bottleAmount !== undefined || row.bottleCount !== undefined) {
    return (parseFloat(row.bottleAmount) || 0) * Math.max(parseFloat(row.bottleCount) || 1, 1);
  }
  return (row.bottles || []).reduce((s, v) => s + (parseFloat(v) || 0), 0);
}

async function sendRefillReminders() {
  const target = new Date();
  target.setDate(target.getDate() + 2);
  const targetKey = toDateKey(target);

  const { rows } = await pool.query(
    `SELECT u.email, u.name, ts.state FROM users u JOIN tracker_state ts ON ts.user_id = u.id WHERE u.email IS NOT NULL`
  );

  for (const { email, name, state } of rows) {
    if (!state?.apptDates || !state?.meds?.length) continue;

    const weekKey = Object.keys(state.apptDates).find(k => state.apptDates[k] === targetKey);
    if (!weekKey) continue;

    const wdata = state.weeks?.[weekKey];
    if (!wdata?.length) continue;

    const dropsPerMl = state.dropsPerMl || 20;
    const cycleStart = state.cycleStarts?.[weekKey] || weekKey;
    const cycleDays = Math.max(1, Math.round((new Date(targetKey) - new Date(cycleStart)) / 86400000));

    const results = state.meds.map(med => {
      const row = wdata.find(r => r.medId === med.id);
      if (!row) return null;
      const isDrops = med.type === 'drops';
      const dailyDose = isDrops ? (med.dropsPerDay / dropsPerMl) : (med.dailyDose || 1);
      const neededN = dailyDose * cycleDays;
      const carried = parseFloat(row.carriedIn) || 0;
      const added = addedTotal(row);
      const remaining = row.remaining !== '' && row.remaining != null
        ? parseFloat(row.remaining)
        : Math.max(0, carried + added - dailyDose * cycleDays);
      const unit = isDrops ? 'ml' : (med.unit || 'pills');
      if (remaining < neededN * 0.5) return { name: med.name, status: 'critical', need: Math.ceil(neededN - remaining), unit };
      if (remaining < neededN)       return { name: med.name, status: 'low',      need: Math.ceil(neededN - remaining), unit };
      return { name: med.name, status: 'ok', unit };
    }).filter(Boolean);

    if (results.every(r => r.status === 'ok')) continue;

    const apptDisplay = target.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const textLines = results.map(r =>
      r.status === 'critical' ? `⛔ ${r.name} — need ${r.need} more ${r.unit}`
      : r.status === 'low'    ? `⚠️  ${r.name} — order ~${r.need} more ${r.unit}`
      :                         `✓  ${r.name} — good`
    ).join('\n');

    const htmlRows = results.map(r => {
      const color = r.status === 'critical' ? '#f87171' : r.status === 'low' ? '#fbbf24' : '#4ade80';
      const icon  = r.status === 'critical' ? '⛔' : r.status === 'low' ? '⚠️' : '✓';
      const note  = r.status === 'ok' ? 'Good' : `Need ${r.need} more ${r.unit}`;
      return `<div style="padding:0.75rem;margin-bottom:0.5rem;border-left:3px solid ${color};background:#1e2029;">
        <span style="color:${color};">${icon} ${r.name}</span>
        <span style="color:#6b7080;float:right;font-size:0.85rem;">${note}</span>
      </div>`;
    }).join('');

    try {
      await transporter.sendMail({
        from: `"Refill" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: `Refill reminder — appointment in 2 days (${apptDisplay})`,
        text: `Hi ${name || 'there'},\n\nYour next appointment is on ${apptDisplay}.\n\n${textLines}\n\nOpen Refill → https://refill-production.up.railway.app\n`,
        html: `<div style="font-family:monospace;max-width:480px;margin:0 auto;background:#0e0f14;color:#e8eaf0;padding:2rem;border-radius:12px;">
          <h1 style="font-family:Georgia,serif;font-style:italic;color:#2dd4bf;margin:0 0 0.2rem;">Refill</h1>
          <p style="color:#6b7080;font-size:0.75rem;margin:0 0 1.5rem;">Appointment in 2 days · ${apptDisplay}</p>
          ${htmlRows}
          <p style="margin-top:1.5rem;font-size:0.8rem;">
            <a href="https://refill-production.up.railway.app" style="color:#2dd4bf;text-decoration:none;">Open Refill →</a>
          </p>
        </div>`,
      });
      console.log(`Refill reminder sent to ${email}`);
    } catch (err) {
      console.error(`Failed to send reminder to ${email}:`, err.message);
    }
  }
}

// Run daily at 8am UTC
cron.schedule('0 8 * * *', () => {
  sendRefillReminders().catch(err => console.error('Reminder cron error:', err));
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
