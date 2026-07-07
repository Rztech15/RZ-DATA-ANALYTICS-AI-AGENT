// Vercel serverless function — calls Google's Gemini API (free tier).
// Set GEMINI_API_KEY in your Vercel project's Environment Variables.
// Get a free key at https://aistudio.google.com/apikey (no credit card needed).

const MODEL = "gemini-2.0-flash-001";

async function callGemini(apiKey, system, contents) {
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
      }),
    }
  );
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

  try {
    const { system, messages } = req.body;

    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    let response;
    let data;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      response = await callGemini(apiKey, system, contents);
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
      res.status(response.status).json({ error: data?.error?.message || "Gemini API error" });
      return;
    }

    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") || "";

    res.status(200).json({ content: [{ type: "text", text }] });
  } catch (err) {
    res.status(500).json({ error: "Server error: " + err.message });
  }
}