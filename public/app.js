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

// Fetch with an abort timeout so a slow cold start can't hang the page forever.
async function fetchMetrics(timeoutMs) {
  var ctrl = new AbortController();
  var t = setTimeout(function () { ctrl.abort(); }, timeoutMs || 30000);
  try {
    var res = await fetch("/api/metrics?_=" + Date.now(), { cache: "no-store", signal: ctrl.signal });
    var data = await res.json().catch(function () { return null; });
    if (!res.ok) throw new Error(data && data.error ? data.error : "Request failed (" + res.status + ")");
    if (!data) throw new Error("Empty response from server");
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function load() {
  var btn = document.getElementById("refreshBtn");
  btn.classList.add("loading");
  btn.disabled = true;
  document.getElementById("errbox").innerHTML = "";
  setContent('<div class="loading">Loading live data from Jira…</div>');

  var data = null, lastErr = null;
  // Two attempts — the first request may cold-start the serverless function.
  for (var attempt = 0; attempt < 2 && !data; attempt++) {
    try {
      data = await fetchMetrics(30000);
    } catch (e) {
      lastErr = e;
      if (attempt === 0) setContent('<div class="loading">Waking the server, retrying…</div>');
    }
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
    setContent(
      '<div class="err"><b>Could not load from Jira.</b> ' +
      esc(lastErr ? lastErr.message : "Unknown error") +
      ' <button class="refresh" style="margin-left:10px" onclick="load()">Retry</button></div>'
    );
  }

  btn.classList.remove("loading");
  btn.disabled = false;
}

function card(cls, label, value, unit, meta) {
  return (
    '<div class="card ' + cls + '"><div class="label">' + esc(label) + "</div>" +
    '<div class="value">' + value + (unit ? ' <span class="unit">' + esc(unit) + "</span>" : "") + "</div>" +
    (meta ? '<div class="meta">' + meta + "</div>" : "") +
    "</div>"
  );
}

function render(d) {
  var wip = d.wip || { total: 0, byStatus: [], byTeam: {}, epics: [] };
  var pipeline = d.pipeline || { total: 0 };
  var rollout = d.rollout || { total: 0, epics: [] };
  var blockers = d.blockers || { total: 0, epics: [] };
  var thr = d.throughput || { labels: [], values: [], median: null };

  var html = "";

  // KPI cards
  html += '<div class="cards">';
  html += card("accent-blue", "Throughput", thr.median == null ? "—" : thr.median, "/wk median", "8-week median");
  html += card("accent-teal", "WIP", wip.total, "epics", (wip.byStatus || []).length + " active statuses");
  html += card("accent-violet", "Pipeline", pipeline.total, "epics", "Discovery → Solution Design");
  html += card("accent-green", "Rollout", rollout.total, "epics", "Ready to Deploy / A/B");
  html += card("accent-red", "Blockers", blockers.total, "", "flagged or blocked label");
  html += card("accent-amber", "Shipped", d.shippedThisWeek == null ? "—" : d.shippedThisWeek, "this wk", "epics to Done");
  html += "</div>";

  // WIP by status + Throughput
  html += '<div class="grid2">';
  html += '<div class="panel"><h2>WIP by status <span class="muted">· epics</span></h2>' +
    '<p class="hint">Active-development band: Ready for Development → Blocked - Bug Fixing.</p>';
  var maxWip = Math.max.apply(null, [1].concat((wip.byStatus || []).map(function (s) { return s.count; })));
  html += '<div class="bars">';
  (wip.byStatus || []).forEach(function (s) {
    html += '<div class="bar"><span class="name">' + esc(s.status) + "</span>" +
      '<div class="track"><div class="fill" style="width:' + (s.count / maxWip * 100) + "%;background:" + s.color + '"></div></div>' +
      '<span class="cnt" style="color:' + s.color + '">' + s.count + "</span></div>";
  });
  html += "</div></div>";

  html += '<div class="panel"><h2>Throughput <span class="muted">· epics done / week</span></h2>' +
    '<p class="hint">Last 8 Sunday-anchored weeks. The last bar is the current (partial) week.</p>';
  var maxThr = Math.max.apply(null, [1].concat(thr.values || []));
  html += '<div class="tbar">';
  (thr.values || []).forEach(function (v, i) {
    var cur = i === thr.values.length - 1;
    html += '<div class="col' + (cur ? " cur" : "") + '"><span class="n">' + v + "</span>" +
      '<div class="b" style="height:' + (v / maxThr * 100) + '%"></div>' +
      '<span class="l">' + esc((thr.labels || [])[i] || "") + "</span></div>";
  });
  html += "</div></div>";
  html += "</div>";

  // In progress + Rollout tables
  html += '<div class="grid2">';
  html += '<div class="panel"><h2>Epics in progress <span class="muted">(' + wip.total + ')</span></h2>' +
    '<div class="scroll">' + epicTable(wip.epics, true) + "</div></div>";
  html += '<div class="panel"><h2>Rollout <span class="muted">(' + rollout.total + ')</span></h2>' +
    '<div class="scroll">' + epicTable(rollout.epics, true) + "</div></div>";
  html += "</div>";

  // Blockers
  html += '<div class="panel full"><h2>Blockers <span class="muted">(' + blockers.total + ')</span></h2>' +
    '<p class="hint">Epics not Done that are flagged as Impediment or carry a "blocked" label.</p>' +
    '<div class="scroll">' + epicTable(blockers.epics, true) + "</div></div>";

  if (d.errors && d.errors.length) {
    html =
      '<div class="err">Some sections could not be computed this run: ' +
      esc(d.errors.join(" · ")) + "</div>" + html;
  }

  setContent(html);
}

function epicTable(epics, withTeam) {
  epics = epics || [];
  if (!epics.length) return '<p class="muted" style="padding:8px">None.</p>';
  var h = "<table><thead><tr><th>Epic</th><th>Summary</th><th>Status</th>" +
    (withTeam ? "<th>Team</th>" : "") + "</tr></thead><tbody>";
  epics.forEach(function (e) {
    h += "<tr><td>" + issueLink(e.key) + "</td><td>" + esc(e.summary) + "</td>" +
      '<td><span class="pill">' + esc(e.status) + "</span></td>" +
      (withTeam ? "<td>" + esc(e.team) + "</td>" : "") + "</tr>";
  });
  return h + "</tbody></table>";
}

load();
