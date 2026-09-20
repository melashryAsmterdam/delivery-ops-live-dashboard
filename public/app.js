// Client — fetches /api/metrics (Jira, server-side) on load and on every Refresh click.
var BROWSE = "";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
function issueLink(key) {
  return '<a href="' + BROWSE + "/browse/" + esc(key) + '" target="_blank" rel="noopener">' + esc(key) + "</a>";
}
function setContent(html) { document.getElementById("content").innerHTML = html; }
function pct(n, max) { return max > 0 ? (n / max * 100) : 0; }

async function fetchMetrics(timeoutMs) {
  var ctrl = new AbortController();
  var t = setTimeout(function () { ctrl.abort(); }, timeoutMs || 40000);
  try {
    var res = await fetch("/api/metrics?_=" + Date.now(), { cache: "no-store", signal: ctrl.signal });
    var data = await res.json().catch(function () { return null; });
    if (!res.ok) throw new Error(data && data.error ? data.error : "Request failed (" + res.status + ")");
    if (!data) throw new Error("Empty response from server");
    return data;
  } finally { clearTimeout(t); }
}

async function load() {
  var btn = document.getElementById("refreshBtn");
  btn.classList.add("loading");
  btn.disabled = true;
  document.getElementById("errbox").innerHTML = "";
  setContent('<div class="loading">Loading live data from Jira…</div>');

  var data = null, lastErr = null;
  for (var attempt = 0; attempt < 2 && !data; attempt++) {
    try { data = await fetchMetrics(40000); }
    catch (e) { lastErr = e; if (attempt === 0) setContent('<div class="loading">Waking the server, retrying…</div>'); }
  }

  if (data) {
    try {
      BROWSE = data.browseBase || "";
      render(data);
      var ts = new Date(data.generatedAt);
      document.getElementById("refreshed").textContent =
        "Refreshed " + ts.toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
    } catch (e) {
      setContent('<div class="err"><b>Loaded, but failed to render.</b> ' + esc(e.message) + "</div>");
    }
  } else {
    setContent('<div class="err"><b>Could not load from Jira.</b> ' + esc(lastErr ? lastErr.message : "Unknown error") +
      ' <button class="refresh" style="margin-left:10px" onclick="load()">Retry</button></div>');
  }
  btn.classList.remove("loading");
  btn.disabled = false;
}

function card(cls, label, value, unit, meta) {
  return '<div class="card ' + cls + '"><div class="label">' + esc(label) + "</div>" +
    '<div class="value">' + value + (unit ? ' <span class="unit">' + esc(unit) + "</span>" : "") + "</div>" +
    (meta ? '<div class="meta">' + meta + "</div>" : "") + "</div>";
}

function epicTable(epics, withTeam) {
  epics = epics || [];
  if (!epics.length) return '<p class="muted" style="padding:8px">None.</p>';
  var h = "<table><thead><tr><th>Epic</th><th>Summary</th><th>Status</th>" + (withTeam ? "<th>Team</th>" : "") + "</tr></thead><tbody>";
  epics.forEach(function (e) {
    h += "<tr><td>" + issueLink(e.key) + "</td><td>" + esc(e.summary) + "</td>" +
      '<td><span class="pill">' + esc(e.status) + "</span></td>" + (withTeam ? "<td>" + esc(e.team) + "</td>" : "") + "</tr>";
  });
  return h + "</tbody></table>";
}

function shippedTable(rows) {
  rows = rows || [];
  if (!rows.length) return '<p class="muted" style="padding:8px">None.</p>';
  var h = "<table><thead><tr><th>Key</th><th>Summary</th><th>Release</th><th>Size</th><th class=\"right\">Done</th></tr></thead><tbody>";
  rows.forEach(function (e) {
    h += "<tr><td>" + issueLink(e.key) + "</td><td>" + esc(e.summary) + "</td>" +
      "<td>" + (e.release ? '<span class="pill gray">' + esc(e.release) + "</span>" : '<span class="muted">—</span>') + "</td>" +
      "<td>" + (e.size ? '<span class="pill">' + esc(e.size) + "</span>" : '<span class="muted">—</span>') + "</td>" +
      '<td class="right">' + esc(e.resolved || "") + "</td></tr>";
  });
  return h + "</tbody></table>";
}

