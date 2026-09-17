/**
 * /api/webhook/whatsapp
 *
 *   GET  → Meta's subscription verification handshake
 *   POST → inbound message delivery
 *
 * Two things here are the actual job, and most tutorials skip both:
 *
 *   1. Signature verification. Anyone on the internet can POST to this URL.
 *      Without checking X-Hub-Signature-256 against the raw body, "from Meta"
 *      means nothing.
 *
 *   2. Acknowledging fast. Meta expects a response inside a few seconds and
 *      retries if it doesn't get one. Doing the work before replying turns one
 *      slow LLM call into a storm of duplicate deliveries. Ack first, work after
 *      — the pattern Slack's Events API documents.
 */

export interface Env {
  META_APP_SECRET: string;    // secret — App Dashboard → Settings → Basic
  META_VERIFY_TOKEN: string;  // secret — any string; must match what you type into Meta
  N8N_WEBHOOK_URL?: string;   // optional — forward to the n8n instance
  INBOX: KVNamespace;         // recent deliveries, for the live trace panel
}

// ------------------------------------------------------------ verification

/** Hex-decode without allocating a Buffer (not available in Workers). */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function verifySignature(raw: string, header: string | null, secret: string): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  return timingSafeEqual(expected, hexToBytes(header.slice(7)));
}

// ------------------------------------------------------------ GET handshake

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const q = new URL(request.url).searchParams;
  if (q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === env.META_VERIFY_TOKEN) {
    return new Response(q.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
};

// ------------------------------------------------------------ POST delivery

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  // Read the body ONCE as text. Re-serialising parsed JSON changes the bytes
  // and the signature will never match.
  const raw = await request.text();

  if (!(await verifySignature(raw, request.headers.get("X-Hub-Signature-256"), env.META_APP_SECRET))) {
    return new Response("invalid signature", { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const msg = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  // Meta retries on its own schedule; a redelivered message has the same id.
  // Recording it makes reprocessing a no-op instead of a duplicate action.
  if (msg?.id) {
    const seen = await env.INBOX.get(`msg:${msg.id}`);
    if (seen) return new Response("duplicate ignored", { status: 200 });

    waitUntil(
      (async () => {
        await env.INBOX.put(
          `msg:${msg.id}`,
          JSON.stringify({ from: msg.from, type: msg.type, text: msg.text?.body, at: Date.now() }),
          { expirationTtl: 60 * 60 * 24 },
        );

        if (env.N8N_WEBHOOK_URL) {
          await fetch(env.N8N_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }).catch(() => {
            /* n8n unreachable — the message is already in KV for replay */
          });
        }
      })(),
    );
  }

  // Ack immediately. Everything above runs after the response is sent.
  return new Response("", { status: 200 });
};
