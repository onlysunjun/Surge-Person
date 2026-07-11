/**
 * GLaDOS 多账号 Cookie 自动抓取
 *
 * 存储结构：
 * [
 *   {
 *     id: "Cookie 指纹",
 *     cookie: "koa:sess=...; koa:sess.sig=...",
 *     email: "",
 *     userId: "",
 *     createdAt: 0,
 *     updatedAt: 0
 *   }
 * ]
 */

const STORE_KEY = "glados_accounts_v1";
const NOTIFY_KEY = "glados_cookie_last_notify";

function log(message) {
  console.log(`[GLaDOS Cookie] ${message}`);
}

function getHeader(headers, targetName) {
  if (!headers || typeof headers !== "object") {
    return "";
  }

  const target = targetName.toLowerCase();

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      return String(headers[key] || "");
    }
  }

  return "";
}

function parseCookie(cookieText) {
  const result = {};

  if (!cookieText) {
    return result;
  }

  cookieText.split(";").forEach((item) => {
    const index = item.indexOf("=");

    if (index <= 0) {
      return;
    }

    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();

    if (key && value) {
      result[key] = value;
    }
  });

  return result;
}

function normalizeGladosCookie(cookieText) {
  const parsed = parseCookie(cookieText);

  const session = parsed["koa:sess"] || "";
  const signature = parsed["koa:sess.sig"] || "";

  if (!session || !signature) {
    return "";
  }

  return `koa:sess=${session}; koa:sess.sig=${signature}`;
}

function simpleHash(text) {
  let hash = 2166136261;

  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);

    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }

  return (`00000000${(hash >>> 0).toString(16)}`).slice(-8);
}

function getCookieIdentity(cookieText) {
  const parsed = parseCookie(cookieText);

  /*
   * koa:sess 更新时，签名通常也会变化。
   * 使用会话内容生成指纹，仅用于本地账号识别。
   */
  return simpleHash(
    `${parsed["koa:sess"] || ""}|${parsed["koa:sess.sig"] || ""}`
  );
}

function readAccounts() {
  const raw = $persistentStore.read(STORE_KEY);

  if (!raw) {
    return [];
  }

  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    log(`存储解析失败：${String(error)}`);
    return [];
  }
}

function writeAccounts(accounts) {
  return $persistentStore.write(
    JSON.stringify(accounts),
    STORE_KEY
  );
}

function shouldNotify() {
  const now = Date.now();
  const last = Number(
    $persistentStore.read(NOTIFY_KEY) || 0
  );

  /*
   * 防止同一页面连续请求导致通知刷屏。
   */
  if (now - last < 10000) {
    return false;
  }

  $persistentStore.write(String(now), NOTIFY_KEY);
  return true;
}

function finish() {
  $done({});
}

try {
  const rawCookie = getHeader($request.headers, "cookie");
  const normalizedCookie = normalizeGladosCookie(rawCookie);

  if (!normalizedCookie) {
    log("当前请求未包含完整的 GLaDOS 登录 Cookie");
    finish();
  } else {
    const now = Date.now();
    const newId = getCookieIdentity(normalizedCookie);

    let accounts = readAccounts();

    /*
     * 先检查完全相同的 Cookie。
     */
    const exactIndex = accounts.findIndex(
      (account) => account.cookie === normalizedCookie
    );

    let message = "";

    if (exactIndex >= 0) {
      accounts[exactIndex].updatedAt = now;
      message = `账号 ${exactIndex + 1} Cookie 仍然有效`;
    } else {
      /*
       * 新抓到的 Cookie 暂时无法从请求头判断邮箱。
       * 签到脚本查询 status 后，会补全邮箱和 userId，
       * 并根据 userId 合并重复账号。
       */
      accounts.push({
        id: newId,
        cookie: normalizedCookie,
        email: "",
        userId: "",
        createdAt: now,
        updatedAt: now,
        lastSuccessAt: 0,
        lastError: ""
      });

      message = `已新增第 ${accounts.length} 个 GLaDOS Cookie`;
    }

    const saved = writeAccounts(accounts);

    log(`${message}，保存结果：${saved}`);

    if (shouldNotify()) {
      $notification.post(
        "GLaDOS Cookie",
        message,
        `当前共保存 ${accounts.length} 个账号`
      );
    }

    finish();
  }
} catch (error) {
  const message = String(error);

  log(`抓取失败：${message}`);

  $notification.post(
    "GLaDOS Cookie",
    "Cookie 抓取失败",
    message
  );

  finish();
}
