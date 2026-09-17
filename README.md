# Integration Lab

A working demonstration of production integration patterns — OAuth 2.0 with PKCE,
signed webhooks, retry and reconciliation — built by [Ivan Tsang](https://cryptofundingwatch.pro).

Frontend and API both run on Cloudflare Pages. Total hosting cost: **$0**.

---

## Deploy today, domain later

Pages hands you a live `*.pages.dev` URL on the first push. You do **not** need a
domain to get this online — buy one when you're ready to register OAuth redirect
URIs, not before.

### 1. Push to GitHub

```bash
cd integration-lab
git init && git add -A && git commit -m "Integration Lab"
gh repo create integration-lab --public --source=. --push
```

Make it **public**. Clients read code, and the repo is portfolio evidence in its
own right — it costs nothing and it's one more thing a proposal can link to.

### 2. Connect it to Cloudflare Pages

Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | *(leave empty)* |
| Build output directory | `public` |

First deploy takes under a minute. You now have
`https://integration-lab.pages.dev` — a real HTTPS URL you can put in a proposal
today.

Every `git push` to `main` redeploys automatically. Pull requests get their own
preview URLs.

### 3. Create the KV namespace

```bash
npx wrangler kv namespace create INBOX
```

Paste the returned id into `wrangler.toml`.

### 4. Set secrets

Never commit these. `wrangler.toml` is in git; secrets are not.

```bash
npx wrangler pages secret put SESSION_SECRET        # openssl rand -base64 32
npx wrangler pages secret put GOOGLE_CLIENT_SECRET
npx wrangler pages secret put META_APP_SECRET
npx wrangler pages secret put META_VERIFY_TOKEN     # any string you invent
```

For local development, copy `.dev.vars.example` to `.dev.vars` (gitignored) and
run `npx wrangler pages dev public`.

---

## Choosing a domain

**Register a personal domain, not a project one.** `integrationlab.dev` is
memorable but it locks you to one pitch. If you later lead with FinTech
automation or AI integration instead, a personal domain still fits and the lab
just moves to a subdomain.

Recommended shape:

| Domain | Lab lives at |
|---|---|
| `ivantsang.dev` | `ivantsang.dev/lab` or `lab.ivantsang.dev` |
| `ivantsang.io` | same |
| `tsang.engineering` | same |

`.dev` is a good signal for this audience and is HTTPS-only by design, which
suits a site whose whole argument is doing security properly.

**Where to buy:** Cloudflare Registrar sells at wholesale cost with no renewal
markup and no upsells, and you'll already have the account. Roughly $10–12/year
for `.dev`.

**Then update, in this order:**

1. Pages → Custom domains → add it (DNS is automatic if the domain is on Cloudflare)
2. `PUBLIC_ORIGIN` in `wrangler.toml` → the new origin
3. Google Cloud Console → the authorized redirect URI
4. Meta App Dashboard → the webhook callback URL

Steps 3 and 4 are why the domain should be settled before you register anything
upstream. Changing them later means re-verifying with Meta.

---

## Registering the integrations

### Google OAuth (Module 01)

Google Cloud Console → **APIs & Services** → **Credentials** → **OAuth client ID**
→ *Web application*.

| Field | Value |
|---|---|
| Authorized redirect URI | `https://<your-origin>/api/oauth/callback` |
| Scope | `drive.metadata.readonly` |

The redirect URI must match `PUBLIC_ORIGIN` exactly — scheme included, no
trailing slash. A mismatch is the single most common cause of `redirect_uri_mismatch`.

Keep the app in **Testing** mode and add your own account as a test user. Going
to Production triggers Google's verification review, which you don't need for a
read-only demo. Note in the UI that the consent screen will show an "unverified
app" warning — that's expected for a lab, and saying so is better than a visitor
discovering it.

### WhatsApp Cloud API (Module 04)

Meta App Dashboard → **WhatsApp** → **Configuration**.

| Field | Value |
|---|---|
| Callback URL | `https://<your-origin>/api/webhook/whatsapp` |
| Verify token | whatever you set as `META_VERIFY_TOKEN` |
| Subscribe to | `messages` |

Meta calls the URL with a `GET` handshake first; `whatsapp.ts` answers it. Then
every inbound message arrives as a signed `POST`.

**No App Review or Business Verification is required** for the free test number.
It only messages phone numbers you add to the allow-list in the developer portal
— which is why the public demo is a web simulator hitting the same endpoint,
plus a recorded video of the real thing. Don't describe the WhatsApp demo as
publicly open while it runs on a test number.

---

## n8n

n8n stays **private on the Dell server**, on the tailnet. It never needs public
hosting — the site demonstrates it through execution traces and downloadable
workflow JSON in `n8n/workflows/`.

If you want the Cloudflare webhook to forward into it, expose only n8n's webhook
path through a Cloudflare Tunnel and set `N8N_WEBHOOK_URL`. The Worker already
handles n8n being unreachable: the message is in KV and can be replayed.

---

## What runs where

| Piece | Where | Cost |
|---|---|---|
| Homepage, module pages | Cloudflare Pages | free |
| OAuth, webhooks, LLM proxy | Pages Functions (Workers runtime) | free to 100k req/day |
| Recent deliveries, idempotency keys | Workers KV | free tier |
| n8n | Dell server, tailnet-only | free |
| Domain | Cloudflare Registrar | ~$11/yr |
| OpenAI / Gemini | pay per call | cap it at $10–20/mo |

---

## Rules this codebase follows

- **No visitor token is ever persisted.** Sessions ride in signed, HttpOnly
  cookies that expire on their own. There is no database of other people's
  Google tokens to leak.
- **Signatures are compared in constant time.** `===` on an HMAC leaks timing.
- **Webhook bodies are read once, as raw text.** Re-serialising parsed JSON
  changes the bytes and the signature will never match.
- **Acknowledge first, work after.** Meta retries if you're slow; doing the work
  before replying turns one slow call into duplicate deliveries.
- **Disconnect revokes upstream.** Clearing a cookie alone leaves the grant alive
  in the user's Google account, which is not "disconnected".
- **No real financial data, ever.** Module 07 uses synthetic feeds only.

---

## Repo layout

```
public/                     static site (Pages serves this)
  index.html
functions/api/
  oauth/
    _shared.ts              PKCE, signed cookies, constant-time compare
    start.ts                GET  — begin authorization with PKCE
    callback.ts             GET  — code exchange, opens session
    session.ts              GET/POST/DELETE — inspect, refresh, revoke
  webhook/
    whatsapp.ts             GET handshake + signed POST delivery
  ai/                       LLM router (Module 05)
n8n/workflows/              exported workflows, downloadable from the site
wrangler.toml               config; secrets are NOT here
```
