# Refill

**Never run out of medication before your next appointment.**

Refill is a weekly medication tracking app built for people on structured medical programs — the kind where you pick up multiple prescriptions at once and need to know, before your next office visit, whether you'll have enough of everything.

→ **[refill-production.up.railway.app](https://refill-production.up.railway.app)**

---

## What it does

- **Upload your prescription** — drop in a PDF or photo (including iPhone HEIC) and Claude reads it and fills in all your medications automatically
- **Track week by week** — each cycle runs from your program start date, not arbitrary calendar weeks
- **Carried forward automatically** — remaining supply rolls into the next week when you close a week
- **Forecast before your appointment** — see at a glance which medications you're short on and by how much
- **Handles pills and liquid drops** — configurable drops-per-ml for liquid medications
- **Quick check on the landing page** — anyone can estimate their supply without signing in

## Stack

| Layer | Tech |
|---|---|
| Backend | Node.js + Express |
| Auth | Google OAuth 2.0 (Passport.js) |
| Database | PostgreSQL (Railway) |
| Sessions | connect-pg-simple |
| AI parsing | Claude claude-sonnet-4-6 via Anthropic API |
| Image processing | heic-convert + sharp |
| Hosting | Railway |
| Frontend | Vanilla JS, no framework |

## How it works

1. Sign in with Google
2. Set your program start date (the day your first prescription began)
3. Upload your prescription PDF or photo — Claude extracts every medication, dose, and supply amount
4. Each week: enter how much you're carrying in and how many bottles/packs you received
5. The app calculates your estimated remaining supply by your next appointment date
6. Close the week to carry remaining amounts forward automatically

## Running locally

```bash
# Clone and install
git clone https://github.com/FlorenceMawusi/refill.git
cd refill
npm install

# Set up environment variables (see .env.example)
cp .env.example .env
# Fill in: DATABASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
#          SESSION_SECRET, ANTHROPIC_API_KEY, BASE_URL

# Start
npm run dev
```

You'll need a PostgreSQL database and a Google OAuth app with `http://localhost:3000/auth/google/callback` as an authorized redirect URI.

---

Built by [Florence Ofori](https://github.com/FlorenceMawusi)
