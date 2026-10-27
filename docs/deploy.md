# Deploying SpaceAble

Two services. Only the web app is public.

```text
browser ──► Next.js app (Vercel or any Node host) ──x-planner-secret──► FastAPI planner (container)
                         └──MODEL_API_KEY──► Meta Model API
```

## 1. Planner (container)

`services/planner/Dockerfile` builds a Python 3.12 image that runs as a non-root user and listens on `$PORT`
(default 8000). It works on any container host with native Shapely wheels: Cloud Run, Render, Fly.io,
Railway and similar.

| Variable | Value |
| --- | --- |
| `PLANNER_SHARED_SECRET` | **Required in production.** A long random string, e.g. `python -c "import secrets;print(secrets.token_urlsafe(32))"`. Every route except `/health` returns 401 without it. If it is unset, the planner logs a warning at startup and accepts every request. |
| `PLANNER_CORS_ORIGINS` | The web app's origin. The browser never calls the planner directly, so this is defence in depth only. |
| `PORT` | Usually set by the host. |

The health check path is `/health`. Size the instance for CPU: one optimize request can use up to its time
limit (default 10 s, max 30 s) of a single core.

## 2. Web app (Vercel)

- Root directory: `apps/web`. Keep **"Include files outside the root directory in the Build Step"** on,
  because the app imports `shared/fixtures/canonical-bedroom.json` at build time.
- Node 20.17+ (24 tested). Build command `npm run build`, default output.

| Variable | Value |
| --- | --- |
| `PLANNER_API_URL` | The planner's public HTTPS URL. |
| `PLANNER_SHARED_SECRET` | The same value as on the planner. |
| `MODEL_API_KEY` | Meta Model API key, server-side only. Never prefix it with `NEXT_PUBLIC_`. |
| `META_BASE_URL`, `META_MUSE_MODEL`, `META_SAM_MODEL` | Optional overrides (defaults in `.env.example`). |

Slow routes (optimize, explain, segment, parse-request) export `maxDuration = 60`. Confirm your plan allows
60 s functions; otherwise optimize (up to its time limit) and explain (11–17 s live) can be cut off.
Vercel also caps request bodies at about 4.5 MB. That's below the server's 5 MB photo limit, but the
browser re-encodes photos to at most 1600 px JPEG (a few hundred KB) before upload, so real uploads stay
well under it.

The AI and planner routes rate-limit per client IP in memory. On many instances, move that state to a
shared store (see the note in `lib/meta.ts`). The client IP comes from `x-forwarded-for`.
Vercel sets that header itself; on other hosts, make sure the proxy overwrites it.

## 3. After deploying

```bash
curl https://<web>/api/health          # {"status":"ok","planner":"ok","meta_configured":true}
curl -X POST https://<planner>/v1/planner/analyze -d '{}' -H 'content-type: application/json'   # must be 401
```

Then run through the demo script once on the deployed URL (`docs/demo-script.md`).

## Rehearsed locally (2026-10-26)

Without Docker (WSL integration was off), the planner was installed non-editably into a clean venv
(`pip install services/planner`, as the Dockerfile does) and run from outside the source tree with a
secret set. The web app was run with `next build && next start` and the planner URL and secret set:

- planner without the secret returned 401; with it, 200; `/health` was open;
- `/api/health` through the web app reported the planner online and Meta configured;
- optimize through the web app returned 3 verified alternatives;
- a live Muse parse through the production build worked;
- responses carried `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy` and
  `Permissions-Policy`, and no `X-Powered-By`.

The Docker image itself has not been built yet.

## Before the repository goes public

- [ ] **Rotate the Meta API key** (the development key was exposed during development) and put the new
      one only in the host's secret store and your local `apps/web/.env.local`.
- [ ] `git log -p | grep -c <first 12 characters of the old key>` prints 0 (checked 2026-10-26: 0).
- [ ] `.env.local` is untracked (`git check-ignore apps/web/.env.local`).
- [ ] Confirm the hackathon rules on work dated before the build window (commits so far are dated 2026-10-26).
- [ ] Sample photo licence: CC0, attributed in README (keep the attribution).
