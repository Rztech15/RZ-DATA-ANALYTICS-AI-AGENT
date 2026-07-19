// Vercel serverless function — calls Google's Gemini API (free tier).
//
// Required environment variables (set in Vercel project settings):
//   GEMINI_API_KEY          — https://aistudio.google.com/apikey (no credit card needed)
//   SUPABASE_URL             — same value as SUPABASE_URL in the frontend
//   SUPABASE_SERVICE_ROLE_KEY — Supabase Project Settings → API → service_role key.
//                               NEVER put this in the frontend — it bypasses RLS.
//
// Requires the SQL in supabase_rate_limit.sql to be run once against your
// Supabase project (SQL editor → paste → run). That file now also creates
// the `spent_turns` table + `charge_turn` function this version depends on.
//
// npm install @supabase/supabase-js   (if not already a project dependency)

import { createClient } from "@supabase/supabase-js";

const MODEL = "gemini-2.5-flash-lite";
const FREE_DAILY_LIMIT = 10;

// Lazily created — NOT at module load time. Building the client eagerly at
// the top level meant a missing/misspelled env var threw during module
// initialization, before the handler (and its own clearer error message)
// ever ran — Vercel just reported a bare FUNCTION_INVOCATION_FAILED with no
// useful detail. Creating it inside the handler, after the env var check
// below, turns that into a proper JSON error instead.
let _supabaseAdmin = null;
function getSupabaseAdmin() {
  if (!_supabaseAdmin) {
    _supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
  }
  return _supabaseAdmin;
}

// Two tools the model gets, both executed client-side by the frontend
// against the real dataset it already has in memory:
//  - query_dataset: exact aggregates/filters/group-by/correlation
//  - analyze_trend: time-bucketed trend + simple linear-projection forecast
// This is what lets RZ Data Analytics AI answer "total revenue by region" or "is revenue
// trending up" correctly instead of estimating from the handful of sample
// rows shown in the prompt.
const DATA_TOOLS = {
  functionDeclarations: [
    {
      name: "query_dataset",
      description:
        "Runs an exact computation (sum, average, min, max, median, count, distinct count, or correlation) over the FULL loaded dataset — not a sample. Supports optional filtering and grouping. ALWAYS use this for any specific number, total, ranking, filtered count, or statistic the user asks about. Never estimate or compute such numbers yourself from the sample rows shown in the dataset context — those are for understanding structure only.",
      parameters: {
        type: "object",
        properties: {
          metric: {
            type: "string",
            enum: ["sum", "avg", "min", "max", "median", "count", "distinct_count", "correlation"],
            description: "The computation to run.",
          },
          column: {
            type: "string",
            description: "Numeric (or target) column to aggregate. Omit only when metric is 'count'.",
          },
          column2: {
            type: "string",
            description: "Second column — required only when metric is 'correlation'.",
          },
          group_by: {
            type: "string",
            description: "Optional column to group results by, e.g. sum of revenue per region.",
          },
          filters: {
            type: "array",
            description: "Optional filters applied before aggregating.",
            items: {
              type: "object",
              properties: {
                column: { type: "string" },
                op: { type: "string", enum: ["=", "!=", ">", "<", ">=", "<=", "contains"] },
                value: { type: "string" },
              },
              required: ["column", "op", "value"],
            },
          },
          sort: {
            type: "string",
            enum: ["asc", "desc"],
            description: "Sort grouped results by the computed value — use with group_by for top/bottom-N questions.",
          },
          limit: {
            type: "integer",
            description: "Max number of groups to return, e.g. 5 for 'top 5 products'.",
          },
        },
        required: ["metric"],
      },
    },
    {
      name: "analyze_trend",
      description:
        "Analyzes how a numeric metric changes over time in the FULL dataset — buckets it into periods (day/week/month/quarter/year), computes period-over-period % change, fits a simple linear trend (direction, slope, fit quality), and can forecast future periods. Use for any question about trends, growth, seasonality, 'is X going up or down', or 'predict/forecast next month'. Never eyeball a trend from the sample rows — always use this tool. Forecasts are a simple linear projection, not a full time-series model — always caveat them as a rough estimate when relaying to the user.",
      parameters: {
        type: "object",
        properties: {
          date_column: { type: "string", description: "Column containing dates." },
          value_column: { type: "string", description: "Numeric column to analyze over time." },
          metric: {
            type: "string",
            enum: ["sum", "avg", "count"],
            description: "How to aggregate value_column within each period. Default sum.",
          },
          period: {
            type: "string",
            enum: ["day", "week", "month", "quarter", "year"],
            description: "Bucket size. Default month.",
          },
          filters: {
            type: "array",
            description: "Optional filters applied before bucketing.",
            items: {
              type: "object",
              properties: {
                column: { type: "string" },
                op: { type: "string", enum: ["=", "!=", ">", "<", ">=", "<=", "contains"] },
                value: { type: "string" },
              },
              required: ["column", "op", "value"],
            },
          },
          forecast_periods: {
            type: "integer",
            description: "How many future periods to forecast (max 12), e.g. 3. Omit or 0 for no forecast.",
          },
        },
        required: ["date_column", "value_column"],
      },
    },
  ],
};

async function callGemini(apiKey, system, contents, useTools) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
  };
  if (useTools) body.tools = [DATA_TOOLS];
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

