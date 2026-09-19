// Client â€” fetches /api/metrics (Jira, server-side) on load and on every Refresh click.
var BROWSE = "";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
function issueLink(key) {
  return '<a href="' + BROWSE + "/browse/" + esc(key) + '" target="_blank" rel="noopener">' + esc(key) + "</a>";
}

async function load(isRefresh) {
  var btn = document.getElementById("refreshBtn");
  btn.classList.add("loading");
  btn.disabled = true;
  document.getElementById("errbox").innerHTML = "";
  try {
    var res = await fetch("/api/metrics", { cache: "no-store" });
    var data = await res.json();
    if (!res.ok) throw new Error(data && data.error ? data.error : "Request failed (" + res.status + ")");
    BROWSE = data.browseBase || "";
    render(data);
    var t = new Date(data.generatedAt);
    document.getElementById("refreshed").textContent =
      "Refreshed " + t.toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
  } catch (e) {
    document.getElementById("errbox").innerHTML =
      '<div class="err"><b>Could not load from Jira.</b> ' + esc(e.message) +
      "</div>";
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
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
  html += card("accent-blue", "Throughput", thr.median == null ? "â€”" : thr.median, "/wk median", "8-week median");
  html += card("accent-team", "WIP", wip.total, "epics", ((wip.byStatus || []).length + " active statuses");
  html += card("accent-violet", "Pipeline", pipeline.total, "epics", "Discovery â†’ Solution Design");
  html += card("accent-green", "Rollout", rollout.total, "epics", "Ready to Deploy / A/B");
  html += card("accent-red", "Blockers", blockers.total, "", "flagged or blocked label");
  html += card("accent-amber", "Shipped", d.shippedThisWeek == null ? "â€”" : d.shippedThisWeZÈ‹\ÈÚÈ‹™\XÜÈÈÛ™HŠNÂˆ[
ÏHÙ]ˆÂ‚ˆËÈÒT˜Hİ]\È
È›İYÚ]ˆ[
ÏH	Ï]ˆÛ\ÜÏH™ÜšYˆ‰ÎÂˆ[
ÏH	Ï]ˆÛ\ÜÏHœ[™[•ÒTHİ]\ÈÜ[ˆÛ\ÜÏH›]]Y°­È\XÜÏÜÜ[Ú‰È
Âˆ	ÏÛ\ÜÏHš[Xİ]™KY]™[ÜY[˜[™ˆ™XYH›Üˆ]™[ÜY[8¡¤ˆ›ØÚÙYHYÈš^[™ËÜ‰ÎÂˆ˜\ˆX^Ú\HX]›X^˜\J[ÌWK˜ÛÛ˜Ø]

Ú\˜Tİ]\È×JK›X\
[˜İ[Ûˆ
ÊHÈ™]\›ˆË˜Ûİ[ÈJJJNÂˆ[
ÏH	Ï]ˆÛ\ÜÏH˜˜\œÈ‰ÎÂˆ
Ú\˜Tİ]\È×JK™›Ü‘XXÚ
[˜İ[Ûˆ
ÊHÂˆ[
ÏH	Ï]ˆÛ\ÜÏH˜˜\ˆÜ[ˆÛ\ÜÏH›˜[YH‰È
È\ØÊËœİ]\ÊH
ÈÜÜ[ˆˆ
Âˆ	Ï]ˆÛ\ÜÏH˜XÚÈ]ˆÛ\ÜÏH™š[ˆİ[OHÚY‰È
È
Ë˜Ûİ[ÈX^Ú\
ˆL
H
È‰NØ˜XÚÙÜ›İ[™ˆˆ
ÈË˜ÛÛÜˆ
È	ÈÙ]Ù]‰È
Âˆ	ÏÜ[ˆÛ\ÜÏH˜Ûˆİ[OH˜ÛÛÜ‰È
ÈË˜ÛÛÜˆ
È	È‰È
ÈË˜Ûİ[
ÈÜÜ[Ù]ˆÂˆJNÂˆ[
ÏHÙ]Ù]ˆÂ‚ˆ[
ÏH	Ï]ˆÛ\ÜÏHœ[™[•›İYÚ]Ü[ˆÛ\ÜÏH›]]Y°­È\XÜÈÛ™HİÙYZÏÜÜ[Ú‰È
Âˆ	ÏÛ\ÜÏHš[“\İİ[™^KX[˜ÚÜ™YÙYZÜËˆH\İ˜\ˆ\ÈHİ\œ™[
\X[
HÙY[‹Ü‰ÎÂˆ˜\ˆX^ˆHX]›X^˜\J[ÌWK˜ÛÛ˜Ø]
‹˜[Y\È×JJNÂˆ[
ÏH	Ï]ˆÛ\ÜÏH˜\ˆ‰ÎÂˆ
‹˜[Y\È×JK™›Ü‘XXÚ
[˜İ[Ûˆ
‹JHÂˆ˜\ˆİ\ˆHHOO‹˜[Y\Ë›[™İHNÂˆ[
ÏH	Ï]ˆÛ\ÜÏH˜ÛÛˆ
È
İ\ˆÈˆİ\ˆˆˆˆŠH
È	ÈÜ[ˆÛ\ÜÏH›ˆ‰È
Èˆ
ÈÜÜ[ˆˆ
Âˆ	Ï]ˆÛ\ÜÏH˜ˆˆİ[OHšZYÚ‰È
È
ˆÈX^ˆ
ˆL
H
È	ÉHÙ]‰È
Âˆ	ÏÜ[ˆÛ\ÜÏH›‰È
È\ØÊ
‹›X™[È×JVÚWHˆŠH
ÈÜÜ[Ù]ˆÂˆJNÂˆ[
ÏHÙ]Ù]ˆÂˆ[
ÏHÙ]ˆÂ‚ˆËÈ[ˆ›ÙÜ™\ÜÈ
È›Ûİ]X›\Âˆ[
ÏH	Ï]ˆÛ\ÜÏH™ÜšYˆ‰ÎÂˆ[
ÏH	Ï]ˆÛ\ÜÏHœ[™[‘\XÜÈ[ˆ›ÙÜ™\ÜÈÜ[ˆÛ\ÜÏH›]]YŠ	È
ÈÚ\İ[
È	ÊOÜÜ[Ú‰È
Âˆ	Ï]ˆÛ\ÜÏHœØÜ›Û‰È
È\XÕX›JÚ\™\XÜËYJH
ÈÙ]Ù]ˆÂˆ[
ÏH	Ï]ˆÛ\ÜÏHœ[™[”›Ûİ]Ü[ˆÛ\ÜÏH›]]YŠ	È
È›Ûİ]İ[
È	ÊOÜÜ[Ú‰È
Âˆ	Ï]ˆÛ\ÜÏHœØÜ›Û‰È
È\XÕX›J›Ûİ]™\XÜËYJH
ÈÙ]Ù]ˆÂˆ[
ÏHÙ]ˆÂ‚ˆËÈ›ØÚÙ\œÂˆ[
ÏH	Ï]ˆÛ\ÜÏHœ[™[[›ØÚÙ\œÈÜ[ˆÛ\ÜÏH›]]YŠ	È
È›ØÚÙ\œËİ[
È	ÊOÜÜ[Ú‰È
Âˆ	ÏÛ\ÜÏHš[‘\XÜÈ›İÛ™H]\™H›YÙÙY\È[\Y[Y[ÜˆØ\œHH˜›ØÚÙYˆX™[Ü‰È
Âˆ	Ï]ˆÛ\ÜÏHœØÜ›Û‰È
È\XÕX›J›ØÚÙ\œË™\XÜËYJH
ÈÙ]Ù]ˆÂ‚ˆYˆ
™\œ›ÜœÈ	‰ˆ™\œ›ÜœË›[™İ
HÂˆ[Bˆ	Ï]ˆÛ\ÜÏH™\œˆ”ÛÛYHÙXİ[ÛœÈÛİ[›İ™HÛÛ\]Y\È[ˆ	È
Âˆ\ØÊ™\œ›ÜœËš›Ú[Šˆ0¬HŠJH
ÈÙ]ˆˆ
È[ÂˆB‚ˆØİ[Y[™Ù][[Y[RY
˜ÛÛ[ŠKš[›™\’SH[ÂŸB‚™[˜İ[Ûˆ\XÕX›J\XÜËÚ]X[JHÂˆ\XÜÈH\XÜÈ×NÂˆYˆ
Y\XÜË›[™İ
H™]\›ˆ	ÏÛ\ÜÏH›]]Yˆİ[OHœY[™Î“›Ûœ×Ü‰ÎÂˆ˜\ˆHX›OXY‘\XÏİ”İ[[X\Oİ”İ]\Ïİˆˆ
Âˆ
Ú]X[HÈ•X[OİˆˆˆˆŠH
ÈİİXY›ÙOˆÂˆ\XÜË™›Ü‘XXÚ
[˜İ[Ûˆ
JHÂˆ
ÏHˆˆ
È\ÜİYS[šÊKšÙ^JH
Èİˆˆ
È\ØÊKœİ[[X\JH
Èİˆˆ
Âˆ	ÏÜ[ˆÛ\ÜÏHœ[‰È
È\ØÊKœİ]\ÊH
ÈÜÜ[İˆˆ
Âˆ
Ú]X[HÈˆˆ
È\ØÊKX[JH
ÈİˆˆˆˆŠH
ÈİˆÂˆJNÂˆ™]\›ˆ
Èİ›ÙOİX›OˆÂŸB‚›ØY
˜[ÙJNÂ