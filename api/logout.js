// GET or POST /api/logout → clears the auth cookie and sends you to the login page.
module.exports = async (req, res) => {
  res.statusCode = 302;
  res.setHeader("Set-Cookie", "auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  res.setHeader("Location", "/login.html");
  res.end();
};
