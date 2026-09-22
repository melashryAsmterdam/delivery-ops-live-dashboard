// Vercel serverless function — computes the live Weekly Delivery Operations metrics
// straight from webook.com Jira, server-side (credentials never reach the browser).
//
// Required environment variables (Vercel → Project → Settings → Environment Variables):
//   JIRA_BASE_URL   e.g. https://webookcom.atlassian.net
//   JIRA_EMAIL      the Atlassian account email the API token belongs to
//   JIRA_API_TOKEN  an Atlassian API token (id.atlassian.com → Security → API tokens)

const PROJECTS = ["CBPC", "CSD", "CHOL", "CR", "CCS", "LTRF", "ESL", "INCEN", "RECO", "FAN"];
const TEAM = {
  CBPC: "Core", CSD: "Core", CHOL: "Core", CR: "Core", CCS: "Core",
  LTRF: "Labs",
  ESL: "Eco", INCEN: "Eco", RECO: "Eco", FAN: "Eco",
};
const TEAMS = ["Core", "Labs", "Eco"];
const WIP_STATUSES = ["Ready for Development", "In Development", "Ready for Testing", "In Testing", "Blocked - Bug Fixing"];
const PIPELINE_STATUSES = ["Discovery", "Three Amigos Alignment", "Solution Design"];
const ROLLOUT_STATUSES = ["Ready to Deploy", "A/B Testing"];
const WIP_COLORS = {
  "Ready for Development": "#2563eb",
  "In Development": "#d97706",
  "Ready for Testing": "#7c3aed",
  "In Testing": "#0d9488",
  "Blocked - Bug Fixing": "#dc2626",
};
const TSHIRT_FIELD = "customfield_10578";
const RELEASE_FIELD = "customfield_10176";
const DEFECT_CAP = 30;

const projList = PROJECTS.join(", ");
const quoted = (arr) => arr.map((s) => '"' + s + '"').join(", ");
const teamOf = (key) => TEAM[String(key).split("-")[0]] || "Other";
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
// New Jira Cloud search (CHANGE-2046): /rest/api/3/search/jql returns issues (no total).
async function jira(jql, fields, maxResults, expand) {
  const body = { jql, maxResults: maxResults == null ? 100 : maxResults, fields: fields || [] };
  if (expand) body.expand = expand;
  return jiraFetch("/rest/api/3/search/jql", body);
}
async function countOf(jql) {
  const j = await jiraFetch("/rest/api/3/search/approximate-count", { jql });
  return j && typeof j.count === "number" ? j.count : 0;
}

