// Vercel serverless function — Core-team defect analysis, computed live from
// webook.com Jira server-side (credentials never reach the browser).
//
// Mirrors the "Core Team — Defect Analysis" logic: bugs in the five Core
// projects over a rolling window, where a bug counts as RESOLVED when it first
// transitions to "Ready to Deploy" (or, for bugs that reach a Done status
// without ever passing RTD, at that Done transition). Jira's own resolutiondate
// is deliberately NOT used.
//
// Required environment variables (same as api/metrics.js):
//   JIRA_BASE_URL   e.g. https://webookcom.atlassian.net
//   JIRA_EMAIL      the Atlassian account email the API token belongs to
//   JIRA_API_TOKEN  an Atlassian API token

const PROJECTS = ["CBPC", "CCS", "CHOL", "CR", "CSD"]; // Core team
const WINDOW = 90; // days
const RTD_STATUS = "Ready to Deploy";
const DAY = 86400000;
const PAGE_CAP = 40; // safety: max pages (x100 issues) per query

const lc = (s) => String(s == null ? "" : s).toLowerCase();

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}
function authHeader() {
  return "Basic " + Buffer.from((process.env.JIRA_EMAIL || "") + ":" + (process.env.JIRA_API_TOKEN || "")).toString("base64");
}
function baseUrl() {
  return (process.env.JIRA_BASE_URL || "").replace(/\/+$/, "");
}
async function jiraFetch(path, body) {
  if (typeof fetch !== "function") throw new Error("global fetch unavailable (needs Node 18+)");
  const res = await fetch(baseUrl() + path, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Jira " + res.status + " — " + text.slice(0, 200));
  }
  return res.json();
}
// New Jira Cloud search (CHANGE-2046): /rest/api/3/search/jql, paginated via nextPageToken.
async function jiraAll(jql, fields, expand) {
  let issues = [], token = null;
  for (let p = 0; p < PAGE_CAP; p++) {
    const body = { jql, maxResults: 100, fields: fields || [] };
    if (expand) body.expand = expand;
    if (token) body.nextPageToken = token;
    const j = await jiraFetch("/rest/api/3/search/jql", body);
    issues = issues.concat(j.issues || []);
    token = j.nextPageToken;
    if (!token) break;
  }
  return issues;
}

// ---- changelog helpers ----
function firstTransitionTo(issue, statusName) {
  const hs = (issue.changelog && issue.changelog.histories) || [];
  let best = null;
  for (const h of hs) {
    for (const it of (h.items || [])) {
      if (it.field === "status" && lc(it.toString) === lc(statusName)) {
        const d = new Date(h.created);
        if (!best || d < best) best = d;
      }
    }
  }
  return best;
}
function lastStatusTransition(issue) {
  const hs = (issue.changelog && issue.changelog.histories) || [];
  let last = null;
  for (const h of hs) {
    for (const it of (h.items || [])) {
      if (it.field === "status") {
        const d = new Date(h.created);
        if (!last || d > last) last = d;
      }
    }
  }
  return last;
}

function norm(issue) {
  const f = issue.fields || {};
  const created = f.created ? new Date(f.created) : null;
  const doneCat = !!(f.status && f.status.statusCategory && f.status.statusCategory.key === "done");
  const summary = f.summary || "";
  const area = ((summary.match(/^\s*\[([^\]\/]+)/) || [])[1] || "").trim() || null;
  return {
    key: issue.key,
    summary,
    project: String(issue.key || "").split("-")[0],
    priority: (f.priority && f.priority.name) || "None",
    status: (f.status && f.status.name) || "?",
    doneCat,
    created: created ? created.toISOString() : null,
    epicKey: (f.parent && f.parent.key) || null,
    epic: (f.parent && ((f.parent.fields && f.parent.fields.summary) || f.parent.key)) || null,
    area,
  };
}

