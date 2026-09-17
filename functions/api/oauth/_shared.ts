/**
 * Shared OAuth 2.0 helpers — PKCE, signed state, session cookies.
 *
 * Design rule for the whole lab: visitor tokens are NEVER persisted server-side.
 * Everything a session needs rides in a signed, HttpOnly cookie that expires on
 * its own. There is no database of other people's Google tokens to leak.
 */

export interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;   // secret — set via `wrangler pages secret put`
  SESSION_SECRET: string;         // secret — random 32+ bytes, used to sign cookies
  PUBLIC_ORIGIN: string;          // e.g. https://integration-lab.pages.dev
}

/** Minimal, read-only scope. The playground reads a file list and nothing else. */
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

// ----------------------------------------------------------------- encoding

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomUrlSafe(byteLength = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
}

/** RFC 7636 §4.2 — S256 code challenge. */
export async function codeChallengeS256(verifier: string): Promise<string> {
  return b64url(await sha256(verifier));
}

// ----------------------------------------------------------------- signing

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Sign a JSON payload into `<b64url(json)>.<b64url(sig)>`. */
export async function sign(payload: unknown, secret: string): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body));
  return `${body}.${b64url(sig)}`;
}

/** Verify and decode. Returns null on any tampering or expiry. */
export async function unsign<T>(token: string | null, secret: string): Promise<T | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body));
  if (!timingSafeEqual(b64url(expected), sig)) return null;

  try {
    const json = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(body.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
      ),
    ) as T & { exp?: number };
    if (json.exp && Date.now() > json.exp) return null;
    return json;
  } catch {
    return null;
  }
}

/** Constant-time string compare — never use `===` on a signature. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ----------------------------------------------------------------- cookies

export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  return parts.join("; ");
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

export const PKCE_COOKIE = "il_pkce";
export const SESSION_COOKIE = "il_session";

export interface PkceState {
  verifier: string;
  state: string;
  exp: number;
}

export interface Session {
  access_token: string;
  refresh_token?: string;
  /** Absolute ms timestamp when the access token expires. */
  expires_at: number;
  scope: string;
  exp: number;
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
  });
}