// ---- dates: Sunday-anchored weeks, Asia/Riyadh (UTC+3), day-precision ----
const OFFSET_MS = 3 * 3600 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function nowRiyadh() { return new Date(Date.now() + OFFSET_MS); }
function weekStart(d) { const x = new Date(d); x.setUTCDate(x.getUTCDate() - x.getUTCDay()); x.setUTCHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function ymd(d) { return d.toISOString().slice(0, 10); }
function weekLabel(d) { return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()]; }
function dayMonth(d) { return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()]; }
function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function cfVal(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(cfVal).filter(Boolean).join(", ");
  if (v.value != null) return cfVal(v.value);
  if (v.name != null) return cfVal(v.name);
  return null;
}
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
const daysBetween = (a, b) => Math.round((a.getTime() - b.getTime()) / 86400000);

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
    const out = { generatedAt: new Date().toISOString(), scope: PROJECTS, browseBase: baseUrl(), errors: [] };
    const guard = async (name, fn) => {
      try { return await fn(); }
      catch (e) { out.errors.push(name + ": " + (e && e.message ? e.message : String(e))); return null; }
    };

    if (!baseUrl() || !process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
      send(res, 500, { error: "Jira is not configured. Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in the Vercel project settings, then redeploy." });
      return;
    }

    const EPIC = `project in (${projList}) AND issuetype = Epic`;

    // WIP + Rollout first — their epic lists seed bug-fixing, the defect scan, and the by-team roll-up.
    await Promise.all([
      guard("wip", async () => {
        const r = await jira(`${EPIC} AND status in (${quoted(WIP_STATUSES)}) ORDER BY status ASC`, ["summary", "status"], 100);
        const issues = r.issues || [];
        const byStatus = WIP_STATUSES.map((s) => ({
          status: s,
          color: WIP_COLORS[s],
          keys: issues.filter((i) => lc(i.fields.status && i.fields.status.name) === lc(s)).map((i) => i.key),
        })).map((s) => ({ status: s.status, color: s.color, count: s.keys.length, keys: s.keys }));
        const byTeam = {};
        TEAMS.forEach((t) => (byTeam[t] = { wip: 0, done: 0, blocked: 0 }));
        const epics = issues.map((i) => {
          const team = teamOf(i.key);
          if (byTeam[team]) byTeam[team].wip++;
          return { key: i.key, summary: i.fields.summary, status: i.fields.status.name, team };
        });
        out.wip = { total: issues.length, byStatus, byTeam, epics };
      }),
      guard("rollout", async () => {
        const r = await jira(`${EPIC} AND status in (${quoted(ROLLOUT_STATUSES)}) ORDER BY status ASC`, ["summary", "status"], 100);
        out.rollout = {
          epics: (r.issues || []).map((i) => ({ key: i.key, summary: i.fields.summary, status: i.fields.status.name, team: teamOf(i.key) })),
        };
        out.rollout.total = out.rollout.epics.length;
      }),
    ]);

    const wipEpics = (out.wip && out.wip.epics) || [];

    await Promise.all([
      guard("pipeline", async () => {
        const r = await jira(`${EPIC} AND status in (${quoted(PIPELINE_STATUSES)}) ORDER BY status ASC`, ["summary", "status"], 100);
        const epics = (r.issues || []).map((i) => ({ key: i.key, summary: i.fields.summary, status: i.fields.status.name, team: teamOf(i.key) }));
        out.pipeline = { total: epics.length, epics };
      }),

      guard("blockers", async () => {
        const withFlag = `${EPIC} AND statusCategory != Done AND (labels in (blocked, Blocked) OR flagged = Impediment)`;
        const labelsOnly = `${EPIC} AND statusCategory != Done AND labels in (blocked, Blocked)`;
        let r;
        try { r = await jira(withFlag + " ORDER BY created ASC", ["summary", "status"], 100); }
        catch (_) { r = await jira(labelsOnly + " ORDER BY created ASC", ["summary", "status"], 100); }
        const epics = (r.issues || []).map((i) => ({ key: i.key, summary: i.fields.summary, status: i.fields.status.name, team: teamOf(i.key) }));
        if (out.wip && out.wip.byTeam) epics.forEach((e) => { if (out.wip.byTeam[e.team]) out.wip.byTeam[e.team].blocked++; });
        out.blockers = { total: epics.length, epics };
      }),

      guard("throughput", async () => {
        const curStart = weekStart(nowRiyadh());
        const weeks = [];
        for (let i = 7; i >= 0; i--) { const start = addDays(curStart, -7 * i); weeks.push({ start, end: addDays(start, 7) }); }
        const values = await Promise.all(
          weeks.map((w) => countOf(`${EPIC} AND status CHANGED TO "Done" DURING ("${ymd(w.start)}", "${ymd(w.end)}")`))
        );
        out.throughput = { labels: weeks.map((w) => weekLabel(w.start)), values, median: median(values.slice(0, 7)) };
        out.shippedThisWeek = values[values.length - 1];
        // Per-team done this week (one search, for the WIP-by-team table).
        const cur = weeks[weeks.length - 1];
        const dr = await jira(`${EPIC} AND status CHANGED TO "Done" DURING ("${ymd(cur.start)}", "${ymd(cur.end)}")`, ["status"], 100);
        if (out.wip && out.wip.byTeam) (dr.issues || []).forEach((i) => { const t = teamOf(i.key); if (out.wip.byTeam[t]) out.wip.byTeam[t].done++; });
      }),

      guard("shipped", async () => {
        const rn = nowRiyadh();
        const thisMonthStart = ymd(new Date(Date.UTC(rn.getUTCFullYear(), rn.getUTCMonth(), 1)));
        const lastMonthStart = ymd(new Date(Date.UTC(rn.getUTCFullYear(), rn.getUTCMonth() - 1, 1)));
        const flds = ["summary", "resolutiondate", TSHIRT_FIELD, RELEASE_FIELD];
        const map = (i) => ({
          key: i.key, summary: i.fields.summary,
          resolved: i.fields.resolutiondate ? dayMonth(new Date(i.fields.resolutiondate)) : "",
          resolvedAt: i.fields.resolutiondate || "",
          size: cfVal(i.fields[TSHIRT_FIELD]), release: cfVal(i.fields[RELEASE_FIELD]),
          team: teamOf(i.key),
        });
        const sortNewest = (a, b) => String(b.resolvedAt).localeCompare(String(a.resolvedAt));
        const [tm, lm] = await Promise.all([
          jira(`${EPIC} AND resolutiondate >= "${thisMonthStart}" AND statusCategory = Done ORDER BY resolutiondate DESC`, flds, 100),
          jira(`${EPIC} AND resolutiondate >= "${lastMonthStart}" AND resolutiondate < "${thisMonthStart}" AND statusCategory = Done ORDER BY resolutiondate DESC`, flds, 100),
        ]);
        out.shipped = {
          thisMonthLabel: MONTHS[rn.getUTCMonth()] + " " + rn.getUTCFullYear(),
          lastMonthLabel: MONTHS[(rn.getUTCMonth() + 11) % 12] + " " + (rn.getUTCMonth() === 0 ? rn.getUTCFullYear() - 1 : rn.getUTCFullYear()),
          thisMonth: (tm.issues || []).map(map).sort(sortNewest),
          lastMonth: (lm.issues || []).map(map).sort(sortNewest),
        };
      }),

      // Lead (Discovery→Done) & Cycle (Ready for Development→Ready to Deploy), from changelog of epics done in the last 8 weeks.
      guard("history", async () => {
        const start8 = ymd(addDays(weekStart(nowRiyadh()), -7 * 8));
        const r = await jira(`${EPIC} AND statusCategory = Done AND resolutiondate >= "${start8}"`, ["resolutiondate", "created"], 100, "changelog");
        const leads = [], cycles = [];
        let fromCreated = 0;
        (r.issues || []).forEach((i) => {
          const resolved = i.fields.resolutiondate ? new Date(i.fields.resolutiondate) : null;
          const created = i.fields.created ? new Date(i.fields.created) : null;
          let discovery = firstTransitionTo(i, "Discovery");
          if (!discovery) { discovery = created; if (created) fromCreated++; }
          if (resolved && discovery) { const d = daysBetween(resolved, discovery); if (d >= 0) leads.push(d); }
          const rfd = firstTransitionTo(i, "Ready for Development");
          const rtd = firstTransitionTo(i, "Ready to Deploy");
          if (rfd && rtd) { const c = daysBetween(rtd, rfd); if (c >= 0) cycles.push(c); }
        });
        out.lead = { days: median(leads), n: leads.length, fromCreated };
        out.cycle = { days: median(cycles), n: cycles.length };
      }),

      // Open defects by status — one query per WIP+Rollout epic (parallel, capped), each guarded.
      guard("defects", async () => {
        // rollout epics may not be ready yet (parallel); read what's available.
        const rolloutEpics = (out.rollout && out.rollout.epics) || [];
        const keys = [];
        const seen = {};
        wipEpics.concat(rolloutEpics).forEach((e) => { if (!seen[e.key]) { seen[e.key] = 1; keys.push(e.key); } });
        const scan = keys.slice(0, DEFECT_CAP);
        const rows = await Promise.all(scan.map(async (key) => {
          try {
            const r = await jira(`parent = ${key} AND issuetype in (Bug, Defect)`, ["status"], 100);
            let open = 0, closed = 0, rejected = 0;
            (r.issues || []).forEach((b) => {
              const s = lc(b.fields.status && b.fields.status.name);
              if (s === "done") closed++;
              else if (s.indexOf("reject") > -1) rejected++;
              else open++;
            });
            return { key, open, closed, rejected, total: open + closed + rejected };
          } catch (e) {
            return { key, open: 0, closed: 0, rejected: 0, total: 0, error: true };
          }
        }));
        rows.sort((a, b) => b.open - a.open || b.total - a.total);
        out.defects = {
          scanned: scan.length,
          capped: keys.length > DEFECT_CAP,
          totalOpen: rows.reduce((a, r) => a + r.open, 0),
          epicsWithOpen: rows.filter((r) => r.open > 0).length,
          rows,
        };
      }),
    ]);

    send(res, 200, out);
  } catch (e) {
    send(res, 500, { error: "Unhandled: " + (e && e.message ? e.message : String(e)), stack: e && e.stack ? String(e.stack).split("\n").slice(0, 4) : undefined });
  }
};
