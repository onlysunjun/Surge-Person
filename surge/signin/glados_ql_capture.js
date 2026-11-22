/*
 * GLaDOS Surge Mac verified account capture.
 * Runs ONLY as http-response for https://glados.network/api/user/status.
 * Avoid logging Cookie or User-Agent. Preserves legacy glados_accounts_v1.
 */
(function () {
  "use strict";
  const STORE = "glados_accounts_v1";
  const TAG = "[GLaDOS Capture] ";
  const log = s => console.log(TAG + s);
  const finish = () => $done({});
  const norm = s => String(s || "").trim().toLowerCase();
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function header(h, key) {
    if (!h) return "";
    if (Array.isArray(h)) {
      return h.filter(x => norm(x.field) === key).map(x => String(x.value || "")).join("; ");
    }
    const found = Object.keys(h).find(x => norm(x) === key);
    return found ? String(h[found] || "") : "";
  }
  function parseCookie(raw) {
    const out = {};
    String(raw || "").split(";").forEach(part => {
      const i = part.indexOf("=");
      if (i > 0) {
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k && v) out[k] = v;
      }
    });
    return out;
  }
  function getSession(map) {
    for (const key of ["gld:sess", "koa:sess", "sess", ...Object.keys(map).filter(k => k.endsWith(":sess"))]) {
      if (map[key] && map[key + ".sig"]) return [key, key + ".sig"];
    }
    return null;
  }
  try {
    if (typeof $request === "undefined" || typeof $response === "undefined" || !$request || !$response) {
      log("No HTTP context. Open the website and refresh the logged-in page (not editor Run).");
      return;
    }
    const url = String($request.url || "");
    if (!/^https:\/\/glados\.network\/api\/user\/status(?:\?.*)?$/.test(url)) return;
    if (Number($response.status) < 200 || Number($response.status) >= 300) {
      log("Status request did not return HTTP 2xx.");
      return;
    }
    if (typeof $response.body !== "string" || !$response.body) {
      log("Response body missing; verify requires-body=true and size limit.");
      return;
    }
    let payload;
    try { payload = JSON.parse($response.body); }
    catch (_) { log("Status response is not JSON."); return; }
    if (payload && Object.prototype.hasOwnProperty.call(payload, "code") &&
        ![0, 200].includes(Number(payload.code))) {
      log("Status API returned a non-success code.");
      return;
    }
    const data = payload && payload.data;
    const email = norm(data && (data.email || (data.user && data.user.email)));
    if (!EMAIL.test(email)) { log("Status response has no verified email."); return; }

    const raw = header($request.headers, "cookie");
    if (!raw) { log("No Cookie request header; check MITM and authenticated request."); return; }
    const cookieMap = parseCookie(raw);
    const keys = getSession(cookieMap);
    if (!keys) {
      log("Session pair missing; present Cookie field names: " + Object.keys(cookieMap).join(", "));
      return;
    }
    // Keep full request Cookie, as provided during a verified API request.
    const cookie = raw.trim();
    const ua = header($request.headers, "user-agent");
    if (!ua) { log("User-Agent missing; will save Cookie with empty UA."); }
    if (cookie.length > 16000) { log("Cookie too long, skipped."); return; }

    const rawAccounts = $persistentStore.read(STORE);
    let accounts = [];
    if (rawAccounts) {
      try { accounts = JSON.parse(rawAccounts); }
      catch (_) { log("Local storage malformed; will NOT overwrite it."); return; }
      if (!Array.isArray(accounts)) { log("Local storage is not an array; will NOT overwrite."); return; }
    }
    const now = Date.now();
    const matching = accounts.findIndex(a => a && norm(a.email) === email);
    if (matching >= 0) {
      const a = accounts[matching];
      const changed = a.cookie !== cookie || a.userAgent !== ua || a.verified !== true;
      if (!changed) { log("Existing verified account unchanged: " + email); return; }
      a.cookie = cookie;
      a.userAgent = ua;
      a.cookiePrefix = keys[0].endsWith(":sess") ? keys[0].slice(0, -5) : "";
      a.email = email;
      a.verified = true;
      a.updatedAt = now;
    } else {
      accounts.push({
        id: "email:" + email,
        email,
        userId: "",
        cookie,
        cookiePrefix: keys[0].endsWith(":sess") ? keys[0].slice(0, -5) : "",
        userAgent: ua,
        sourceHost: "glados.network",
        verified: true,
        createdAt: now,
        updatedAt: now,
        lastSuccessAt: 0,
        lastError: ""
      });
    }
    if (!$persistentStore.write(JSON.stringify(accounts), STORE)) {
      log("Persistent Store write failed.");
      return;
    }
    log((matching >= 0 ? "Updated" : "Added") + " verified email " + email + ". Local account records: " + accounts.length);
  } catch (e) {
    log("Capture error: " + (e && e.message ? e.message : "unknown"));
  } finally {
    finish();
  }
})();
