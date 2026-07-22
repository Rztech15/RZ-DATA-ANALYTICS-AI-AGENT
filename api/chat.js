// Vercel serverless function — calls AI models through OpenRouter
// (https://openrouter.ai), a single API that can route to many different
// underlying models. Configured with a fallback chain: if the primary model
// is down, rate-limited, or errors, OpenRouter automatically retries the
// SAME request against the next model in the list — you're only billed for
// whichever one actually answers.
//
// Required environment variables (set in Vercel project settings):
//   OPENROUTER_API_KEY        — https://openrouter.ai/keys
//   SUPABASE_URL               — same value as SUPABASE_URL in the frontend
//   SUPABASE_SERVICE_ROLE_KEY  — Supabase Project Settings → API → service_role key.
//                                 NEVER put this in the frontend — it bypasses RLS.
//
// Requires the SQL in supabase_rate_limit.sql to be run once against your
// Supabase project (SQL editor → paste → run).
//
// npm install @supabase/supabase-js   (if not already a project dependency)

import { createClient } from "@supabase/supabase-js";

// Fallback chain, tried in order. Chosen so no single provider outage takes
// the app down, and each supports both tool-calling and image/PDF input
// (both required — see DATA_TOOLS and the image-handling code below).
//
// ⚠️ Model slugs and pricing on OpenRouter change over time. Before relying
// on this in production, check current availability/pricing for each at
// https://openrouter.ai/models and adjust this list if needed — swapping
// entries here is the only change required, nothing else in this file needs
// to know which model actually served a given request.
const MODELS = [
  "google/gemini-2.5-flash-lite",
  "openai/gpt-4o-mini",
  "anthropic/claude-3.5-haiku",
];

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
// This is what lets RZ Data Analytics AI answer "total revenue by region" or
// "is revenue trending up" correctly instead of estimating from the handful
// of sample rows shown in the prompt.
//
// OpenAI-style tool format (used by OpenRouter regardless of which
// underlying model answers) — different shape than Gemini's native API:
// each tool is wrapped in {type:"function", function:{...}}.
const DATA_TOOLS = [
  {
    type: "function",
    function: {
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
  },
  {
    type: "function",
    function: {
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
  },
];

async function callOpenRouter(apiKey, openaiMessages, useTools) {
  const body = {
    models: MODELS, // fallback chain — OpenRouter tries each in order
    messages: openaiMessages,
  };
  if (useTools) body.tools = DATA_TOOLS;
  return fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      // Optional but recommended by OpenRouter for their public leaderboards
      // and to help them identify traffic if you ever need support.
      "HTTP-Referer": "https://rz-data-analytics-ai-agent.vercel.app/",
      "X-Title": "RZ Data Analytics AI Agent",
    },
    body: JSON.stringify(body),
  });
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

// Converts the frontend's provider-agnostic message shape
// ({role, content, image?}) into OpenAI-style messages. The last message's
// image (if any) becomes a multimodal content array; every other message
// stays plain text. Kept separate from the tool-turn messages, which are
// already in native OpenAI shape (built by the frontend from a previous
// response) and get appended as-is.
const MAX_IMAGE_BASE64_CHARS = 7 * 1024 * 1024; // keeps the request safely under typical provider limits

function buildOpenAiMessages(system, messages) {
  const out = [{ role: "system", content: system }];
  messages.forEach((m, i) => {
    const isLast = i === messages.length - 1;
    const hasUsableImage =
      isLast && m.image && m.image.data && m.image.mimeType &&
      typeof m.image.data === "string" && m.image.data.length <= MAX_IMAGE_BASE64_CHARS;

    if (hasUsableImage) {
      out.push({
        role: m.role === "assistant" ? "assistant" : "user",
        content: [
          { type: "text", text: String(m.content ?? "") },
          { type: "image_url", image_url: { url: `data:${m.image.mimeType};base64,${m.image.data}` } },
        ],
      });
    } else {
      out.push({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") });
    }
  });
  return out;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server is missing OPENROUTER_API_KEY. Add it in Vercel project settings." });
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

  const { system, messages, turnId, priorToolTurns, useTools } = req.body || {};
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
    const openaiMessages = buildOpenAiMessages(system, messages);
    if (Array.isArray(priorToolTurns)) openaiMessages.push(...priorToolTurns);

    // Keep the tool available for the whole exchange once one round has used
    // it — dropping it mid-conversation while the history still contains
    // tool_calls/tool-result messages can confuse the model. Round-limiting
    // happens on the frontend, which simply stops looping and shows a
    // helpful message if it's exceeded.
    const enableTools = !!useTools;

    let response;
    let data;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      response = await callOpenRouter(apiKey, openaiMessages, enableTools);
      data = await response.json().catch(() => ({}));

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
      // show the raw provider error text to the user — it's technical and
      // isn't actionable for them.
      console.error("OpenRouter API error:", response.status, data?.error?.message);
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

    const choice = data?.choices?.[0];
    const assistantMessage = choice?.message;
    const toolCalls = assistantMessage?.tool_calls;

    if (Array.isArray(toolCalls) && toolCalls.length) {
      // Mid-turn — the model wants one or more real computations run. Not a
      // failure, don't refund; the frontend executes these and calls back
      // with the results using the SAME turnId (so no extra charge happens).
      // OpenAI-style models can request several tool calls in one turn, so
      // this returns the full array rather than just one.
      let calls;
      try {
        calls = toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.function?.name,
          args: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
        }));
      } catch (e) {
        await refundCredit(user.id);
        res.status(200).json({
          content: [{ type: "text", text: "I tried to compute something but hit an internal formatting error — could you rephrase your question?" }],
          usage: { message_count: gate.message_count, is_pro: gate.is_pro },
        });
        return;
      }
      res.status(200).json({
        type: "function_call",
        calls,
        assistantToolCallMessage: assistantMessage, // replay verbatim in the next request's priorToolTurns
        usage: { message_count: gate.message_count, is_pro: gate.is_pro },
        model_used: data?.model,
      });
      return;
    }

    const text = assistantMessage?.content || "";
    if (!text) {
      // Model returned nothing usable — don't charge the user for a blank reply.
      await refundCredit(user.id);
    }

    res.status(200).json({
      content: [{ type: "text", text }],
      usage: { message_count: gate.message_count, is_pro: gate.is_pro },
      model_used: data?.model,
    });
  } catch (err) {
    await refundCredit(user.id);
    res.status(500).json({ error: "Server error: " + err.message, retryable: true });
  }
}
