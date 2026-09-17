/**
 * GET /api/oauth/start
 *
 * Begins the authorization-code flow with PKCE (RFC 7636).
 *
 * The code verifier and CSRF state are held in a signed, HttpOnly cookie that
 * lives for 10 minutes. Nothing is written server-side, so there is no store to
 * clean up and nothing to leak if this Worker is compromised.
 */

import {
  Env, GOOGLE_AUTH_URL, GOOGLE_SCOPE, PKCE_COOKIE, PkceState,
  codeChallengeS256, cookie, randomUrlSafe, sign,
} from "./_shared";

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const verifier = randomUrlSafe(32);
  const challenge = await codeChallengeS256(verifier);
  const state = randomUrlSafe(16);

  const pkce: PkceState = { verifier, state, exp: Date.now() + 10 * 60 * 1000 };
  const signed = await sign(pkce, env.SESSION_SECRET);

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${env.PUBLIC_ORIGIN}/api/oauth/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // `consent` + `offline` so the demo actually receives a refresh token to show.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");

  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Set-Cookie": cookie(PKCE_COOKIE, signed, 600),
      "Cache-Control": "no-store",
    },
  });
};