function render(d) {
  var wip = d.wip || { total: 0, byStatus: [], byTeam: {}, epics: [] };
  var pipeline = d.pipeline || { total: 0, epics: [] };
  var rollout = d.rollout || { total: 0, epics: [] };
  var blockers = d.blockers || { total: 0, epics: [] };
  var thr = d.throughput || { labels: [], values: [], median: null };
  var lead = d.lead || {};
  var cycle = d.cycle || {};
  var shipped = d.shipped || { thisMonth: [], lastMonth: [], thisMonthLabel: "This month", lastMonthLabel: "Last month" };
  var defects = d.defects || { rows: [], scanned: 0, totalOpen: 0, epicsWithOpen: 0 };

  var html = "";

  // ---- KPI cards ----
  html += '<div class="cards">';
  html += card("accent-blue", "Throughput", thr.median == null ? "—" : thr.median, "/wk median", "median of 7 completed wks");
  html += card("accent-teal", "WIP", wip.total, "epics", (wip.byStatus || []).length + " active statuses");
  html += card("accent-green", "Lead Time", lead.days == null ? "—" : lead.days, "d",
    "Discovery → Done" + (lead.n ? " · n=" + lead.n : "") + (lead.fromCreated ? " · " + lead.fromCreated + " from created" : ""));
  html += card("accent-violet", "Cycle Time", cycle.days == null ? "—" : cycle.days, "d",
    "Ready for Dev → Ready to Deploy" + (cycle.n ? " · n=" + cycle.n : ""));
  html += card("accent-red", "Blockers", blockers.total, "", "flagged or blocked label");
  html += card("accent-amber", "Shipped", d.shippedThisWeek == null ? "—" : d.shippedThisWeek, "this wk", "epics to Done");
  html += "</div>";

  html += '<div class="ministats">' +
    '<div class="ministat"><span class="ml">Pipeline (pre-dev)</span><span class="mv">' + pipeline.total + "</span></div>" +
    '<div class="ministat"><span class="ml">Rollout</span><span class="mv">' + rollout.total + "</span></div>" +
    '<div class="ministat"><span class="ml">Open defects</span><span class="mv">' + (defects.totalOpen || 0) + "</span></div>" +
    "</div>";

  // ---- Pipeline (Discovery band) ----
  html += '<div class="panel" style="margin-bottom:16px"><h2>Pipeline <span class="muted">· pre-development (' + pipeline.total + ')</span></h2>' +
    '<p class="hint">Epics in <b>Discovery</b>, <b>Three Amigos Alignment</b>, or <b>Solution Design</b> — before active development.</p>' +
    '<div class="scroll">' + epicTable(pipeline.epics, true) + "</div></div>";

  // ---- Closed / shipped epics ----
  html += '<div class="panel" style="margin-bottom:16px"><h2>Closed / shipped epics</h2>' +
    '<p class="hint">Epics resolved into <b>Done</b>, grouped by month. Newest first.</p>' +
    '<div class="mrow"><div><div class="mhdr">' + esc(shipped.thisMonthLabel) + ' <span class="muted">(' + (shipped.thisMonth || []).length + ')</span></div>' +
    '<div class="scroll">' + shippedTable(shipped.thisMonth) + "</div></div>" +
    '<div><div class="mhdr">' + esc(shipped.lastMonthLabel) + ' <span class="muted">(' + (shipped.lastMonth || []).length + ')</span></div>' +
    '<div class="scroll">' + shippedTable(shipped.lastMonth) + "</div></div></div></div>";

  // ---- WIP by status + WIP by team ----
  html += '<div class="grid2">';
  html += '<div class="panel"><h2>WIP by status <span class="muted">· epics</span></h2>' +
    '<p class="hint">Active-development band: Ready for Development → Blocked - Bug Fixing.</p>';
  var maxWip = Math.max.apply(null, [1].concat((wip.byStatus || []).map(function (s) { return s.count; })));
  html += '<div class="bars">';
  (wip.byStatus || []).forEach(function (s) {
    html += '<div class="bar"><span class="name">' + esc(s.status) + "</span>" +
      '<div class="track"><div class="fill" style="width:' + pct(s.count, maxWip) + "%;background:" + s.color + '"></div></div>' +
      '<span class="cnt" style="color:' + s.color + '">' + s.count + "</span></div>";
  });
  html += "</div>";
  // per-status epic keys
  html += '<div class="keys">';
  (wip.byStatus || []).forEach(function (s) {
    html += '<div class="krow"><span class="klbl"><span class="kdot" style="background:' + s.color + '"></span>' + esc(s.status) + "</span><span class=\"kk\">" +
      (s.keys && s.keys.length ? s.keys.map(issueLink).join(", ") : '<span class="muted">none</span>') + "</span></div>";
  });
  html += "</div></div>";

  html += '<div class="panel"><h2>Work in progress by team</h2>' +
    '<p class="hint">Core = CBPC·CSD·CHOL·CR·CCS · Labs = LTRF · Eco = ESL·INCEN·RECO·FAN.</p>' +
    '<table><thead><tr><th>Team</th><th class="right">WIP</th><th class="right">Done (wk)</th><th class="right">Blocked</th></tr></thead><tbody>';
  ["Core", "Labs", "Eco"].forEach(function (t) {
    var b = (wip.byTeam && wip.byTeam[t]) || { wip: 0, done: 0, blocked: 0 };
    html += "<tr><td><b>" + t + "</b></td><td class=\"right\">" + b.wip + '</td><td class="right">' + b.done + '</td><td class="right">' +
      (b.blocked ? '<span class="pill amber">' + b.blocked + "</span>" : "0") + "</td></tr>";
  });
  html += "</tbody></table></div>";
  html += "</div>";

  // ---- Epics in progress + Rollout ----
  html += '<div class="grid2">';
  html += '<div class="panel"><h2>Epics in progress <span class="muted">(' + wip.total + ')</span></h2>' +
    '<div class="scroll">' + epicTable(wip.epics, true) + "</div></div>";
  html += '<div class="panel"><h2>Rollout <span class="muted">(' + rollout.total + ')</span></h2>' +
    '<div class="scroll">' + epicTable(rollout.epics, true) + "</div></div>";
  html += "</div>";

  // ---- Bug fixing + Blockers ----
  var bugFix = (wip.epics || []).filter(function (e) { return String(e.status || "").toLowerCase() === "blocked - bug fixing"; });
  html += '<div class="grid2">';
  html += '<div class="panel"><h2>Bug Fixing <span class="muted">(' + bugFix.length + ')</span></h2>' +
    '<p class="hint">Epics currently in <b>Blocked - Bug Fixing</b>.</p>' +
    '<div class="scroll">' + epicTable(bugFix, true) + "</div></div>";
  html += '<div class="panel"><h2>Blockers <span class="muted">(' + blockers.total + ')</span></h2>' +
    '<p class="hint">Epics not Done that are flagged as Impediment or carry a "blocked" label.</p>' +
    '<div class="scroll">' + epicTable(blockers.epics, true) + "</div></div>";
  html += "</div>";

  // ---- Throughput ----
  html += '<div class="panel" style="margin-bottom:16px"><h2>Throughput <span class="muted">· epics done / week</span></h2>' +
    '<p class="hint">Last 8 Sunday-anchored weeks. The last bar is the current (partial) week.</p>';
  var maxThr = Math.max.apply(null, [1].concat(thr.values || []));
  html += '<div class="tbar">';
  (thr.values || []).forEach(function (v, i) {
    var cur = i === thr.values.length - 1;
    html += '<div class="col' + (cur ? " cur" : "") + '"><span class="n">' + v + "</span>" +
      '<div class="b" style="height:' + pct(v, maxThr) + '%"></div><span class="l">' + esc((thr.labels || [])[i] || "") + "</span></div>";
  });
  html += "</div></div>";

  // ---- Open defects by status ----
  html += '<div class="panel" style="margin-bottom:16px"><h2>Open defects by epic</h2>' +
    '<p class="hint">Bugs/defects under each WIP + Rollout epic (up to ' + (defects.scanned || 0) + ' scanned). ' +
    "<b>" + (defects.totalOpen || 0) + "</b> open across <b>" + (defects.epicsWithOpen || 0) + "</b> epic(s)." +
    (defects.capped ? " List capped." : "") + "</p>";
  var withDefects = (defects.rows || []).filter(function (r) { return r.total > 0; });
  if (!withDefects.length) {
    html += '<p class="muted" style="padding:8px">No bugs/defects found on the scanned epics.</p>';
  } else {
    var maxTot = Math.max.apply(null, [1].concat(withDefects.map(function (r) { return r.total; })));
    html += '<div class="stack">';
    withDefects.forEach(function (r) {
      html += '<div class="srow"><span class="sk">' + issueLink(r.key) + "</span><div class=\"sbar\" style=\"width:" + pct(r.total, maxTot) + '%">' +
        (r.open ? '<span class="seg" style="flex:' + r.open + ';background:#dc2626" title="Open: ' + r.open + '">' + r.open + "</span>" : "") +
        (r.closed ? '<span class="seg" style="flex:' + r.closed + ';background:#16a34a" title="Closed: ' + r.closed + '">' + r.closed + "</span>" : "") +
        (r.rejected ? '<span class="seg" style="flex:' + r.rejected + ';background:#9ca3af" title="Rejected: ' + r.rejected + '">' + r.rejected + "</span>" : "") +
        "</div><span class=\"stot\">" + r.total + "</span></div>";
    });
    html += "</div>";
    html += '<div class="legend"><span class="lg"><span class="lgdot" style="background:#dc2626"></span>Open</span>' +
      '<span class="lg"><span class="lgdot" style="background:#16a34a"></span>Closed</span>' +
      '<span class="lg"><span class="lgdot" style="background:#9ca3af"></span>Rejected</span></div>';
  }
  // full defect table
  html += '<div class="mhdr" style="margin-top:16px">Defects per epic</div>';
  html += '<div class="scroll"><table><thead><tr><th>Epic</th><th class="right">Open</th><th class="right">Closed</th><th class="right">Rejected</th><th class="right">Total</th></tr></thead><tbody>';
  (defects.rows || []).forEach(function (r) {
    html += "<tr><td>" + issueLink(r.key) + '</td><td class="right">' + (r.open ? '<b style="color:#dc2626">' + r.open + "</b>" : "0") +
      '</td><td class="right">' + r.closed + '</td><td class="right">' + r.rejected + '</td><td class="right">' + r.total + "</td></tr>";
  });
  html += "</tbody></table></div></div>";

  if (d.errors && d.errors.length) {
    html = '<div class="err">Some sections could not be computed this run: ' + esc(d.errors.join(" · ")) + "</div>" + html;
  }

  setContent(html);
}

load();
