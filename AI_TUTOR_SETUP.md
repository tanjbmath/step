# S.T.E.P. AI Tutor — Free-tier setup

This version uses a Cloudflare Worker as the secret-holding backend and the Google Gemini Developer API from Google AI Studio. It does not use Firebase Cloud Functions, so deploying this AI endpoint does not require upgrading Firebase to Blaze.

## 0. Protect the API key

The Google AI Studio key previously pasted into chat should be treated as exposed. Revoke it in Google AI Studio and create a replacement. Never put the replacement in GitHub or browser JavaScript.

## 1. Check the Gemini free tier

Read https://ai.google.dev/gemini-api/docs/billing and https://ai.google.dev/gemini-api/docs/rate-limits. Confirm your project is on the Free tier and that the selected model is available. Limits vary by model and can change. Do not link a billing account if you want to avoid paid API usage.

## 2. Create a Cloudflare Worker (free plan)

1. Create/sign in to a Cloudflare account at https://dash.cloudflare.com/.
2. Install Node.js if needed, then from the repository root run:

```powershell
npm install -g wrangler
wrangler login
wrangler deploy
```

The repository's `wrangler.toml` configures the Worker name and entry point. Cloudflare will create the Worker during deployment.

## 3. Store the Gemini API key as a Worker secret

After revoking the exposed key and creating a replacement in Google AI Studio, run:

```powershell
wrangler secret put GEMINI_API_KEY
```

Paste the replacement key only into the terminal prompt. Never add it to `wrangler.toml`, source files, GitHub, or browser JavaScript. Deploy again:

```powershell
wrangler deploy
```

## 4. Connect the S.T.E.P. frontend

Cloudflare will show a URL similar to `https://step-ai-tutor.YOUR-SUBDOMAIN.workers.dev`.

1. Open `script.js`.
2. Find `STEP_AI_TUTOR_WORKER_URL`.
3. Replace `https://REPLACE-WITH-YOUR-WORKER.workers.dev` with the actual Worker URL.
4. Commit and push that change to `main` so GitHub Pages publishes it.

## 5. Test

1. Open https://tanjbmath.github.io/step/ and sign in with Google.
2. Join an assignment as a student and open a question.
3. Test Help Me Start, Check my step, Give me another hint, Show a similar example, and an uploaded question image.
4. Confirm an account that has not joined the assignment is denied.

## Free-tier and security notes

- Cloudflare Workers Free has a daily request quota. Check https://developers.cloudflare.com/workers/platform/limits/ for current limits.
- Gemini free-tier model availability and quotas vary. Check the active limits in Google AI Studio. When the free quota is exhausted, requests should fail rather than require an upgrade.
- The Worker verifies Firebase ID-token signatures and checks assignment membership against Firestore using the student's token. The Gemini API key stays on the server.
- The included per-isolate throttle is best-effort, not a globally consistent quota. Gemini project quotas and Cloudflare plan limits are the main safeguards; this is not production-grade abuse prevention.
- Google's Gemini API Free tier may use prompts and responses to improve Google products. Avoid sending confidential student information; check Google's current terms.
- Firebase Authentication and Firestore remain in use. This AI backend does not use Firebase Cloud Functions.
