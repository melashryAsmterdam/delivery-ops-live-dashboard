// Client for the "Defects Analysis — Done / Closed epics" live page.
// Fetches /api/defects-epics (Jira, server-side) on load and on every Refresh.
var BROWSE = "";
var DATA = null;
var sortKey = "total";
var sortDir = -1;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
function issueLink(key, text) {
  return '<a href="' + BROWSE + "/browse/" + esc(key) + '" target="_blank" rel="noopener">' + esc(text == null ? key : text) + "</a>";
}
function setContent(html) { document.getElementById("content").innerHTML = html; }
function n1(x) { return x == null ? "—" : (Math.round(x * 10) / 10).toString(); }

async function fetchData(timeoutMs) {
  var ctrl = new AbortController();
  var t = setTimeout(function () { ctrl.abort(); }, timeoutMs || 55000);
  try {
    var res = await fetch("/api/defects-epics?_=" + Date.now(), { cache: "no-store", signal: ctrl.signal });
    if (res.status === 401) { window.location.replace("/login.html"); throw new Error("Not authenticated"); }
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
  setContent('<div class="loading">Loading live defect data from Jira&hellip;</div>');

  var data = null, lastErr = null;
  for (var attempt = 0; attempt < 2 && !data; attempt++) {
    try { data = await fetchData(55000); }
    catch (e) { lastErr = e; if (attempt === 0) setContent('<div class="loading">Waking the server, retrying&hellip;</div>'); }
  }

  if (data) {
    try {
      DATA = data;
      BROWSE = data.browseBase || "";
      render();
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

function kpiCard(label, value, meta, accent) {
  return '<div class="card ' + (accent || "") + '"><div class="label">' + esc(label) + "</div>" +
    '<div class="value">' + value + "</div>" +
    (meta ? '<div class="meta">' + meta + "</div>" : "") + "</div>";
}

function refinementPanel(d) {
  function block(title, b) {
    return '<div class="panel"><h2>' + esc(title) + "</h2>" +
      '<div class="value" style="font-size:22px;font-weight:680">' + n1(b.avg) + ' <span class="unit">avg defects / epic</span></div>' +
      '<div class="meta" style="margin-top:6px">' + b.epics + " epics · " + b.defects + " defects</div>" +
      '<div class="meta">' + b.open + " open · " + b.rejected + " rejected</div></div>";
  }
  return '<div class="grid2">' + block("Refined", d.refinement.refined) + block("DoR not met / unrefined", d.refinement.unrefined) + "</div>";
}

function sizePanel(d) {
  var cells = d.sizeBuckets.map(function (s) {
    return '<div class="sizecell"><span class="sl">' + esc(s.size) + " (" + s.epics + ')</span><span class="sv">' + n1(s.avg) + "</span></div>";
  }).join("");
  return '<div class="panel" style="margin-bottom:16px"><h2>Average defects by epic size <span class="muted">· defects / epic</span></h2>' +
    '<p class="hint">' + d.unsized + ' epics unsized.</p><div class="sizerow">' + cells + "</div></div>";
}

function resolutionPanel(d) {
  var rows = d.resolutionByTeam.map(function (t) {
    var strong = t.team === "All teams";
    return "<tr" + (strong ? ' style="font-weight:680"' : "") + "><td>" + esc(t.team) + '</td><td class="right">' + t.fixed +
      '</td><td class="right">' + n1(t.avgDays) + "</td></tr>";
  }).join("");
  return '<div class="panel" style="margin-bottom:16px"><h2>Bug resolution time · created &rarr; resolved <span class="muted">· fixed bugs only</span></h2>' +
    '<p class="hint">Fixed = Closed (Done, excluding Defect Rejected). Days = resolutiondate &minus; created, weighted by bug. Core includes the legacy LIF project.</p>' +
    '<div class="scroll"><table><thead><tr><th>Team</th><th class="right">Fixed bugs</th><th class="right">Avg days</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="3"><span class="muted">No fixed bugs in the window.</span></td></tr>') + "</tbody></table></div></div>";
}

function openPanel(d) {
  if (!d.openEpics.length) {
    return '<div class="panel" style="margin-bottom:16px"><h2>Open defects on shipped epics</h2>' +
      '<p class="hint"><span class="muted">None — every scanned Done/Closed epic has its defects resolved.</span></p></div>';
  }
  var rows = d.openEpics.map(function (e) {
    var byStatus = Object.keys(e.openByStatus).map(function (s) {
      return esc(s) + " ×" + e.openByStatus[s];
    }).join(", ");
    return "<tr><td>" + issueLink(e.key) + "</td><td>" + esc(e.summary) + '</td><td><span class="pill">' + esc(e.status) +
      '</span></td><td class="right"><b>' + e.open + "</b></td><td>" + byStatus + "</td></tr>";
  }).join("");
  return '<div class="panel" style="margin-bottom:16px"><h2>Open defects on shipped epics <span class="muted">(' + d.totalOpen + " across " + d.openEpics.length + ' epics)</span></h2>' +
    '<p class="hint">Done / Closed epics that still carry at least one unresolved defect.</p>' +
    '<div class="scroll"><table><thead><tr><th>Epic</th><th>Summary</th><th>Status</th><th class="right">Open</th><th>By status</th></tr></thead><tbody>' +
    rows + "</tbody></table></div></div>";
}

function epicTable(d) {
  var rows = d.epics.slice();
  rows.sort(function (a, b) {
    var av = a[sortKey], bv = b[sortKey];
    if (typeof av === "string") { av = av || ""; bv = bv || ""; return sortDir * av.localeCompare(bv); }
    return sortDir * ((av || 0) - (bv || 0));
  });
  var max = rows.reduce(function (m, r) { return Math.max(m, r.total); }, 1);
  function th(key, label, right) {
    var arrow = sortKey === key ? (sortDir < 0 ? " ↓" : " ↑") : "";
    return '<th class="sortable' + (right ? " right" : "") + '" data-k="' + key + '">' + esc(label) + arrow + "</th>";
  }
  var body = rows.map(function (r) {
    return "<tr><td>" + issueLink(r.key) + "</td><td>" + esc(r.summary) + '</td>' +
      '<td><span class="pill">' + esc(r.status) + "</span></td>" +
      "<td>" + esc(r.team) + "</td><td>" + esc(r.dri) + "</td>" +
      "<td>" + esc(r.size || "—") + "</td>" +
      "<td>" + (r.refined ? "Refined" : "Unrefined") + "</td>" +
      '<td class="right">' + r.open + '</td><td class="right">' + r.closed + '</td><td class="right">' + r.rejected + "</td>" +
      '<td class="right"><b>' + r.total + '</b> <span class="ebar" style="width:' + Math.round(40 * r.total / max) + 'px"></span></td></tr>';
  }).join("");
  return '<div class="panel" style="margin-bottom:16px"><h2>Bugs per epic <span class="muted">(' + rows.length + ' scanned · click a header to sort)</span></h2>' +
    '<p class="hint">Child bugs/defects of every scanned Done/Closed epic. Rejected (Defect Rejected) is excluded from Closed; Total = Open + Closed + Rejected.</p>' +
    '<div class="scroll" style="max-height:520px"><table><thead><tr>' +
    th("key", "Epic") + th("summary", "Summary") + th("status", "Status") + th("team", "Team") + th("dri", "DRI") +
    th("size", "Size") + th("refined", "Refinement") + th("open", "Open", true) + th("closed", "Closed", true) +
    th("rejected", "Rejected", true) + th("total", "Total", true) +
    "</tr></thead><tbody>" + body + "</tbody></table></div></div>";
}

function render() {
  var d = DATA;
  var html = "";
  if (d.partial) {
    html += '<div class="warn">&#9888; Some Jira queries failed this run &mdash; the numbers below may be incomplete. Hit Refresh to retry.</div>';
  }

  // KPI row.
  html += '<div class="cards">';
  html += kpiCard("Total defects", d.totalDefects, "on " + d.scannedEpics + " scanned epics", "accent-blue");
  html += kpiCard("Still open", d.totalOpen, "on shipped epics", "accent-red");
  html += kpiCard("Epics scanned", d.scannedEpics + " / " + d.matchedEpics, d.beyondCap + " beyond cap", "accent-violet");
  html += kpiCard("Refined / Unref.", d.refinement.refined.epics + " / " + d.refinement.unrefined.epics, "by DoR-family labels", "accent-teal");
  var core = (d.resolutionByTeam.filter(function (t) { return t.team === "All teams"; })[0]) || null;
  html += kpiCard("Avg resolution", core ? n1(core.avgDays) + "d" : "—", "created → resolved, all teams", "accent-amber");
  html += kpiCard("Fixed bugs", core ? core.fixed : 0, "counted in resolution time", "accent-green");
  html += "</div>";

  html += refinementPanel(d);
  html += sizePanel(d);
  html += resolutionPanel(d);
  html += openPanel(d);
  html += epicTable(d);

  html += '<div class="foot">Scope: epics Done/Closed with resolutiondate on or after ' + esc(d.since) +
    ' across CBPC · CSD · CHOL · CR · CCS · LTRF · ESL · INCEN · RECO · FAN. ' + d.matchedEpics +
    ' epics match; the ' + d.scannedEpics + ' most recently resolved are scanned (' + d.beyondCap +
    ' beyond the cap). Refined = epic carries a DoR-family label. Numbers pulled live from webook.com Jira on each Refresh.</div>';

  setContent(html);

  var head = document.querySelector("#content thead");
  if (head) {
    head.addEventListener("click", function (ev) {
      var th = ev.target.closest(".sortable");
      if (!th) return;
      var k = th.getAttribute("data-k");
      if (sortKey === k) sortDir = -sortDir;
      else { sortKey = k; sortDir = (k === "key" || k === "summary" || k === "team" || k === "dri") ? 1 : -1; }
      render();
    });
  }
}

load();
