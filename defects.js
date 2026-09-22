// Client — fetches /api/defects (Jira, server-side) on load and on every Refresh
// click. Project chips filter in place without re-hitting Jira.
var BROWSE = "";
var PROJECTS = [];
var WINDOW = 90;
var ALL = [];
var sel = null; // Set of selected projects; null until first load
var DAY = 86400000;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
function issueLink(key, text) {
  return '<a href="' + BROWSE + "/browse/" + esc(key) + '" target="_blank" rel="noopener">' + esc(text == null ? key : text) + "</a>";
}
function setContent(html) { document.getElementById("content").innerHTML = html; }
function median(a) {
  if (!a.length) return null;
  var s = a.slice().sort(function (x, y) { return x - y; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function loadSel() {
  try { return JSON.parse(localStorage.getItem("coreDefectProjSel") || "null"); } catch (e) { return null; }
}
function persist() { try { localStorage.setItem("coreDefectProjSel", JSON.stringify([].concat.apply([], [Array.from(sel)]))); } catch (e) {} }

async function fetchDefects(timeoutMs) {
  var ctrl = new AbortController();
  var t = setTimeout(function () { ctrl.abort(); }, timeoutMs || 55000);
  try {
    var res = await fetch("/api/defects?_=" + Date.now(), { cache: "no-store", signal: ctrl.signal });
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
    try { data = await fetchDefects(55000); }
    catch (e) { lastErr = e; if (attempt === 0) setContent('<div class="loading">Waking the server, retrying&hellip;</div>'); }
  }

  if (data) {
    try {
      BROWSE = data.browseBase || "";
      PROJECTS = data.projects || PROJECTS;
      WINDOW = data.window || WINDOW;
      ALL = data.bugs || [];
      if (!sel) {
        var saved = loadSel();
        sel = new Set(saved && saved.length ? saved.filter(function (p) { return PROJECTS.indexOf(p) > -1; }) : PROJECTS);
        if (!sel.size) sel = new Set(PROJECTS);
      }
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

function kpiCard(label, value, meta, accent) {
  return '<div class="card ' + (accent || "") + '"><div class="label">' + esc(label) + "</div>" +
    '<div class="value">' + value + "</div>" +
    (meta ? '<div class="meta">' + esc(meta) + "</div>" : "") + "</div>";
}

function render(d) {
  var withinWindow = function (iso) { return iso && (Date.now() - new Date(iso).getTime()) <= (WINDOW + 1) * DAY; };
  var data = ALL.filter(function (b) { return sel.has(b.project); });
  var win = data.filter(function (b) { return withinWindow(b.created); });
  var open = data.filter(function (b) { return b.open; });
  var cnd = data.filter(function (b) { return b.closedNoDeploy; });
  var resolvedWin = data.filter(function (b) { return b.resDate ? withinWindow(b.resDate) : b.resolvedInWindow; });
  var med = median(resolvedWin.map(function (b) { return b.resDays; }).filter(function (x) { return x != null; }));
  var isHigh = function (b) { return b.priority === "Highest" || b.priority === "High"; };
  var hi = win.filter(isHigh).length;
  var viaDone = resolvedWin.filter(function (b) { return b.closedNoDeploy; }).length;
  var viaRTD = resolvedWin.length - viaDone;

  var html = "";

  // Optional data-quality banner.
  if (d.partial) {
    html += '<div class="warn">&#9888; Some Jira queries failed this run &mdash; the numbers below may be incomplete. Hit Refresh to retry.</div>';
  }

  // ---- Project filter chips ----
  html += '<div class="chips" id="chips">';
  html += '<span class="chip' + (sel.size === PROJECTS.length ? " on" : "") + '" data-proj="__all">All projects</span>';
  PROJECTS.forEach(function (p) {
    var on = sel.has(p) && sel.size !== PROJECTS.length;
    html += '<span class="chip' + (on ? " on" : "") + '" data-proj="' + esc(p) + '">' + esc(p) + "</span>";
  });
  html += "</div>";

  // ---- KPI cards ----
  html += '<div class="cards">';
  html += kpiCard("Created (90d)", win.length, "bugs opened in window", "accent-blue");
  html += kpiCard("Resolved (90d)", resolvedWin.length, viaRTD + " via RTD · " + viaDone + " done/rejected", "accent-green");
  html += kpiCard("Unresolved now", open.length, open.filter(isHigh).length + " high/highest", "accent-red");
  html += kpiCard("Median resolution", med != null ? (Math.round(med * 10) / 10) + "d" : "&mdash;", "created → RTD / Done", "accent-violet");
  html += kpiCard("Done w/o deploy", cnd.length, "counted as resolved", "accent-amber");
  html += kpiCard("High-priority share", win.length ? Math.round(100 * hi / win.length) + "%" : "&mdash;", "of created (90d)", "accent-teal");
  html += "</div>";

  // ---- Defects by epic / feature ----
  var byEpic = {};
  win.forEach(function (b) {
    var k = b.epicKey || (b.area ? "area:" + b.area : "(no epic / untagged)");
    if (!byEpic[k]) byEpic[k] = { key: b.epicKey, name: b.epic || b.area || "(no epic / untagged)", total: 0, open: 0, hi: 0 };
    byEpic[k].total++;
    if (b.open) byEpic[k].open++;
    if (isHigh(b)) byEpic[k].hi++;
  });
  var rows = Object.keys(byEpic).map(function (k) { return byEpic[k]; })
    .sort(function (a, b) { return b.total - a.total; }).slice(0, 15);
  var max = rows.length ? rows[0].total : 1;

  html += '<div class="panel" style="margin-bottom:16px"><h2>Defects by Epic / Feature <span class="muted">· created in the last ' + WINDOW + ' days</span></h2>' +
    '<p class="hint">Top 15 epics by bug count. Bar = share of the busiest epic.</p>' +
    '<div class="scroll"><table><thead><tr><th>Epic / Feature</th><th class="right">Defects</th><th></th><th class="right">Unresolved</th><th class="right">High+</th></tr></thead><tbody>';
  if (!rows.length) {
    html += '<tr><td colspan="5"><span class="muted">No bugs created in the window for the selected projects.</span></td></tr>';
  } else {
    rows.forEach(function (v) {
      var nameCell = v.key ? issueLink(v.key, v.name) + ' <small class="muted">(' + esc(v.key) + ")</small>" : esc(v.name);
      html += "<tr><td>" + nameCell + '</td>' +
        '<td class="right"><b>' + v.total + "</b></td>" +
        '<td style="width:30%"><span class="ebar" style="width:' + Math.round(100 * v.total / max) + '%"></span></td>' +
        '<td class="right">' + v.open + '</td><td class="right">' + v.hi + "</td></tr>";
    });
  }
  html += "</tbody></table></div></div>";

  // ---- Full bug list (window) ----
  var listRows = win.slice().sort(function (a, b) {
    return (b.open - a.open) || String(a.created).localeCompare(String(b.created)) * -1;
  });
  html += '<div class="panel" style="margin-bottom:16px"><h2>Bugs created in the window <span class="muted">(' + listRows.length + ')</span></h2>' +
    '<p class="hint">Newest and unresolved first. Resolution time is created → first Ready to Deploy (or Done for bugs that never passed RTD).</p>' +
    '<div class="scroll"><table><thead><tr><th>Bug</th><th>Summary</th><th>Priority</th><th>Status</th><th class="right">Age (d)</th><th class="right">Resolved in (d)</th></tr></thead><tbody>';
  if (!listRows.length) {
    html += '<tr><td colspan="6"><span class="muted">None.</span></td></tr>';
  } else {
    listRows.forEach(function (b) {
      var pc = "pri-" + String(b.priority).replace(/[^A-Za-z]/g, "");
      html += "<tr><td>" + issueLink(b.key) + "</td><td>" + esc(b.summary) + "</td>" +
        '<td><span class="pri ' + pc + '">' + esc(b.priority) + "</span></td>" +
        '<td><span class="pill">' + esc(b.status) + "</span></td>" +
        '<td class="right">' + b.ageDays + "</td>" +
        '<td class="right">' + (b.open ? '<span class="muted">open</span>' : (b.resDays == null ? '<span class="muted">&mdash;</span>' : b.resDays)) + "</td></tr>";
    });
  }
  html += "</tbody></table></div></div>";

  // ---- Footnote ----
  html += '<div class="foot">Median resolution = median days from created to resolved (first "Ready to Deploy" transition; for bugs that never passed RTD, the transition into their Done status). "Done w/o deploy" bugs are counted as resolved. Numbers are pulled live from webook.com Jira on each Refresh.</div>';

  setContent(html);

  // Wire up chip clicks.
  var chips = document.getElementById("chips");
  if (chips) {
    chips.addEventListener("click", function (ev) {
      var el = ev.target.closest(".chip");
      if (!el) return;
      var p = el.getAttribute("data-proj");
      if (p === "__all") sel = new Set(PROJECTS);
      else sel = new Set([p]);
      persist();
      render(d);
    });
  }
}

load();
