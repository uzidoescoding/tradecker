/**
 * Groq transport.
 *
 * One place so both AI routes agree on the model, the timeout, the error
 * shape and the degraded path. Every failure here is soft: no key, a retired
 * model, a rate limit and a network drop all return `{ error }` rather than
 * throwing, because the consensus scoring is the product and it must keep
 * working when the commentary layer does not.
 */

export const MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

export type Msg = { role: "system" | "user" | "assistant"; content: string };

export type Reply = { text: string; model: string; error?: string };

export const NO_KEY =
  "This panel needs a Groq key. Put GROQ_API_KEY in .env.local and restart the dev server. Everything else on the page works without it.";

export async function chat(
  messages: Msg[],
  opts: { json?: boolean; maxTokens?: number; temperature?: number } = {},
): Promise<Reply> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { text: "", model: MODEL, error: NO_KEY };

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 1200,
        // gpt-oss exposes a reasoning budget; other families reject the field.
        ...(MODEL.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        messages,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      let reason = `Groq returned ${res.status}`;
      try {
        reason = JSON.parse(detail)?.error?.message ?? reason;
      } catch {
        /* keep the status line */
      }
      console.error("Groq error", res.status, detail.slice(0, 300));
      return { text: "", model: MODEL, error: reason };
    }

    const data = await res.json();
    return { text: data?.choices?.[0]?.message?.content ?? "", model: MODEL };
  } catch (e) {
    console.error("Groq unreachable", e);
    return { text: "", model: MODEL, error: "Could not reach Groq." };
  }
}

/**
 * Parse a JSON reply without trusting it to be clean.
 *
 * Even in JSON mode models wrap output in prose or a fenced block often enough
 * that a bare JSON.parse is a coin flip, and this runs on a path that produces
 * price levels.
 */
export function parseJson<T>(text: string): T | null {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
