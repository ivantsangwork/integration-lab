/**
 * /api/sim/endpoint
 *
 * A deliberately controllable downstream, so the retry lab exercises real HTTP
 * with real latency instead of a mocked promise. The client drives it:
 *
 *   ?mode=healthy   → 200 after a short delay
 *   ?mode=flaky     → ~50% chance of 503
 *   ?mode=down      → 503 every time
 *   ?mode=slow      → 200, but slow enough to trip a timeout
 *
 * The failure is induced on purpose. Everything around it — the network call,
 * the status codes, the timings the client measures, the Retry-After header —
 * is genuine.
 *
 * Idempotency: a request carrying an Idempotency-Key that has already been
 * seen and succeeded returns the original result and is flagged as a replay,
 * so a retry after an ambiguous timeout cannot double-apply.
 */

export interface Env {
  INBOX?: KVNamespace; // optional — falls back to in-isolate memory
}

/** Per-isolate fallback store. Fine for a demo; KV is used when bound. */
const seen = new Map<string, { status: number; at: number }>();

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const onRequestPost: PagesFunction<Env> = async ({ request }) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") ?? "healthy";
  const key = request.headers.get("Idempotency-Key");
  const started = Date.now();

  // ---- idempotency: a replayed key never re-applies the write ----
  if (key && seen.has(key)) {
    const prior = seen.get(key)!;
    return json(
      { ok: true, replay: true, applied: false, status: prior.status, note: "idempotency key already seen — no-op" },
      { status: 200, headers: { "X-Idempotent-Replay": "true" } },
    );
  }

  // ---- induced latency, so measured timings are real ----
  const latency = mode === "slow" ? 2600 + Math.random() * 900 : 60 + Math.random() * 180;
  await wait(latency);

  const fails = mode === "down" || (mode === "flaky" && Math.random() < 0.5);

  if (fails) {
    // 503 with Retry-After is what a well-behaved overloaded service returns.
    return json(
      { ok: false, error: "service_unavailable", mode, latency_ms: Date.now() - started },
      { status: 503, headers: { "Retry-After": "1" } },
    );
  }

  if (key) seen.set(key, { status: 200, at: Date.now() });
  if (seen.size > 500) seen.clear(); // bounded — this is a demo, not a datastore

  return json({ ok: true, replay: false, applied: true, mode, latency_ms: Date.now() - started });
};

/** Simple health probe for the status board. */
export const onRequestGet: PagesFunction<Env> = async () =>
  json({ ok: true, service: "sim-endpoint", modes: ["healthy", "flaky", "down", "slow"] });
