# Rz Ai Data Analyst

A standalone AI-powered chat agent that analyzes CSV data — checks data quality, spots trends and anomalies, and gives business-ready insights and recommendations.

## What's in this project
- `index.html` — the app (chat UI, CSV upload/paste, in-browser data profiling)
- `api/chat.js` — a serverless function that securely calls the Google Gemini API (keeps your API key private, never exposed in the browser)
- `package.json` — project config

## Deploy it (free, ~5 minutes)

### 1. Get a free Gemini API key
Go to https://aistudio.google.com/apikey, sign in with a Google account, and click **Create API key**. No credit card or billing required — this uses Gemini's free tier.

### 2. Create a Vercel account
Go to https://vercel.com and sign up with GitHub — free tier is enough.

### 3. Deploy this repo
1. In Vercel, click **Add New → Project**
2. Select this repository
3. Click **Deploy** — no configuration needed

### 4. Add your API key
In your Vercel project: **Settings → Environment Variables**
- Name: `GEMINI_API_KEY`
- Value: (paste your key from step 1)
- Save, then go to **Deployments** → redeploy the latest one so it picks up the key

### 5. You're live
Vercel gives you a URL like `https://rz-ai-data-analyst.vercel.app` — that's your shareable link. Anyone who opens it can chat with Rz and upload or paste CSV data for instant analysis.

## Notes
- The API key never reaches the browser — it stays server-side in `api/chat.js`.
- Gemini's free tier has rate limits (requests per minute/day) — fine for personal or light use, may need upgrading for heavy traffic.
- To use a custom domain instead of the `.vercel.app` one, add it under **Settings → Domains** in Vercel.
