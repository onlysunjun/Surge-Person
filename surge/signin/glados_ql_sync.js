/*
 * GLaDOS Surge Mac -> QingLong OpenAPI sync
 * Source: Surge persistent store glados_accounts_v1, only verified emails.
 * Destination: one QingLong JSON environment variable (default GLADOS_ACCOUNTS).
 * Auth: module parameter token OR client_id/secret (automatically refreshed).
 * Does not delete entries, overwrite invalid existing JSON, or log credentials.
 */
(function () {
  "use strict";
  const PREFIX = "[GLaDOS QL Sync] ";
  const STORE = "glados_accounts_v1";
  const TOKEN_CACHE = "glados_ql_token_cache_v1";
  const DELIM = "|||GLADOS|||";
  const log = s => console.log(PREFIX + s);
  const emailNorm = s => String(s || "").trim().toLowerCase();
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const done = () => $done({});

  function config() {
    if (typeof $argument !== "string") throw new Error("Missing module arguments");
    const parts = $argument.split(DELIM);
    if (parts.length !== 6) throw new Error("Invalid module argument format");
    const [url, directToken, clientId, clientSecret, envName, dryRun] = parts.map(s => s.trim());
    const root = url.replace(/\/+$/, "").replace(/\/open$/, "");
    if (!/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(root)) throw new Error("Invalid QingLong panel URL");
    if (!/^[A-Z_][A-Z0-9_]{0,79}$/i.test(envName)) throw new Error("Invalid environment variable name");
    if (!directToken && !(clientId && clientSecret)) throw new Error("Supply ql_token OR both client_id and client_secret");
    return { root, directToken, clientId, clientSecret, envName, dryRun: dryRun.toLowerCase() !== "false" };
  }
  function getLocal() {
    const raw = $persistentStore.read(STORE);
    if (!raw) return [];
    let data;
    try { data = JSON.parse(raw); } catch (_) { throw new Error("Local storage is malformed; no changes made"); }
    if (!Array.isArray(data)) throw new Error("Local storage is not an array");
    const map = new Map();
    data.forEach(item => {
      if (!item || item.verified !== true) return;
      const email = emailNorm(item.email);
      if (!EMAIL.test(email) || typeof item.cookie !== "string" || !item.cookie) return;
      if (!/(?:^|;\s*)(?:gld:sess|koa:sess|sess)=/.test(item.cookie)) return;
      if (!/(?:^|;\s*)(?:gld:sess\.sig|koa:sess\.sig|sess\.sig)=/.test(item.cookie)) return;
      if (map.has(email) && map.get(email).cookie !== item.cookie) {
        throw new Error("Duplicate verified local email detected: " + email);
      }
      map.set(email, { email, cookie: item.cookie, userAgent: String(item.userAgent || "") });
    });
    return [...map.values()];
  }
  function http(method, url, token, data) {
    return new Promise((resolve, reject) => {
      const headers = { Accept: "application/json" };
      if (token) headers.Authorization = "Bearer " + token;
      if (data !== undefined) headers["Content-Type"] = "application/json";
      const opts = {
        url, headers, timeout: 15,
        "auto-redirect": false,
        "auto-cookie": false
      };
      if (data !== undefined) opts.body = JSON.stringify(data);
      $httpClient[method](opts, (error, response, body) => {
        if (error) return reject(new Error("Network request failed"));
        if (!response) return reject(new Error("No API response"));
        const status = Number(response.status);
        let value;
        try { value = JSON.parse(String(body || "")); }
        catch (_) {
          if (status === 401 || status === 403) value = { code: status };
          else return reject(new Error("Non-JSON API response (HTTP " + status + ")"));
        }
        resolve({ status, value });
      });
    });
  }
  function good(result, label) {
    if (!(result.status >= 200 && result.status < 300) ||
        !result.value || Number(result.value.code) !== 200) {
      throw new Error(label + " failed: HTTP " + result.status + ", code " +
        (result.value && result.value.code !== undefined ? result.value.code : "missing"));
    }
    return result.value.data;
  }
  async function tokenFromCredentials(c, refresh) {
    if (c.directToken) return c.directToken;
    const cacheKey = c.root + "|" + c.clientId;
    if (!refresh) {
      try {
        const v = JSON.parse($persistentStore.read(TOKEN_CACHE) || "null");
        if (v && v.key === cacheKey && v.token && Date.now() < v.until) return v.token;
      } catch (_) { /* refresh */ }
    }
    const url = c.root + "/open/auth/token?client_id=" + encodeURIComponent(c.clientId) +
      "&client_secret=" + encodeURIComponent(c.clientSecret);
    const data = good(await http("get", url, ""), "Token authorization");
    if (!data || typeof data.token !== "string" || !data.token) throw new Error("Token was not returned");
    // Keep cached for up to 12h. A 401 will trigger a refresh earlier.
    $persistentStore.write(JSON.stringify({ key: cacheKey, token: data.token,
      until: Date.now() + 12 * 60 * 60 * 1000 }), TOKEN_CACHE);
    return data.token;
  }
  async function authorized(c, method, path, data) {
    let token = await tokenFromCredentials(c, false);
    let response = await http(method, c.root + path, token, data);
    if ((response.status === 401 || Number(response.value && response.value.code) === 401) && !c.directToken) {
      token = await tokenFromCredentials(c, true);
      response = await http(method, c.root + path, token, data);
    }
    return good(response, method.toUpperCase() + " " + path);
  }
  function envList(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") {
      for (const key of ["data", "records", "list", "items"]) {
        if (Array.isArray(data[key])) {
          if (typeof data.total === "number" && data.total > data[key].length) {
            throw new Error("QingLong response is paginated; refusing to risk duplicate variables");
          }
          return data[key];
        }
      }
    }
    throw new Error("Unsupported QingLong environment list response");
  }
  function remoteAccounts(value) {
    let arr;
    try { arr = JSON.parse(value); }
    catch (_) { throw new Error("Existing environment JSON is malformed; refusing to overwrite"); }
    if (!Array.isArray(arr)) throw new Error("Existing environment is not a JSON array");
    const seen = new Set();
    arr.forEach(x => {
      const e = emailNorm(x && x.email);
      if (!EMAIL.test(e)) throw new Error("Existing JSON contains an entry without valid email; refusing overwrite");
      if (seen.has(e)) throw new Error("Existing JSON contains duplicate emails; refusing overwrite");
      seen.add(e);
    });
    return arr;
  }
  async function main() {
    const c = config();
    const local = getLocal();
    if (!local.length) { log("No verified local accounts. Refresh /api/user/status while logged in."); return; }
    // Never call QingLong if no verified accounts can be synchronized.
    const envs = envList(await authorized(c, "get", "/open/envs"));
    const matches = envs.filter(x => x && x.name === c.envName);
    if (matches.length > 1) throw new Error("Multiple env variables share the name " + c.envName + "; refusing overwrite");
    const target = matches[0] || null;
    const remote = target ? remoteAccounts(target.value) : [];
    const known = new Map(remote.map((x, i) => [emailNorm(x.email), i]));
    const counts = { added: 0, updated: 0, unchanged: 0 };
    const now = new Date().toISOString();
    local.forEach(item => {
      const i = known.get(item.email);
      if (i === undefined) {
        remote.push({ email: item.email, cookie: item.cookie, userAgent: item.userAgent, syncedAt: now });
        known.set(item.email, remote.length - 1);
        counts.added++;
      } else {
        const old = remote[i];
        if (old.cookie !== item.cookie || old.userAgent !== item.userAgent) {
          remote[i] = { ...old, email: item.email, cookie: item.cookie,
            userAgent: item.userAgent, syncedAt: now };
          counts.updated++;
        } else {
          counts.unchanged++;
        }
      }
    });
    log("Local verified " + local.length + ", QingLong current " + (target ? "present" : "absent") +
      ", add " + counts.added + ", update " + counts.updated + ", unchanged " + counts.unchanged +
      ", dry_run " + c.dryRun);
    if (counts.added === 0 && counts.updated === 0) return;
    if (c.dryRun) { log("Preview only; set dry_run=false in module arguments to write."); return; }
    const body = { name: c.envName, value: JSON.stringify(remote), remarks: (target && target.remarks) || "Managed by Surge Mac GLaDOS sync" };
    if (target) {
      if (target.id === undefined && target._id === undefined) throw new Error("Existing QingLong env has no ID");
      body.id = target.id !== undefined ? target.id : target._id;
      await authorized(c, "put", "/open/envs", body);
    } else {
      await authorized(c, "post", "/open/envs", [body]);
    }
    log("QingLong sync succeeded. Accounts added " + counts.added + ", updated " + counts.updated + ".");
    $notification.post("GLaDOS → QingLong", "Sync complete", "Added " + counts.added + ", updated " + counts.updated);
  }
  main().catch(e => log("Sync stopped safely: " + (e && e.message ? e.message : "unknown"))).then(done);
})();