// Verifies the Supabase access token the frontend sends and returns the user,
// or null if it's missing/invalid/expired. This is the actual security
// boundary — everything the client sends about itself (is_pro, message_count)
// is advisory only and is never trusted here.
async function getAuthedUser(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;
  const { data, error } = await getSupabaseAdmin().auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

async function refundCredit(userId) {
  try {
    await getSupabaseAdmin().rpc("refund_message_count", { p_user_id: userId });
  } catch (e) {
    console.error("refund_message_count failed:", e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server is missing GEMINI_API_KEY. Add it in Vercel project settings." });
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: "Server is missing Supabase service credentials." });
    return;
  }

  // --- Auth: who is this? ---
  const user = await getAuthedUser(req);
  if (!user) {
    res.status(401).json({ error: "Please log in again — your session has expired." });
    return;
  }

  const { system, messages, turnId, priorToolTurns, useTools, toolRound } = req.body || {};
  if (!turnId || typeof turnId !== "string") {
    res.status(400).json({ error: "Missing turnId.", retryable: false });
    return;
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "No messages provided.", retryable: false });
    return;
  }

  // --- Rate limit: atomically check-and-reserve a credit for this TURN. ---
  // charge_turn is idempotent per (user, turnId) — a tool round-trip or a
  // retried request within the same logical turn is only ever charged once.
  let gate;
  try {
    const { data, error } = await getSupabaseAdmin().rpc("charge_turn", {
      p_user_id: user.id,
      p_turn_id: turnId,
      p_daily_limit: FREE_DAILY_LIMIT,
    });
    if (error) throw error;
    gate = Array.isArray(data) ? data[0] : data;
  } catch (e) {
    console.error("charge_turn failed:", e.message);
    // Fail closed: if we can't verify usage, don't let the request through.
    res.status(500).json({ error: "Couldn't verify your usage limit right now — try again shortly.", retryable: true });
    return;
  }

  if (!gate.allowed) {
    res.status(429).json({
      error: `Daily free-tier limit reached (${FREE_DAILY_LIMIT} messages). Resets at midnight, or upgrade to Pro for unlimited messages.`,
      retryable: false,
    });
    return;
  }

  // --- From here on, a credit has been spent for this turn — refund it on any failure path. ---
  try {
    // Max base64 payload allowed per image — keeps the total request (text +
    // history + image) safely under Gemini's 20MB request-size ceiling.
    const MAX_IMAGE_BASE64_CHARS = 7 * 1024 * 1024;
    const contents = messages.map((m) => {
      const parts = [];
      if (m.image && m.image.data && m.image.mimeType) {
        if (typeof m.image.data === "string" && m.image.data.length <= MAX_IMAGE_BASE64_CHARS) {
          parts.push({ inlineData: { mimeType: m.image.mimeType, data: m.image.data } });
        }
      }
      parts.push({ text: String(m.content ?? "") });
      return { role: m.role === "assistant" ? "model" : "user", parts };
    });
    if (Array.isArray(priorToolTurns)) contents.push(...priorToolTurns);

    // Keep the tool available for the whole exchange once one round has used
    // it — Gemini's function-calling protocol expects `tools` to stay
    // declared on every request whose history contains functionCall /
    // functionResponse turns; dropping it mid-conversation (as this used to
    // do after MAX_TOOL_ROUNDS) produced an empty, unusable response instead
    // of an error. Round-limiting now happens on the frontend instead, which
    // simply stops looping and shows a helpful message if it's exceeded.
    const enableTools = !!useTools;

    let response;
    let data;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      response = await callGemini(apiKey, system, contents, enableTools);
      data = await response.json();

      if (response.ok) break;

      const isOverloaded = response.status === 503 || response.status === 429;
      if (isOverloaded && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 1500));
        continue;
      }
      break;
    }

    if (!response.ok) {
      await refundCredit(user.id);
      // Log the real reason server-side (visible in Vercel logs) but never
      // show Google's raw error text to the user — it's technical, often
      // includes internal URLs/metric names, and isn't actionable for them.
      console.error("Gemini API error:", response.status, data?.error?.message);
      let friendlyError = "Something went wrong reaching the AI — please try again in a moment.";
      let retryable = true;
      if (response.status === 429 || response.status === 503) {
        friendlyError = "The AI is busy right now — please wait a few seconds and try again.";
      } else if (response.status === 401 || response.status === 403) {
        friendlyError = "The AI service is temporarily unavailable. Please try again shortly.";
        retryable = false;
      }
      res.status(response.status).json({ error: friendlyError, retryable });
      return;
    }

    const candidateContent = data?.candidates?.[0]?.content;
    const parts = candidateContent?.parts || [];
    const fc = parts.find((p) => p.functionCall);

    if (fc) {
      // Mid-turn — the model wants a real number computed. Not a failure,
      // don't refund; the frontend will execute this and call back with the
      // result using the SAME turnId (so no extra charge happens).
      res.status(200).json({
        type: "function_call",
        name: fc.functionCall.name,
        args: fc.functionCall.args || {},
        appendToolTurns: [{ role: "model", parts }],
        usage: { message_count: gate.message_count, is_pro: gate.is_pro },
      });
      return;
    }

    const text = parts.filter((p) => p.text).map((p) => p.text).join("\n");
    if (!text) {
      // Model returned nothing usable — don't charge the user for a blank reply.
      await refundCredit(user.id);
    }

    res.status(200).json({
      content: [{ type: "text", text }],
      usage: { message_count: gate.message_count, is_pro: gate.is_pro },
    });
  } catch (err) {
    await refundCredit(user.id);
    res.status(500).json({ error: "Server error: " + err.message, retryable: true });
  }
}
