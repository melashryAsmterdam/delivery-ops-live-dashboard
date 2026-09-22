# Weekly Delivery Operations — Live Dashboard

A **live** delivery-ops dashboard for webook. Unlike the Library snapshot, this page reads
webook.com Jira **server-side on every load** and has a **Refresh** button that re-pulls the
data and redraws in place — no snapshot, no jumping to Jira.

- `api/metrics.js` — Vercel serverless function. Queries Jira (JQL) with credentials that live
  only on the server, computes the metrics, returns JSON.
- `public/` — the dashboard page (`index.html`, `app.js`, `styles.css`) that calls `/api/metrics`
  on load and on each Refresh click.

## What it shows
KPIs (Throughput 8-wk median, WIP, Pipeline, Rollout, Blockers, Shipped this week), a WIP-by-status
chart, an 8-week throughput chart, and live tables for epics in progress, rollout, and blockers —
across the Core / Labs / Eco epic portfolio (CBPC, CSD, CHOL, CR, CCS, LTRF, ESL, INCEN, RECO, FAN).

### Pages
- `/` — Weekly Delivery Operations dashboard.
- `/defects-analysis.html` — Core-team defect analysis (rolling 90-day window). `api/defects.js`.
- `/defects-epics.html` — **Defects Analysis — Done / Closed epics**: the live counterpart of the
  frozen Library snapshot. Defects carried by epics that shipped this quarter, split into
  Open / Closed / Rejected, with refinement, size and per-team resolution-time roll-ups.
  `api/defects-epics.js`. Optional env: `DEFECTS_RESOLVED_SINCE` (YYYY-MM-DD window start, default =
  first day of the current quarter) and `DEFECTS_SCAN_CAP` (default 40).

## Deploy on Vercel (about 5 minutes)

1. **Put this code in a Git repository** you own (GitHub/GitLab/Bitbucket). Push this folder to it.
2. Go to **vercel.com → Add New → Project** and **import that repository**. No build settings to
   change — it's a zero-config static site + serverless function. Click **Deploy**.
3. Create a **Jira API token**: https://id.atlassian.com/manage-profile/security/api-tokens →
   *Create API token*. Copy it.
4. in Vercel: **Project → Settings → Environment Variables**, add these three (Production), then
   **redeploy**:

   | Name             | Value                                                            |
   | ---------------- | ---------------------------------------------------------------- |
   | `JIRA_BASE_URL`  | `https://webookcom.atlassian.net`                                |
   | `JIRA_EMAIL`     | the Atlassian account email the token belongs to                 |
   | `JIRA_API_TOKEN` | the token from step 3                                             |

5. Open the deployed URL. It loads live; click **Refresh** any time for current numbers.

## Notes
- The token is only ever stored in Vercel's server environment and used server-side — it is never
  sent to the browser.
- The account behind the token needs **read** access to the ten projects above. Read-only is enough.
- Free (Hobby) tier is fine. The function is allowed up to 60s per call (see `vercel.json`); a full
  refresh is ~12 Jira queries and typically returns in a few seconds.

## Run locally (optional)
```
npm i -g vercel
vercel dev
```
Set the three env vars first (e.g. in a local `.env`, which is git-ignored).
