// POST /api/login  { password }  → sets a signed, HttpOnly auth cookie on success.
// The gate is ACTIVE only when both AUTH_SECRET and SITE_PASSWORD are set in Vercel;
// until then the dashboard stays open (nothing breaks before you configure it).
const crypto = require("crypto");

const TTL_DAYS = 7;

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function sign(data, secret) {
  return b64url(crypto.createHmac("sha256", secret).update(data).digest());
}
function makeToken(secret, ttlMs) {
  const payload = b64url(JSON.stringify({ exp: Date.now() + ttlMs }));
  return payload + "." + sign(payload, secret);
}
function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(function (resolve) {
    var body = "";
    req.on("data", function (c) { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", function () { resolve(body); });
    req.on("error", function () { resolve(""); });
  });
}

module.exports = async (req, res) => {
  const secret = process.env.AUTH_SECRET, pw = process.env.SITE_PASSWORD;
  if (!secret || !pw) {
    send(res, 500, { error: "Login is not configured. Set SITE_PASSWORD and AUTH_SECRET in the Vercel project settings, then redeploy." });
    return;
  }
  if (req.method !== "POST") { send(res, 405, { error: "Use POST." }); return; }

  const raw = await readBody(req);
  let password = "";
  try { password = (JSON.parse(raw || "{}").password || "") + ""; } catch (e) { password = ""; }

  // constant-time-ish comparison
  const a = Buffer.from(password);
  const b = Buffer.from(pw);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) { send(res, 401, { error: "Incorrect password." }); return; }

  const token = makeToken(secret, TTL_DAYS * 24 * 3600 * 1000);
  res.setHeader("Set-Cookie", "auth=" + token + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=" + (TTL_DAYS * 24 * 3600));
  send(res, 200, { ok: true });
};
