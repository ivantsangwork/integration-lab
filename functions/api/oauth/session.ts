/**
 * /api/oauth/session
 *
 *   GET    → token metadata for the inspector (never the raw access token)
 *   POST   → force a refresh, so a visitor can watch rotation happen
 *   DELETE → revoke at Google and drop the session
 *
 * The GET response is deliberately metadata-only. The playground shows a
 * visitor their token's lifecycle; it does not hand their credential back to
 * the browser where a bookmarklet or extension could read it.
 */

import {
  Env, GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, SESSION_COOKIE, Session,
  clearCookie, cookie, json, readCookie, sign, unsign,
} from "./_shared";

async function load(request: Request, env: Env): Promise<Session | null> {
  return unsign<Session>(readCookie(request, SESSION_COOKIE), env.SESSION_SECRET);
}

/** What the inspector panel renders. */
function describe(s: Session) {
  const msLeft = s.expires_at - Date.now();
  return {
    connected: true,
    scope: s.scope,
    has_refresh_token: Boolean(s.refresh_token),
    access_token_fingerprint: `${s.access_token.slice(0, 6)}…${s.access_token.slice(-4)}`,
    expires_in_seconds: Math.max(0, Math.round(msLeft / 1000)),
    expired: msLeft <= 0,
    /** Refresh proactively rather than discovering expiry mid-request. */
    should_refresh: msLeft < 5 * 60 * 1000,
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const s = await load(request, env);
  if (!s) return json({ connected: false }, { status: 200 });
  return json(describe(s), { headers: { "Cache-Control": "no-store" } });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const s = await load(request, env);
  if (!s) return json({ error: "not_connected" }, { status: 401 });
  if (!s.refresh_token) return json({ error: "no_refresh_token" }, { status: 400 });

  const started = Date.now();
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: s.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    // invalid_grant here means the user revoked consent in their Google account.
    return json(
      { error: body.error ?? "refresh_failed", status: res.status, action: "reconnect_required" },
      { status: 400, headers: { "Set-Cookie": clearCookie(SESSION_COOKIE) } },
    );
  }

  const tok = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };

  const next: Session = {
    ...s,
    access_token: tok.access_token,
    // Google only returns a new refresh token when it rotates one.
    refresh_token: tok.refresh_token ?? s.refresh_token,
    expires_at: Date.now() + tok.expires_in * 1000,
  };

  return json(
    { ...describe(next), refreshed: true, rotated: Boolean(tok.refresh_token), latency_ms: Date.now() - started },
    { headers: { "Set-Cookie": cookie(SESSION_COOKIE, await sign(next, env.SESSION_SECRET), 3600), "Cache-Control": "no-store" } },
  );
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const s = await load(request, env);
  if (s) {
    // Best-effort revoke upstream — clearing our cookie alone would leave the
    // grant alive in the user's Google account, which is not "disconnected".
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: s.refresh_token ?? s.access_token }),
    }).catch(() => {});
  }
  return json({ connected: false, revoked: true }, { headers: { "Set-Cookie": clearCookie(SESSION_COOKIE) } });
};
