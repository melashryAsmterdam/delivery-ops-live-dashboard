// Vercel serverless function — "Defects Analysis — Done / Closed epics".
// Live counterpart of the frozen Library snapshot: reads webook.com Jira
// server-side on every call and recomputes the whole report. Credentials never
// reach the browser.
//
// What it reproduces (see the snapshot for the shape):
//   - Epics that shipped in the window (statusCategory = Done, i.e. Done/Closed,
//     resolved on/after the window start), newest first, scanning up to SCAN_CAP.
//   - For every scanned epic, its child Bugs/Defects split into
//       Open      = statusCategory != Done
//       Rejected  = status "Defect Rejected" (a Done-category status)
//       Closed    = Done-category, not Rejected
//     Total = Open + Closed + Rejected.
//   - Refinement (Refined if the epic carries a DoR-family label), size buckets
//     (auto-detected XS–XL select), still-open defects on shipped epics, and
//     bug-resolution time by team (created -> resolutiondate, fixed bugs only).
//
// Required environment variables (same account as api/metrics.js / api/defects.js):
//   JIRA_BASE_URL   e.g. https://webookcom.atlassian.net
//   JIRA_EMAIL      the Atlassian account email the API token belongs to
//   JIRA_API_TOKEN  an Atlassian API token
// Optional:
//   DEFECTS_RESOLVED_SINCE  YYYY-MM-DD window start (default: first day of the current calendar quarter)
//   DEFECTS_SCAN_CAP        max epics to scan, newest first (default: 40)

// Epic portfolio (matches the snapshot scope). Bugs in the legacy LIF project map to Core.
const TEAM_OF = {
  CBPC: "Core", CCS: "Core", CHOL: "Core", CR: "Core", CSD: "Core", LIF: "Core",
  LTRF: "Labs",
  ESL: "Eco", INCEN: "Eco", RECO: "Eco", FAN: "Eco",
};
const EPIC_PROJECTS = ["CBPC", "CSD", "CHOL", "CR", "CCS", "LTRF", "ESL", "INCEN", "RECO", "FAN"];
const SIZES = ["XS", "S", "M", "L", "XL"];
const REFINED_LABEL = /^(refined|dor|dor[-_ ]?met)$/i;
const DAY = 86400000;
const PAGE_CAP = 40; // safety: max pages (x100 issues) per query

const lc = (s) => String(s == null ? "" : s).toLowerCase();
const teamOf = (key) => TEAM_OF[String(key || "").split("-")[0]] || "Other";

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
// New Jira Cloud search (/rest/api/3/search/jql), paginated via nextPageToken.
async function jiraAll(jql, fields) {
  let issues = [], token = null;
  for (let p = 0; p < PAGE_CAP; p++) {
    const body = { jql, maxResults: 100, fields: fields || [] };
    if (token) body.nextPageToken = token;
    const j = await jiraFetch("/rest/api/3/search/jql", body);
    issues = issues.concat(j.issues || []);
    token = j.nextPageToken;
    if (!token) break;
  }
  return issues;
}

function quarterStartISO() {
  const now = new Date();
  const qMonth = now.getUTCMonth() - (now.getUTCMonth() % 3);
  const d = new Date(Date.UTC(now.getUTCFullYear(), qMonth, 1));
  return d.toISOString().slice(0, 10);
}

