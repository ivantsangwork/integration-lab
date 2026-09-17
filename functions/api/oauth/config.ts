/**
 * GET /api/oauth/config
 *
 * Reports whether the OAuth backend is wired up, so the playground can show an
 * honest "setup pending" state instead of a Connect button that 500s.
 *
 * Returns the NAMES of missing variables, never any value. A config endpoint
 * that leaks the thing it is checking for is worse than no config endpoint.
 */

import { Env, GOOGLE_SCOPE, json } from "./_shared";

const REQUIRED = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET", "PUBLIC_ORIGIN"] as const;

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const missing = REQUIRED.filter((k) => !(env as unknown as Record<string, string>)[k]);

  return json(
    {
      configured: missing.length === 0,
      missing,
      scope: GOOGLE_SCOPE,
      redirect_uri: env.PUBLIC_ORIGIN ? `${env.PUBLIC_ORIGIN}/api/oauth/callback` : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
};
