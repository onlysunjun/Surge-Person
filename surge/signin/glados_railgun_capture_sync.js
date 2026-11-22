/*
 * GLaDOS + Railgun -> one QingLong panel, Surge Mac 5.10.5.
 * Uses one shared response script for both domains (no cron).
 * Reads verified email + Cookie, writes site-specific JSON env to one panel.
 * Notices: (1) verified Cookie captured, (2) QingLong result completed.
 * Always lets the original website response continue unchanged via $done({}).
 */
(function () {
  "use strict";
  // A single module handles both sites but NEVER combines their cookies.
  const requestUrl = typeof $request !== "undefined" && $request ? String($request.url || "") : "";
  const siteMatch = /^https:\/\/(glados\.network|railgun\.info)\/api\/user\/status(?:\?.*)?$/.exec(requestUrl);
  if (!siteMatch) { $done({}); return; }
  const HOST = siteMatch[1];
  const IS_RAILGUN = HOST === "railgun.info";
  const DISPLAY_NAME = IS_RAILGUN ? "Railgun" : "GLaDOS";
  const TAG = "[" + DISPLAY_NAME + " Instant] ";
  const STORE = IS_RAILGUN ? "railgun_accounts_v1" : "glados_accounts_v1";
  const TOKEN_CACHE = "sites_ql_token_cache_v1"; // Shared QingLong login cache
  const LOCK_STORE = IS_RAILGUN ? "railgun_instant_lock_v1" : "glados_instant_lock_v1";
  const PENDING_STORE = IS_RAILGUN ? "railgun_instant_pending_v1" : "glados_instant_pending_v1";
  const RECEIPT_STORE = IS_RAILGUN ? "railgun_instant_receipts_v1" : "glados_instant_receipts_v1";
  const DELIM = "|||SITES|||";
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const TIME_LIMIT = 11000; // safety cap: avoid blocking original page
  let finished = false;
  let notificationEnabled = true;
  let lockOwner = null;
  const now = () => Date.now();
  const norm = s => String(s || "").trim().toLowerCase();
  const log = s => console.log(TAG + String(s));
  const maskEmail = email => {
    const p = String(email || "").split("@");
    return p.length === 2 ? p[0].slice(0, 2) + "***@" + p[1] : "已验证账号";
  };
  // Deliberately do not rate-limit these two notifications: users requested
  // one after each verified capture and one for every sync outcome.
  function notify(title, detail) {
    if (!notificationEnabled || finished) return;
    try { $notification.post(DISPLAY_NAME + " → 青龙", title, detail); }
    catch (_) { /* macOS notification failure must never block the website */ }
  }
  function applyNotificationPreference() {
    // Configure notices before validating QingLong credentials, so that a
    // valid capture still notifies even if QingLong authentication is missing.
    const parts = typeof $argument === "string" ? $argument.split(DELIM) : [];
    if (parts.length === 8) notificationEnabled = norm(parts[7]) !== "false";
  }
  function releaseLock() {
    if (!lockOwner) return;
    try {
      const cur = JSON.parse($persistentStore.read(LOCK_STORE) || "null");
      if (cur && cur.owner === lockOwner) $persistentStore.write("null", LOCK_STORE);
    } catch (_) { /* TTL will expire */ }
    lockOwner = null;
  }
  function done() {
    if (finished) return;
    releaseLock();
    finished = true;
    clearTimeout(watchdog);
    $done({}); // DO NOT modify original response
  }
  const watchdog = setTimeout(() => {
    if (finished) return;
    log("青龙同步超过 11 秒；已放行网页，保留本地账号等待下次访问重试。");
    notify("② 青龙同步超时", "Cookie 已保存本地；本次写入未确认。请刷新页面重试。");
    done();
  }, TIME_LIMIT);

  function hval(headers, key) {
    if (!headers) return "";
    if (Array.isArray(headers)) {
      return headers.filter(h => norm(h.field) === key).map(h => String(h.value || "")).join("; ");
    }
    const found = Object.keys(headers).find(k => norm(k) === key);
    return found ? String(headers[found] || "") : "";
  }
  function cookieMap(raw) {
    const map = {};
    String(raw || "").split(";").forEach(part => {
      const n = part.indexOf("=");
      if (n <= 0) return;
      const key = part.slice(0, n).trim(), val = part.slice(n + 1).trim();
      if (key && val) map[key] = val;
    });
    return map;
  }
  function sessionKeys(map) {
    const possibilities = IS_RAILGUN
      ? ["koa:sess"]
      : ["gld:sess", "koa:sess", "sess", ...Object.keys(map).filter(k => k.endsWith(":sess"))];
    for (const key of possibilities) if (map[key] && map[key + ".sig"]) return key;
    return "";
  }
  function getCfg() {
    if (typeof $argument !== "string") throw Error("未收到 Surge 模块参数");
    const parts = $argument.split(DELIM);
    if (parts.length !== 8) throw Error("模块参数数量异常，应有 8 项");
    const [inputUrl, t, i, s, gladosEnv, railgunEnv, dryRun, notifyFlag] = parts.map(x => x.trim());
    const envName = IS_RAILGUN ? railgunEnv : gladosEnv;
    if (gladosEnv === railgunEnv) throw Error("两站环境变量名不能相同，以防 Cookie 混用");
    const clean = x => /^(?:UNSET|NOT_SET|NONE)$/i.test(x) ? "" : x;
    notificationEnabled = notifyFlag.toLowerCase() !== "false";
    const root = inputUrl.replace(/\/+$/, "").replace(/\/open$/, "");
    if (!/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(root)) throw Error("ql_url 青龙地址无效");
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(envName)) throw Error("ql_env_name 不合法");
    const directToken = clean(t), clientId = clean(i), clientSecret = clean(s);
    if (!directToken && !(clientId && clientSecret)) throw Error("请填写 ql_token，或 ql_client_id + ql_client_secret");
    return { root, directToken, clientId, clientSecret, envName, dryRun: dryRun.toLowerCase() !== "false" };
  }
  function readAccounts() {
    const raw = $persistentStore.read(STORE);
    if (!raw) return [];
    let accounts;
    try { accounts = JSON.parse(raw); } catch (_) { throw Error("本地账号数据 JSON 损坏，已停止以防覆盖"); }
    if (!Array.isArray(accounts)) throw Error("本地账号存储不是数组，已停止");
    return accounts;
  }
  function validLocal(accounts) {
    const map = new Map();
    for (const a of accounts) {
      if (!a || a.verified !== true || !EMAIL.test(norm(a.email)) || typeof a.cookie !== "string") continue;
      if (!sessionKeys(cookieMap(a.cookie))) continue;
      const email = norm(a.email);
      if (map.has(email) && map.get(email).cookie !== a.cookie) throw Error("本地出现重复邮箱，拒绝同步以防覆盖");
      map.set(email, { email, cookie: a.cookie, userAgent: String(a.userAgent || "") });
    }
    return Array.from(map.values());
  }
  function capture() {
    if (typeof $request === "undefined" || typeof $response === "undefined" || !$request || !$response) {
      throw Error("无网页请求上下文；请刷新 Chrome 的 GLaDOS 页面");
    }
    const url = String($request.url || "");
    if (!siteMatch || url !== requestUrl) return null;
    const status = parseInt(String($response.status || "").match(/\b\d{3}\b/)?.[0] || "0", 10);
    if (!(status >= 200 && status < 300)) throw Error(DISPLAY_NAME + " status HTTP 状态非 2xx");
    if (typeof $response.body !== "string" || !$response.body) throw Error("响应体不存在；检查 requires-body / gzip");
    let data;
    try { data = JSON.parse($response.body); }
    catch (_) { throw Error("响应 JSON 解析失败；检查服务器是否仍返回 zstd"); }
    if (data && Object.prototype.hasOwnProperty.call(data, "code") && ![0, 200].includes(Number(data.code))) {
      throw Error(DISPLAY_NAME + " status 业务状态码非成功");
    }
    const email = norm(data && data.data && (data.data.email || (data.data.user && data.data.user.email)));
    if (!EMAIL.test(email)) throw Error(DISPLAY_NAME + " status 没有 data.email");
    const rawCookie = hval($request.headers, "cookie").trim();
    if (!rawCookie) throw Error("请求头没有 Cookie");
    const sessionKey = sessionKeys(cookieMap(rawCookie));
    if (!sessionKey) throw Error("Cookie 缺少 sess + sess.sig");
    // Railgun uses a verified koa session pair; GLaDOS preserves the current
    // browser Cookie string because other auth cookie fields may matter.
    const pair = cookieMap(rawCookie);
    const authCookie = IS_RAILGUN
      ? `${sessionKey}=${pair[sessionKey]}; ${sessionKey}.sig=${pair[sessionKey + ".sig"]}`
      : rawCookie;
    if (authCookie.length > 16000) throw Error("Cookie 超过 16KB，已跳过");
    const ua = hval($request.headers, "user-agent");
    const rawId = data.data && (IS_RAILGUN ? data.data.id : (data.data.userId || data.data.configureId));
    const userId = rawId != null ? String(rawId) : "";
    const accounts = readAccounts();
    const index = accounts.findIndex(x => x && norm(x.email) === email);
    const changed = index < 0 || accounts[index].cookie !== authCookie || accounts[index].userAgent !== ua || accounts[index].verified !== true;
    if (changed) {
      const record = index < 0 ? {
        id: "email:" + email, email, createdAt: now(), lastSuccessAt: 0, lastError: ""
      } : { ...accounts[index] };
      Object.assign(record, {
        cookie: authCookie, email, userId: userId || String(record.userId || ""),
        userAgent: ua, verified: true, cookiePrefix: sessionKey.endsWith(":sess") ? sessionKey.slice(0, -5) : "",
        sourceHost: HOST, updatedAt: now()
      });
      if (index < 0) accounts.push(record); else accounts[index] = record;
      if (!$persistentStore.write(JSON.stringify(accounts), STORE)) throw Error("Surge 本地存储写入失败");
    }
    // Mark any newly seen verified request so a busy invocation can re-sync all accounts.
    $persistentStore.write(String(now()) + "-" + email + "-" + (changed ? "changed" : "same"), PENDING_STORE);
    log((changed ? "识别/更新" : "已验证") + "邮箱：" + maskEmail(email) + "；本地账号数=" + accounts.length);
    notify("① Cookie 已获取", maskEmail(email) + " · " + (index < 0 ? "新邮箱" : changed ? "Cookie 已更新" : "Cookie 无变化") + "；开始检查青龙。");
    return { email, changed };
  }
  function http(method, url, token, data) {
    return new Promise((resolve, reject) => {
      const headers = { Accept: "application/json" };
      if (token) headers.Authorization = "Bearer " + token;
      if (data !== undefined) headers["Content-Type"] = "application/json";
      const opts = { url, headers, timeout: 3, "auto-redirect": false, "auto-cookie": false };
      if (data !== undefined) opts.body = JSON.stringify(data);
      $httpClient[method](opts, (err, response, body) => {
        if (err) return reject(Error("青龙网络请求失败或超时"));
        if (!response) return reject(Error("青龙没有返回响应"));
        const status = Number(response.status);
        let value;
        try { value = JSON.parse(String(body || "")); }
        catch (_) {
          if (status === 401 || status === 403) value = { code: status };
          else return reject(Error("青龙返回非 JSON，HTTP " + status));
        }
        resolve({ status, value });
      });
    });
  }
  function good(result, label) {
    const code = Number(result.value && result.value.code);
    if (!(result.status >= 200 && result.status < 300) || ![0, 200].includes(code)) {
      throw Error(label + " 未成功：HTTP " + result.status + " / code " + (Number.isNaN(code) ? "?" : code));
    }
    return result.value.data;
  }
  async function getToken(cfg, force) {
    if (cfg.directToken) return cfg.directToken;
    const key = cfg.root + "|" + cfg.clientId;
    if (!force) {
      try {
        const cached = JSON.parse($persistentStore.read(TOKEN_CACHE) || "null");
        if (cached && cached.key === key && cached.token && now() < cached.until) return cached.token;
      } catch (_) { /* refresh */ }
    }
    const url = cfg.root + "/open/auth/token?client_id=" + encodeURIComponent(cfg.clientId) +
      "&client_secret=" + encodeURIComponent(cfg.clientSecret);
    const data = good(await http("get", url, ""), "青龙 Token 获取");
    if (!data || typeof data.token !== "string" || !data.token) throw Error("青龙未返回 Token");
    $persistentStore.write(JSON.stringify({ key, token: data.token, until: now() + 12 * 3600000 }), TOKEN_CACHE);
    return data.token;
  }
  async function api(cfg, method, path, body) {
    let token = await getToken(cfg, false);
    let response = await http(method, cfg.root + path, token, body);
    if (!cfg.directToken && (response.status === 401 || Number(response.value && response.value.code) === 401)) {
      token = await getToken(cfg, true);
      response = await http(method, cfg.root + path, token, body);
    }
    return good(response, method.toUpperCase() + " " + path);
  }
  function envList(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") {
      for (const k of ["data", "records", "list", "items"]) {
        if (Array.isArray(data[k])) {
          if (Number(data.total || 0) > data[k].length) throw Error("青龙环境变量列表分页不完整，拒绝覆盖");
          return data[k];
        }
      }
    }
    throw Error("青龙环境变量列表格式不支持");
  }
  function existingAccounts(value) {
    let list;
    try { list = JSON.parse(value); } catch (_) { throw Error("青龙已有环境变量 JSON 不合法，拒绝覆盖"); }
    if (!Array.isArray(list)) throw Error("青龙已有环境变量不是 JSON 数组，拒绝覆盖");
    const seen = new Set();
    for (const item of list) {
      const e = norm(item && item.email);
      if (!EMAIL.test(e) || seen.has(e)) throw Error("青龙已有账号邮箱无效或重复，拒绝覆盖");
      seen.add(e);
    }
    return list;
  }
  function getReceipt() {
    try { return JSON.parse($persistentStore.read(RECEIPT_STORE) || "null"); }
    catch (_) { return null; }
  }
  function digest(text) {
    let h = 2166136261;
    for (let n = 0; n < text.length; n++) h = Math.imul(h ^ text.charCodeAt(n), 16777619);
    return (h >>> 0).toString(16);
  }
  async function sync(cfg) {
    // Sync the WHOLE verified list so switching email cannot discard prior accounts.
    const local = validLocal(readAccounts());
    if (!local.length) throw Error("本地没有已验证邮箱账号");
    const receiptKey = cfg.root + "|" + cfg.envName;
    const fingerprint = digest(JSON.stringify(local));
    const rec = getReceipt();
    // Skip repeated status hits for an already *successfully written* unchanged state.
    // Never skip dry-run; changing dry_run=true -> false still triggers a real upload.
    if (!cfg.dryRun && rec && rec.key === receiptKey && rec.digest === fingerprint && now() - rec.time < 600000) {
      log("已确认同步且 Cookie 未变化，跳过重复写入。");
      return { skipped: true, added: 0, updated: 0, unchanged: local.length };
    }
    const envs = envList(await api(cfg, "get", "/open/envs"));
    const matches = envs.filter(x => x && x.name === cfg.envName);
    if (matches.length > 1) throw Error("青龙存在多个同名环境变量，拒绝覆盖");
    const target = matches[0] || null;
    const remote = target ? existingAccounts(target.value) : [];
    const locations = new Map(remote.map((x, i) => [norm(x.email), i]));
    const counts = { added: 0, updated: 0, unchanged: 0 };
    const stamp = new Date().toISOString();
    for (const a of local) {
      const i = locations.get(a.email);
      if (i === undefined) {
        remote.push({ email: a.email, cookie: a.cookie, userAgent: a.userAgent, syncedAt: stamp });
        locations.set(a.email, remote.length - 1);
        counts.added++;
      } else if (remote[i].cookie !== a.cookie || remote[i].userAgent !== a.userAgent) {
        remote[i] = { ...remote[i], email: a.email, cookie: a.cookie, userAgent: a.userAgent, syncedAt: stamp };
        counts.updated++;
      } else counts.unchanged++;
    }
    if (cfg.dryRun) {
      log("预览成功：新增 " + counts.added + "，更新 " + counts.updated + "，未变化 " + counts.unchanged);
      return { ...counts, dryRun: true };
    }
    if (finished) return { ...counts, stopped: true };
    if (counts.added || counts.updated) {
      const payload = { name: cfg.envName, value: JSON.stringify(remote), remarks: target && target.remarks || "Managed by Surge Mac " + DISPLAY_NAME + " immediate sync" };
      if (target) {
        if (target.id === undefined && target._id === undefined) throw Error("青龙已有环境变量缺少 ID");
        payload.id = target.id !== undefined ? target.id : target._id;
        await api(cfg, "put", "/open/envs", payload);
      } else {
        await api(cfg, "post", "/open/envs", [payload]);
      }
    }
    // Mark a successful, non-dry-run state so duplicate status requests do not spam APIs.
    $persistentStore.write(JSON.stringify({ key: receiptKey, digest: fingerprint, time: now() }), RECEIPT_STORE);
    log("青龙同步完成：新增 " + counts.added + "，更新 " + counts.updated + "，未变化 " + counts.unchanged);
    return counts;
  }
  function tryLock() {
    const t = now();
    try {
      const old = JSON.parse($persistentStore.read(LOCK_STORE) || "null");
      if (old && Number(old.until) > t) return false;
    } catch (_) { /* ignore broken old lock */ }
    lockOwner = String(t) + ":" + String(Math.random());
    if (!$persistentStore.write(JSON.stringify({ owner: lockOwner, until: t + 14000 }), LOCK_STORE)) {
      throw Error("青龙同步锁无法保存");
    }
    return true;
  }
  async function acquireLock() {
    // Usually instant. For two simultaneous status requests, wait briefly for
    // the first API operation to finish rather than reporting false success.
    for (let attempt = 0; attempt < 20 && !finished; attempt++) {
      if (tryLock()) return true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
  }
  async function run() {
    applyNotificationPreference();
    const captured = capture(); // Shows first notice immediately upon valid capture
    if (!captured) return;
    const cfg = getCfg();
    if (!(await acquireLock())) {
      // There may be concurrent status responses. We do not falsely say that
      // a QingLong write has succeeded: the other invocation can still fail.
      log("另一个请求正在同步；已将本次账号保存到本地待合并。");
      notify("② 青龙同步待确认", maskEmail(captured.email) + " · 另一个请求仍在同步；本地已保存，尚未确认写入。");
      return;
    }
    const startPending = $persistentStore.read(PENDING_STORE);
    let result = await sync(cfg);
    const afterPending = $persistentStore.read(PENDING_STORE);
    if (!finished && afterPending !== startPending && !cfg.dryRun) {
      log("同步期间有其他账号更新，立即补充同步一次。");
      result = await sync(cfg);
    }
    if (finished) return;
    if (result.skipped) {
      notify("② 青龙已同步过", maskEmail(captured.email) + " · Cookie 无变化；本次跳过重复 API 写入。");
    } else if (result.dryRun) {
      notify("② 青龙预览完成", maskEmail(captured.email) + " · 待新增 " + result.added + "，待更新 " + result.updated + "，未变化 " + result.unchanged + "；dry_run=true，未写入。");
    } else {
      notify("② 青龙同步完成", maskEmail(captured.email) + " · 新增 " + result.added + "，更新 " + result.updated + "，未变化 " + result.unchanged + "。已确认 API 成功。");
    }
  }
  run().catch(e => {
    if (finished) return;
    const msg = String(e && e.message || "未知错误");
    log("处理失败：" + msg);
    notify("② 青龙处理失败", msg + "；已抓取的账号不会被删除，下次刷新可重试。");
  }).then(done);
})();
