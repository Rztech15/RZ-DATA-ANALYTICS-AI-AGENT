<div align="center">

<img src="./hero-banner.png" width="850" alt="RZ Data Analytics AI Agent — transform data into decisions" />

# 📊 RZ Data Analytics AI Agent

**Upload a spreadsheet. Get dashboards, data-quality checks, and a real analyst in chat — free.**

[![Made with Gemini](https://img.shields.io/badge/AI-Gemini_2.5-4285F4?style=flat-square&logo=google&logoColor=white)](https://aistudio.google.com)
[![Deployed on Vercel](https://img.shields.io/badge/Deployed-Vercel-000000?style=flat-square&logo=vercel&logoColor=white)](https://vercel.com)
[![Backed by Supabase](https://img.shields.io/badge/Backend-Supabase-3ECF8E?style=flat-square&logo=supabase&logoColor=white)](https://supabase.com)
[![PWA Ready](https://img.shields.io/badge/PWA-Installable-5A0FC8?style=flat-square&logo=pwa&logoColor=white)]()
[![License](https://img.shields.io/badge/License-MIT-lightgrey?style=flat-square)]()

[**🚀 Live Demo**](#) · [**✨ Features**](#-features) · [**⚡ Quick Start**](#-quick-start) · [**🛠️ Tech Stack**](#️-tech-stack)

</div>

---

## What is RZ Data Analytics AI Agent?

RZ Data Analytics AI Agent is a single-page AI data analyst that runs entirely in the browser. Drop in a **CSV, Excel, or JSON** file and it instantly profiles your data, flags quality issues, charts what matters, and lets you *talk* to your dataset — ask questions, request a full report, generate SQL, or get a presentation script, all in plain English.

No install, no setup, no data-science background required.

## ✨ Features

| | |
|---|---|
| 📁 **Any file, any source** | CSV, XLSX, JSON, pasted data, or a direct URL import |
| 🤖 **Real conversation** | Ask questions about your data like you would a colleague — RZ Data Analytics AI remembers the conversation |
| 📈 **Instant dashboards** | Auto-generated charts, correlations, and a data-quality score the moment a file loads |
| 🔍 **Anomaly detection** | Duplicate records, missing values, outliers (IQR method), and impossible values flagged automatically |
| 🧮 **Excel & SQL tools** | Dedupe, fill missing values, generate SQL queries, export cleaned CSVs |
| 📋 **One-click deliverables** | Full analysis reports, PDF export, assignment mode, presentation scripts, Power BI suggestions |
| 🎨 **Make it yours** | Dark/light theme, 5 accent colors, and adjustable response style (concise → detailed) |
| 🔒 **Privacy-first** | Export or permanently delete all your data at any time, right from Settings |
| 📱 **Installable PWA** | Add to your home screen and use it like a native app |
| 🆓 **Free tier included** | 5 messages/day free, unlimited on Pro |

## ⚡ Quick Start

### 1. Clone & configure

```bash
git clone https://github.com/<your-username>/rz-ai-data-analyst.git
cd rz-ai-data-analyst
```

### 2. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Run the SQL in [`supabase_rate_limit.sql`](./supabase_rate_limit.sql) in the SQL editor — this sets up atomic, server-side rate limiting.
3. Grab your **Project URL**, **anon key**, and **service_role key** from Project Settings → API.

### 3. Get a free Gemini API key

Grab one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — no credit card needed.

### 4. Deploy to Vercel

```bash
vercel deploy
```

Add these environment variables in your Vercel project settings:

| Variable | Where it's used | Keep secret? |
|---|---|---|
| `GEMINI_API_KEY` | `/api/chat` → calls Gemini | ✅ server-only |
| `SUPABASE_URL` | `/api/chat` → verifies sessions & rate limits | can be public |
| `SUPABASE_SERVICE_ROLE_KEY` | `/api/chat` → bypasses RLS to enforce limits | ✅ **never expose client-side** |

That's it — the frontend (`index.html`) needs no build step; it's a single static file.

## 🛠️ Tech Stack

- **Frontend** — Vanilla JS, no framework, no build step (one HTML file)
- **AI** — [Google Gemini](https://ai.google.dev/) (`gemini-2.5-flash-lite`)
- **Backend** — Vercel Serverless Functions
- **Database & Auth** — [Supabase](https://supabase.com) (Postgres + Row Level Security)
- **Parsing** — PapaParse (CSV), SheetJS (Excel)

## 🔐 Security

- Every AI request is authenticated against a real Supabase session — not just trusted from the client.
- Daily free-tier limits are enforced **atomically in Postgres**, closing the race condition that plagues naive check-then-write rate limiting.
- Dataset content sent to the AI is sanitized and explicitly marked as untrusted data, not instructions — mitigating prompt injection from malicious spreadsheet content.
- Users can export or permanently delete all their stored data at any time.

## 🔭 Vision

Concept renders for where the product is headed — a full multi-page dashboard (Data Explorer, standalone AI Tools, Saved Analyses, Integrations). **These are early concept art, not the current live UI** — today's RZ Data Analytics AI Agent is the single-page chat app described above. Included here to show direction, not to overstate what's shipped.

<table>
<tr>
<td width="50%"><img src="./concept-dashboard.png" alt="Concept: dashboard overview" /><br/><sub align="center">Dashboard overview</sub></td>
<td width="50%"><img src="./concept-ai-chat.png" alt="Concept: AI chat with insights panel" /><br/><sub>AI chat with insights panel</sub></td>
</tr>
<tr>
<td width="50%"><img src="./concept-smart-charts.png" alt="Concept: smart charts page" /><br/><sub>Smart charts page</sub></td>
<td width="50%"><img src="./concept-data-cleaning.png" alt="Concept: before/after data cleaning" /><br/><sub>Before/after data cleaning</sub></td>
</tr>
<tr>
<td width="50%"><img src="./concept-login.jpg" alt="Concept: login screen" /><br/><sub>Login screen</sub></td>
<td width="50%"><img src="./concept-mobile-pwa.jpg" alt="Concept: installable mobile PWA" /><br/><sub>Installable mobile PWA</sub></td>
</tr>
</table>

> Have real screenshots of the current app? Send them over and I'll swap in a proper **"Screenshots"** section above this one, showing exactly what ships today.

## 🗺️ Roadmap

- [ ] Streaming AI responses
- [ ] Multi-sheet Excel support
- [ ] Dedicated Data Explorer / Saved Analyses pages (see Vision above)
- [ ] Team workspaces
- [ ] Native chart export to PowerPoint

## 🤝 Contributing

Issues and PRs are welcome — open an issue first for anything beyond a small fix so we can talk through the approach.

## 📄 License

MIT — do what you want with it, just don't remove the credit.

---

<div align="center">

Built by **Rz Baloch** — mathematics student at CASPAM, Bahauddin Zakariya University, Multan.

<sub>Star ⭐ this repo if RZ Data Analytics AI Agent saved you from opening Excel one more time.</sub>

</div>