// Auto-detect the "size" (T-shirt) custom field value on an epic: the first
// custom field whose option value is one of XS/S/M/L/XL.
function detectSize(fields) {
  for (const k of Object.keys(fields || {})) {
    if (k.indexOf("customfield_") !== 0) continue;
    const v = fields[k];
    let val = null;
    if (v && typeof v === "object" && !Array.isArray(v)) val = v.value;
    else if (typeof v === "string") val = v;
    if (val && SIZES.indexOf(String(val).trim().toUpperCase()) > -1) return String(val).trim().toUpperCase();
  }
  return null;
}
function isRefined(labels) {
  return (labels || []).some((l) => REFINED_LABEL.test(String(l).trim()));
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

function classify(bug) {
  const f = bug.fields || {};
  const cat = f.status && f.status.statusCategory && f.status.statusCategory.key;
  const statusName = (f.status && f.status.name) || "";
  const open = cat !== "done";
  const rejected = !open && /reject/i.test(statusName);
  const closed = !open && !rejected;
  return { open, rejected, closed, statusName };
}

module.exports = async (req, res) => {
  try {
    if (!authed(req)) { send(res, 401, { error: "auth required" }); return; }
    if (!baseUrl() || !process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
      send(res, 500, { error: "Jira is not configured. Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in the Vercel project settings, then redeploy." });
      return;
    }

    const since = (process.env.DEFECTS_RESOLVED_SINCE || quarterStartISO()).trim();
    const cap = Math.max(1, parseInt(process.env.DEFECTS_SCAN_CAP || "40", 10) || 40);
    const errors = [];
    let partial = false;

    // 1) Shipped epics in the window, newest first. Fetch all matching so we can
    //    report the true match count, then scan only the newest `cap`.
    const epicJql =
      `project in (${EPIC_PROJECTS.join(", ")}) AND issuetype = Epic AND statusCategory = Done ` +
      `AND resolutiondate >= "${since}" ORDER BY resolutiondate DESC`;
    let epics = [];
    try {
      epics = await jiraAll(epicJql, ["summary", "status", "resolutiondate", "labels", "assignee", "*all"]);
    } catch (e) {
      send(res, 502, { error: "Could not read epics from Jira — " + (e && e.message ? e.message : String(e)) });
      return;
    }
    const matchedEpics = epics.length;
    const scanned = epics.slice(0, cap);

    // 2) All child bugs/defects of the scanned epics, in one paginated query.
    const keys = scanned.map((e) => e.key);
    const bugFields = ["status", "priority", "created", "resolutiondate", "parent", "summary"];
    const byParent = new Map(); // epicKey -> array of bugs
    if (keys.length) {
      const chunkSize = 50;
      for (let i = 0; i < keys.length; i += chunkSize) {
        const chunk = keys.slice(i, i + chunkSize);
        const jql = `parent in (${chunk.join(", ")}) AND issuetype in (Bug, Defect)`;
        try {
          const bugs = await jiraAll(jql, bugFields);
          for (const b of bugs) {
            const pk = (b.fields && b.fields.parent && b.fields.parent.key) || null;
            if (!pk) continue;
            if (!byParent.has(pk)) byParent.set(pk, []);
            byParent.get(pk).push(b);
          }
        } catch (e) {
          partial = true;
          errors.push("children " + chunk.join(",") + ": " + (e && e.message ? e.message : String(e)));
        }
      }
    }

    // 3) Per-epic aggregation.
    const epicRows = scanned.map((e) => {
      const f = e.fields || {};
      const kids = byParent.get(e.key) || [];
      let open = 0, closed = 0, rejected = 0;
      const openByStatus = {};
      for (const b of kids) {
        const c = classify(b);
        if (c.open) { open++; openByStatus[c.statusName] = (openByStatus[c.statusName] || 0) + 1; }
        else if (c.rejected) rejected++;
        else closed++;
      }
      return {
        key: e.key,
        summary: (f.summary || "").trim(),
        status: (f.status && f.status.name) || "?",
        team: teamOf(e.key),
        dri: (f.assignee && f.assignee.displayName) || "—",
        size: detectSize(f),
        refined: isRefined(f.labels),
        resolved: f.resolutiondate || null,
        open, closed, rejected,
        total: open + closed + rejected,
        openByStatus,
      };
    });
    epicRows.sort((a, b) => (b.total - a.total) || (b.open - a.open));

    // 4) Roll-ups.
    const totalDefects = epicRows.reduce((s, r) => s + r.total, 0);
    const totalOpen = epicRows.reduce((s, r) => s + r.open, 0);

    // Refinement buckets.
    const refBucket = (refined) => {
      const rows = epicRows.filter((r) => r.refined === refined);
      const defects = rows.reduce((s, r) => s + r.total, 0);
      return {
        epics: rows.length,
        defects,
        open: rows.reduce((s, r) => s + r.open, 0),
        rejected: rows.reduce((s, r) => s + r.rejected, 0),
        avg: rows.length ? defects / rows.length : 0,
      };
    };
    const refinement = { refined: refBucket(true), unrefined: refBucket(false) };

    // Size buckets.
    const sizeBuckets = SIZES.map((sz) => {
      const rows = epicRows.filter((r) => r.size === sz);
      const defects = rows.reduce((s, r) => s + r.total, 0);
      return { size: sz, epics: rows.length, avg: rows.length ? defects / rows.length : 0 };
    });
    const unsized = epicRows.filter((r) => !r.size).length;

    // Still-open defects on shipped epics, by status.
    const openEpics = epicRows
      .filter((r) => r.open > 0)
      .map((r) => ({ key: r.key, summary: r.summary, status: r.status, resolved: r.resolved, openByStatus: r.openByStatus, open: r.open }));

    // Bug-resolution time by team — fixed (Closed) bugs only, created -> resolutiondate.
    const teamAgg = {}; // team -> { days:[], }
    for (const r of epicRows) {
      const kids = byParent.get(r.key) || [];
      for (const b of kids) {
        const c = classify(b);
        if (!c.closed) continue; // fixed = Closed only (excludes Rejected + still-open)
        const f = b.fields || {};
        if (!f.created || !f.resolutiondate) continue;
        const days = (new Date(f.resolutiondate).getTime() - new Date(f.created).getTime()) / DAY;
        if (!(days >= 0)) continue;
        const t = r.team;
        if (!teamAgg[t]) teamAgg[t] = { count: 0, sum: 0 };
        teamAgg[t].count++;
        teamAgg[t].sum += days;
      }
    }
    const resolutionByTeam = Object.keys(teamAgg).map((t) => ({
      team: t,
      fixed: teamAgg[t].count,
      avgDays: teamAgg[t].count ? teamAgg[t].sum / teamAgg[t].count : null,
    })).sort((a, b) => b.fixed - a.fixed);
    const allFixed = Object.values(teamAgg).reduce((s, v) => s + v.count, 0);
    const allSum = Object.values(teamAgg).reduce((s, v) => s + v.sum, 0);
    if (allFixed) resolutionByTeam.push({ team: "All teams", fixed: allFixed, avgDays: allSum / allFixed });

    send(res, 200, {
      generatedAt: new Date().toISOString(),
      browseBase: baseUrl(),
      since,
      scanCap: cap,
      matchedEpics,
      scannedEpics: scanned.length,
      beyondCap: Math.max(0, matchedEpics - scanned.length),
      totalDefects,
      totalOpen,
      refinement,
      sizeBuckets,
      unsized,
      openEpics,
      resolutionByTeam,
      epics: epicRows,
      partial,
      errors,
    });
  } catch (e) {
    send(res, 500, { error: "Unhandled: " + (e && e.message ? e.message : String(e)) });
  }
};
