// Vercel serverless function — computes live Weekly Delivery Operations metrics
// straight from webook.com Jira, server-side (credentials never reach the browser).
//
// Required environment variables (set in Vercel → Project → Settings → Environment Variables):
//   JIRA_BASE_URL   e.g. https://webookcom.atlassian.net
//   JIRA_EMAIL      the Atlassian account email the API token belongs to
//   JIRA_API_TOKEN  an Atlassian API token (id.atlassian.com → Security → API tokens)

const PROJECTS = ["CBPC", "CSD", "CHOL", "CR", "CCS", "LTRF", "ESL", "INCEN", "RECO", "FAN"];
const TEAM = {
  CBPC: "Core", CSD: "Core", CHOL: "Core", CR: "Core", CCS: "Core",
  LTRF: "Labs",
  ESL: "Eco", INCEN: "Eco", RECO: "Eco", FAN: "Eco",
};
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

const projList = PROJECTS.join(", ");
const quoted = (arr) => arr.map((s) => '"' + s + '"').join(", ");
const teamOf = (key) => TEAM[String(key).split("-")[0]] || "Other";

// Respond with raw Node http methods only, so we never depend on framework
// helpers (res.status/res.json) that may be absent in some runtimes.
function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function authHeader() {
  const email = process.env.JIRA_EMAIL || "";
  const token = process.env.JIRA_API_TOKEN || "";
  return "Basic " + Buffer.from(email + ":" + token).toString("base64");
}
function baseUrl() {
  return (process.env.JIRA_BASE_URL || "").replace(/\/+$/, "");
}

async function jiraFetch(path, body) {
  if (typeof fetch !== "function") throw new Error("global fetch unavailable (needs Node 18+)");
  const res = await fetch(baseUrl() + path, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Jira " + res.status + " — " + text.slice(0, 300));
  }
  return res.json();
}
// New Jira Cloud search (CHANGE-2046): /rest/api/3/search/jql returns issues (no total);
// counts come from the dedicated approximate-count endpoint.
async function jira(jql, fields, maxResults) {
  return jiraFetch("/rest/api/3/search/jql", { jql, maxResults: maxResults == null ? 100 : maxResults, fields: fields || [] });
}
async function countOf(jql) {
  const j = await jiraFetch("/rest/api/3/search/approximate-count", { jql });
  return j && typeof j.count === "number" ? j.count : 0;
}

// ---- Sunday-anchored weeks in Asia/Riyadh (UTC+3), day-precision ----
const OFFSET_MS = 3 * 3600 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function nowRiyadh() { return new Date(Date.now() + OFFSET_MS); }
function weekStart(d) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() - x.getUTCDay());
  x.setUTCHours(0, 0, 0, 0);
  return x;
}
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function ymd(d) { return d.toISOString().slice(0, 10); }
function weekLabel(d) { return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()]; }
function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

module.exports = async (req, res) => {
  try {
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

    // WIP — one search, drives the KPI, the by-status chart, the by-team roll-up and the table.
    await guard("wip", async () => {
      const r = await jira(`${EPIC} AND status in (${quoted(WIP_STATUSES)}) ORDER BY status ASC`, ["summary", "status"], 100);
      const issues = r.issues || [];
      const byStatus = WIP_STATUSES.map((s) => ({
        status: s,
        color: WIP_COLORS[s],
        count: issues.filter((i) => (((i.fields.status && i.fields.status.name) || "").toLowerCase() === s.toLowerCase())).length,
      }));
      const byTeam = {};
      const epics = issues.map((i) => {
        const team = teamOf(i.key);
        byTeam[team] = byTeam[team] || { wip: 0, blocked: 0 };
        byTeam[team].wip++;
        return { key: i.key, summary: i.fields.summary, status: i.fields.status.name, team };
      });
      out.wip = { total: issues.length, byStatus, byTeam, epics };
    });

    // Everything below runs concurrently to stay well under the function timeout.
    // (blockers reads out.wip.byTeam, which is already populated by the awaited WIP step above.)
    await Promise.all([
      guard("pipeline", async () => {
        out.pipeline = { total: await countOf(`${EPIC} AND status in (${quoted(PIPELINE_STATUSES)})`) };
      }),
      guard("rollout", async () => {
        const r = await jira(`${EPIC} AND status in (${quoted(ROLLOUT_STATUSES)}) ORDER BY status ASC`, ["summary", "status"], 100);
        const epics = (r.issues || []).map((i) => ({ key: i.key, summary: i.fields.summary, status: i.fields.status.name, team: teamOf(i.key) }));
        out.rollout = { total: epics.length, epics };
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
        for (let i = 7; i >= 0; i--) {
          const start = addDays(curStart, -7 * i);
          const end = addDays(start, 7);
          weeks.push({ start, end });
        }
        const values = await Promise.all(
          weeks.map((w) => countOf(`${EPIC} AND status CHANGED TO "Done" DURING ("${ymd(w.start)}", "${ymd(w.end)}")`))
        );
        out.throughput = {
          labels: weeks.map((w) => weekLabel(w.start)),
          values,
          median: median(values.slice(0, 7)),
        };
        out.shippedThisWeek = values[values.length - 1];
      }),
    ]);

    send(res, 200, out);
  } catch (e) {
    // Never crash the invocation — surface the reason as readable JSON.
    send(res, 500, { error: "Unhandled: " + (e && e.message ? e.message : String(e)), stack: e && e.stack ? String(e.stack).split("\n").slice(0, 4) : undefined });
  }
};
