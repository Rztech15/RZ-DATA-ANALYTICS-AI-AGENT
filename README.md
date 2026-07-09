# RZ Data Analyst — AI Agent

<p align="center">
  <img src="logo.png" alt="RZ Data Analyst logo" width="220" />
</p>

<p align="center">
  An AI-powered data analyst you can chat with — upload a spreadsheet, get instant charts, and ask questions about your data in plain English.
</p>

<p align="center">
  <a href="https://rz-data-analytics-ai-agent.vercel.app"><strong>🔗 Live Demo</strong></a>
</p>

---

## Overview

RZ Data Analyst is a lightweight web app that lets anyone — no coding or Excel expertise required — upload a CSV or Excel file and immediately get:

- A data quality read (missing values, duplicates, column types)
- Auto-generated charts based on what's actually in the data
- A conversational AI analyst you can ask follow-up questions
- One-click structured reports (executive summary, insights, recommendations)

It's built as a single-page web app with user accounts, so each person's data and chat history stays private to their own login.

## Features

- 🔐 **User accounts** — email/password sign-up and login, powered by Supabase Auth
- 📂 **File upload** — supports `.csv`, `.xlsx`, and `.xls`, plus a paste-in option for quick CSV testing
- 📊 **Auto-generated charts** — pie, bar, line, and distribution charts created automatically from your data's actual columns
- 🤖 **AI chat** — ask anything about your dataset (SQL help, Excel formulas, trend explanations) powered by Google Gemini
- 📋 **One-click reports** — generates an Executive Summary, Top Insights, Business Recommendations, Data Quality Report, and Suggested Visualizations
- ☁️ **Cloud-saved sessions** — your last dataset reloads automatically next time you log in
- 📱 **Installable as an app** — works as a Progressive Web App (PWA), can be added to a phone's home screen
- 💬 **WhatsApp-based Pro upgrade** — simple manual upgrade flow for unlimited daily messages

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML / CSS / JavaScript (no build step) |
| Charts | [Chart.js](https://www.chartjs.org/) |
| CSV parsing | [PapaParse](https://www.papaparse.com/) |
| Excel parsing | [SheetJS (xlsx)](https://sheetjs.com/) |
| Auth & Database | [Supabase](https://supabase.com/) (Postgres + Auth) |
| AI | [Google Gemini API](https://ai.google.dev/) |
| Hosting | [Vercel](https://vercel.com/) (static hosting + serverless functions) |

## Screenshots

*(Add your own screenshots here — landing page, chat with charts, and a sample report make good examples.)*

## Installation Guide

Want to run your own copy? Here's the full setup:

### 1. Clone or download this repo
```bash
git clone https://github.com/Rztech15/RZ-DATA-ANALYTICS-AI-AGENT.git
```

### 2. Get a free Gemini API key
Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and create a key (no credit card required).

### 3. Set up Supabase
- Create a project at [supabase.com](https://supabase.com)
- Run the SQL below in the **SQL Editor** to create the required tables:

```sql
create table user_datasets (
  user_id uuid references auth.users(id) on delete cascade primary key,
  filename text,
  data jsonb,
  updated_at timestamp with time zone default now()
);
alter table user_datasets enable row level security;
create policy "Users can view own data" on user_datasets for select using (auth.uid() = user_id);
create policy "Users can insert own data" on user_datasets for insert with check (auth.uid() = user_id);
create policy "Users can update own data" on user_datasets for update using (auth.uid() = user_id);

create table profiles (
  user_id uuid references auth.users(id) on delete cascade primary key,
  is_pro boolean default false,
  message_count int default 0,
  message_date date default current_date
);
alter table profiles enable row level security;
create policy "Users can view own profile" on profiles for select using (auth.uid() = user_id);
create policy "Users can insert own profile" on profiles for insert with check (auth.uid() = user_id);
create policy "Users can update own profile" on profiles for update using (auth.uid() = user_id);
```

- Copy your **Project URL** and **anon/publishable key** from Project Settings → API
- Paste them into `index.html` at the top of the `<script>` section:
```javascript
const SUPABASE_URL = "your-project-url";
const SUPABASE_ANON_KEY = "your-anon-key";
```

### 4. Deploy to Vercel
- Push this repo to your own GitHub account
- Import it into [Vercel](https://vercel.com)
- Add an environment variable: `GEMINI_API_KEY` = your key from step 2
- Deploy

### 5. Done
Your live link will look like `https://your-project-name.vercel.app`.

## Folder Structure

```
rz-data-analyst/
├── index.html          # Entire frontend (UI, auth, charts, chat logic)
├── logo.png            # App logo
├── manifest.json       # PWA config
├── sw.js                # Service worker (PWA installability)
├── package.json         # Project metadata
├── api/
│   └── chat.js          # Serverless function — proxies chat requests to Gemini
└── README.md
```

## Roadmap

Planned improvements, roughly in priority order:

- [ ] Landing/marketing page separate from the app (hero section, sample dataset demo)
- [ ] Drag-and-drop file upload with progress indicator and file preview
- [ ] Correlation heatmaps and richer distribution charts
- [ ] PDF and Excel export of generated reports
- [ ] Chart export as PNG
- [ ] Suggested prompt chips and conversation history/rename/clear
- [ ] Loading skeletons and empty-state illustrations
- [ ] Automatic Pro upgrade via a Pakistan-compatible payment gateway (pending business registration)

## License

This project is currently private/personal. Add a license here if you plan to open-source it.
