/**
 * GET /api/oauth/callback?code=...&state=...
 *
 * Exchanges the authorization code for tokens and opens a session.
 *
 * Every failure mode the playground demonstrates is handled explicitly here
 * rather than collapsing into a generic 500 — `access_denied` when the user
 * cancels, state mismatch on CSRF, and `invalid_grant` on a replayed or
 * expired code.
 */

import {
  Env, GOOGLE_TOKEN_URL, PKCE_COOKIE, PkceState, SESSION_COOKIE, Session,
  clearCookie, cookie, readCookie, sign, timingSafeEqual, unsign,
} from "./_shared";

/** Send failures back to the playground UI, which renders them in the trace. */
function fail(origin: string, reason: string, detail?: string): Response {
  const url = new URL(`${origin}/oauth/`);
  url.hash = `oauth-error:${reason}${detail ? `:${encodeURIComponent(detail)}` : ""}`;
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), "Set-Cookie": clearCookie(PKCE_COOKIE), "Cache-Control": "no-store" },
  });
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const origin = env.PUBLIC_ORIGIN;
  const params = new URL(request.url).searchParams;

  // The user pressed "Cancel" on Google's consent screen.
  const denied = params.get("error");
  if (denied) return fail(origin, denied, params.get("error_description") ?? undefined);

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return fail(origin, "missing_parameters");

  // Recover the PKCE verifier. A tampered or expired cookie returns null.
  const pkce = await unsign<PkceState>(readCookie(request, PKCE_COOKIE), env.SESSION_SECRET);
  if (!pkce) return fail(origin, "expired_or_tampered_state");
  if (!timingSafeEqual(pkce.state, state)) return fail(origin, "state_mismatch");

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin}/api/oauth/callback`,
      grant_type: "authorization_code",
      code_verifier: pkce.verifier,
    }),
  });

  if (!res.ok) {
    // The interesting one: a replayed or expired code returns invalid_grant.
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return fail(origin, body.error ?? `token_exchange_${res.status}`);
  }

  const tok = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };

  const session: Session = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + tok.expires_in * 1000,
    scope: tok.scope,
    exp: Date.now() + 60 * 60 * 1000, // the session itself dies in an hour regardless
  };

  const headers = new Headers({ Location: `${origin}/oauth/#oauth-connected`, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", clearCookie(PKCE_COOKIE));
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, await sign(session, env.SESSION_SECRET), 3600));

  return new Response(null, { status: 302, headers });
};