// ---- Auth gate (shared password). Active only when AUTH_SECRET + SITE_PASSWORD are set. ----
const crypto = require("crypto");
function b64urlToBuf(s) { return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"); }
function signB64url(data, secret) {
  return crypto.createHmac("sha256", secret).update(data).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function getCookie(req, name) {
  const c = req.headers.cookie || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function authed(req) {
  const secret = process.env.AUTH_SECRET;
  if (!secret || !process.env.SITE_PASSWORD) return true; // gate off until configured
  const token = getCookie(req, "auth");
  if (!token || token.indexOf(".") < 0) return false;
  const parts = token.split(".");
  const expected = signB64url(parts[0], secret);
  if (parts[1].length !== expected.length) return false;
  try { if (!crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) return false; } catch (e) { return false; }
  try { const p = JSON.parse(b64urlToBuf(parts[0]).toString()); return p.exp && p.exp > Date.now(); } catch (e) { return false; }
}

module.exports = async (req, res) => {
  try {
    if (!authed(req)) { send(res, 401, { error: "auth required" }); return; }
    if (!baseUrl() || !process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
      send(res, 500, { error: "Jira is not configured. Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in the Vercel project settings, then redeploy." });
      return;
    }

    const FIELDS = ["summary", "status", "priority", "created", "parent"];
    const diag = [];
    const errors = [];
    let partial = false;
    const byKey = new Map();
    const winResolvedKeys = new Set(); // bugs known to have resolved inside the window (from window-scoped queries)

    // Per project: created-in-window (with changelog), old-still-open, old bugs
    // that hit RTD in window (changelog), old bugs that reached Done in window (changelog).
    for (const p of PROJECTS) {
      const q = {
        recent: `project = ${p} AND issuetype = Bug AND created >= -${WINDOW}d ORDER BY created ASC`,
        oldOpen: `project = ${p} AND issuetype = Bug AND created < -${WINDOW}d AND statusCategory != Done`,
        rtdWin: `project = ${p} AND issuetype = Bug AND created < -${WINDOW}d AND status changed to "${RTD_STATUS}" after -${WINDOW}d`,
        doneWin: `project = ${p} AND issuetype = Bug AND created < -${WINDOW}d AND statusCategory = Done AND status changed after -${WINDOW}d`,
      };
      const guarded = async (label, jql, expand) => {
        try {
          const rows = await jiraAll(jql, FIELDS, expand);
          diag.push(`${label}: ${rows.length}`);
          return rows;
        } catch (e) {
          partial = true;
          errors.push(`${label}: ${e && e.message ? e.message : String(e)}`);
          return [];
        }
      };
      const [recent, oldOpen, rtdWin, doneWin] = await Promise.all([
        guarded(`${p} created`, q.recent, "changelog"),
        guarded(`${p} oldOpen`, q.oldOpen, null),
        guarded(`${p} rtdWin`, q.rtdWin, "changelog"),
        guarded(`${p} doneWin`, q.doneWin, "changelog"),
      ]);

      // changelog-bearing queries first so their richer version wins the merge.
      recent.concat(rtdWin, doneWin, oldOpen).forEach((issue) => {
        if (!issue || !issue.key) return;
        if (!byKey.has(issue.key)) byKey.set(issue.key, { issue, n: norm(issue) });
      });
      rtdWin.concat(doneWin).forEach((issue) => { if (issue && issue.key) winResolvedKeys.add(issue.key); });
    }

    // Resolve each bug from its changelog.
    const now = Date.now();
    const winMs = (WINDOW + 1) * DAY;
    const bugs = [...byKey.values()].map(({ issue, n }) => {
      const created = n.created ? new Date(n.created) : null;
      const firstRTD = firstTransitionTo(issue, RTD_STATUS);
      const lastStatus = lastStatusTransition(issue);
      const closedNoDeploy = n.doneCat && !firstRTD;
      const resolved = !!firstRTD || n.doneCat;
      const resDate = firstRTD || (closedNoDeploy ? lastStatus : null);
      const resDays = created && resDate ? (resDate.getTime() - created.getTime()) / DAY : null;
      const resolvedInWindow = resDate ? (now - resDate.getTime()) <= winMs : winResolvedKeys.has(n.key);
      return {
        key: n.key,
        summary: n.summary,
        project: n.project,
        priority: n.priority,
        status: n.status,
        epicKey: n.epicKey,
        epic: n.epic,
        area: n.area,
        created: n.created,
        open: !resolved,
        closedNoDeploy,
        resDate: resDate ? resDate.toISOString() : null,
        resDays: resDays == null ? null : Math.round(resDays * 10) / 10,
        resolvedInWindow,
        ageDays: created ? Math.floor((now - created.getTime()) / DAY) : 0,
      };
    });

    send(res, 200, {
      generatedAt: new Date().toISOString(),
      window: WINDOW,
      projects: PROJECTS,
      browseBase: baseUrl(),
      rtdStatus: RTD_STATUS,
      bugs,
      partial,
      errors,
      diag,
    });
  } catch (e) {
    send(res, 500, { error: "Unhandled: " + (e && e.message ? e.message : String(e)) });
  }
};
