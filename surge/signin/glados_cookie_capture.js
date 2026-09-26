/**
 * GLaDOS 多账号 Cookie 自动抓取
 *
 * 兼容：
 *   gld:sess=...; gld:sess.sig=...
 *   koa:sess=...; koa:sess.sig=...
 *
 * 同时支持未来可能出现的：
 *   xxx:sess=...; xxx:sess.sig=...
 *
 * 存储结构：
 * [
 *   {
 *     id: "Cookie 指纹",
 *     cookie: "gld:sess=...; gld:sess.sig=...",
 *     cookiePrefix: "gld",
 *     email: "",
 *     userId: "",
 *     createdAt: 0,
 *     updatedAt: 0,
 *     lastSuccessAt: 0,
 *     lastError: ""
 *   }
 * ]
 */

const STORE_KEY = "glados_accounts_v1";
const NOTIFY_KEY = "glados_cookie_last_notify";

/**
 * 已知的 GLaDOS Cookie 前缀。
 *
 * 顺序代表优先级。
 * 以后如果再次改名，只需要在这里加一个前缀即可。
 *
 * 即使这里没有新前缀，下面仍然会尝试自动识别任意 xxx:sess。
 */
const KNOWN_SESSION_PREFIXES = [
  "gld",
  "koa"
];

function log(message) {
  console.log(`[GLaDOS Cookie] ${message}`);
}

/**
 * 大小写不敏感读取 HTTP Header。
 */
function getHeader(headers, targetName) {
  if (!headers || typeof headers !== "object") {
    return "";
  }

  const target = String(targetName || "").toLowerCase();

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      return String(headers[key] || "");
    }
  }

  return "";
}

/**
 * Cookie 字符串解析为对象。
 *
 * 例如：
 *
 * gld:sess=abc; gld:sess.sig=xyz; foo=bar
 *
 * =>
 *
 * {
 *   "gld:sess": "abc",
 *   "gld:sess.sig": "xyz",
 *   "foo": "bar"
 * }
 */
function parseCookie(cookieText) {
  const result = {};

  if (!cookieText || typeof cookieText !== "string") {
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

/**
 * 找到完整的 session + session.sig Cookie 对。
 *
 * 返回：
 *
 * {
 *   prefix: "gld",
 *   sessionKey: "gld:sess",
 *   signatureKey: "gld:sess.sig",
 *   session: "...",
 *   signature: "...",
 *   cookie: "gld:sess=...; gld:sess.sig=..."
 * }
 *
 * 找不到则返回 null。
 */
function findGladosSession(cookieText) {
  const parsed = parseCookie(cookieText);

  if (!parsed || Object.keys(parsed).length === 0) {
    return null;
  }

  /**
   * 第 1 层：
   * 优先识别已知的 Cookie 前缀。
   */
  for (const prefix of KNOWN_SESSION_PREFIXES) {
    const sessionKey = `${prefix}:sess`;
    const signatureKey = `${prefix}:sess.sig`;

    const session = parsed[sessionKey];
    const signature = parsed[signatureKey];

    if (session && signature) {
      return {
        prefix,
        sessionKey,
        signatureKey,
        session,
        signature,
        cookie: `${sessionKey}=${session}; ${signatureKey}=${signature}`
      };
    }
  }

  /**
   * 第 2 层：
   * 自动寻找任何：
   *
   * xxx:sess
   * xxx:sess.sig
   *
   * 避免以后 GLaDOS 再修改 Cookie 前缀后脚本直接失效。
   */
  const keys = Object.keys(parsed);

  for (const key of keys) {
    if (!key.endsWith(":sess")) {
      continue;
    }

    const signatureKey = `${key}.sig`;

    if (!parsed[signatureKey]) {
      continue;
    }

    const prefix = key.slice(
      0,
      -":sess".length
    );

    return {
      prefix,
      sessionKey: key,
      signatureKey,
      session: parsed[key],
      signature: parsed[signatureKey],
      cookie:
        `${key}=${parsed[key]}; ` +
        `${signatureKey}=${parsed[signatureKey]}`
    };
  }

  /**
   * 第 3 层：
   * 作为兜底，还支持没有 ":" 的命名。
   *
   * 例如：
   *
   * sess=...
   * sess.sig=...
   */
  if (parsed["sess"] && parsed["sess.sig"]) {
    return {
      prefix: "",
      sessionKey: "sess",
      signatureKey: "sess.sig",
      session: parsed["sess"],
      signature: parsed["sess.sig"],
      cookie:
        `sess=${parsed["sess"]}; ` +
        `sess.sig=${parsed["sess.sig"]}`
    };
  }

  return null;
}

/**
 * 将 Cookie 标准化。
 */
function normalizeGladosCookie(cookieText) {
  const sessionInfo = findGladosSession(cookieText);

  if (!sessionInfo) {
    return "";
  }

  return sessionInfo.cookie;
}

/**
 * FNV-1a 风格简单哈希。
 *
 * 这里只用于本地账号 Cookie 指纹，
 * 不是安全密码学用途。
 */
function simpleHash(text) {
  let hash = 2166136261;

  const input = String(text || "");

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);

    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }

  return (
    `00000000${(hash >>> 0).toString(16)}`
  ).slice(-8);
}

/**
 * Cookie 指纹。
 *
 * 不再依赖 koa:sess / gld:sess 的名称，
 * 仅使用真正的 session 内容。
 */
function getCookieIdentity(cookieText) {
  const info = findGladosSession(cookieText);

  if (!info) {
    return simpleHash(cookieText || "");
  }

  return simpleHash(
    `${info.session}|${info.signature}`
  );
}

/**
 * 读取账号列表。
 */
function readAccounts() {
  const raw = $persistentStore.read(STORE_KEY);

  if (!raw) {
    return [];
  }

  try {
    const data = JSON.parse(raw);

    if (!Array.isArray(data)) {
      return [];
    }

    return data;
  } catch (error) {
    log(`存储解析失败：${String(error)}`);
    return [];
  }
}

/**
 * 写入账号列表。
 */
function writeAccounts(accounts) {
  return $persistentStore.write(
    JSON.stringify(accounts),
    STORE_KEY
  );
}

/**
 * 对已有数据进行轻量兼容修复。
 *
 * 不会主动删除旧账号。
 */
function migrateAccounts(accounts) {
  if (!Array.isArray(accounts)) {
    return [];
  }

  return accounts.map((account) => {
    if (!account || typeof account !== "object") {
      return account;
    }

    const result = {
      ...account
    };

    const info = findGladosSession(
      String(account.cookie || "")
    );

    if (info) {
      result.cookie = info.cookie;

      if (!result.cookiePrefix) {
        result.cookiePrefix = info.prefix || "";
      }

      /**
       * 如果旧数据不存在 id，再补上。
       *
       * 已存在 id 不主动修改，
       * 避免影响原本的账号引用。
       */
      if (!result.id) {
        result.id = getCookieIdentity(info.cookie);
      }
    }

    if (typeof result.email !== "string") {
      result.email = "";
    }

    if (typeof result.userId !== "string") {
      result.userId = "";
    }

    if (!result.createdAt) {
      result.createdAt = Date.now();
    }

    if (!result.updatedAt) {
      result.updatedAt = result.createdAt;
    }

    if (!result.lastSuccessAt) {
      result.lastSuccessAt = 0;
    }

    if (typeof result.lastError !== "string") {
      result.lastError = "";
    }

    return result;
  });
}

/**
 * 防止一个页面连续请求造成通知刷屏。
 */
function shouldNotify() {
  const now = Date.now();

  const last = Number(
    $persistentStore.read(NOTIFY_KEY) || 0
  );

  if (now - last < 10000) {
    return false;
  }

  $persistentStore.write(
    String(now),
    NOTIFY_KEY
  );

  return true;
}

function finish() {
  $done({});
}

/**
 * 判断两个 Cookie 是否属于完全相同的 session。
 *
 * Cookie 名改变，例如：
 *
 * koa:sess -> gld:sess
 *
 * 但内容如果一致，仍可识别为同一个 Cookie。
 */
function sameSession(cookieA, cookieB) {
  const a = findGladosSession(cookieA);
  const b = findGladosSession(cookieB);

  if (!a || !b) {
    return false;
  }

  return (
    a.session === b.session &&
    a.signature === b.signature
  );
}

try {
  const rawCookie = getHeader(
    $request.headers,
    "cookie"
  );

  if (!rawCookie) {
    log("当前请求不存在 Cookie Header");
    finish();
  } else {
    const sessionInfo = findGladosSession(rawCookie);

    if (!sessionInfo) {
      log(
        "当前请求未找到完整的 GLaDOS Session Cookie"
      );

      /**
       * 调试时非常有用：
       * 仅输出 Cookie 名，不输出 Cookie 内容。
       *
       * 避免日志泄漏登录凭证。
       */
      const cookieNames = Object.keys(
        parseCookie(rawCookie)
      );

      log(
        `当前 Cookie 字段：${
          cookieNames.join(", ") || "(无)"
        }`
      );

      finish();
    } else {
      const normalizedCookie = sessionInfo.cookie;

      log(
        `识别到 Session Cookie：` +
        `${sessionInfo.sessionKey} + ` +
        `${sessionInfo.signatureKey}`
      );

      const now = Date.now();
      const newId = getCookieIdentity(
        normalizedCookie
      );

      let accounts = migrateAccounts(
        readAccounts()
      );

      /**
       * 1. 首先寻找完全相同的 Cookie。
       */
      let accountIndex = accounts.findIndex(
        (account) =>
          account &&
          account.cookie === normalizedCookie
      );

      /**
       * 2. Cookie 名称变化时，通过 session 内容识别。
       *
       * 例如：
       *
       * koa:sess=ABC
       *
       * 变成：
       *
       * gld:sess=ABC
       */
      if (accountIndex < 0) {
        accountIndex = accounts.findIndex(
          (account) =>
            account &&
            sameSession(
              account.cookie,
              normalizedCookie
            )
        );
      }

      let message = "";

      if (accountIndex >= 0) {
        const account = accounts[accountIndex];

        /**
         * 自动更新 Cookie 格式。
         *
         * 如果服务器把 koa 改成 gld，
         * 这里会直接升级已有记录。
         */
        account.cookie = normalizedCookie;
        account.cookiePrefix =
          sessionInfo.prefix || "";
        account.updatedAt = now;

        /**
         * 如果缺少 id，再生成。
         */
        if (!account.id) {
          account.id = newId;
        }

        message =
          `账号 ${accountIndex + 1} Cookie 已更新`;

      } else {
        /**
         * 新账号。
         *
         * email / userId 后续由签到脚本访问
         * status API 后补全。
         */
        accounts.push({
          id: newId,
          cookie: normalizedCookie,
          cookiePrefix:
            sessionInfo.prefix || "",
          email: "",
          userId: "",
          createdAt: now,
          updatedAt: now,
          lastSuccessAt: 0,
          lastError: ""
        });

        accountIndex = accounts.length - 1;

        message =
          `已新增第 ${accounts.length} 个 GLaDOS Cookie`;
      }

      const saved = writeAccounts(accounts);

      log(
        `${message}，` +
        `Cookie 前缀=${sessionInfo.prefix || "(无)"}，` +
        `保存结果=${saved}`
      );

      if (shouldNotify()) {
        $notification.post(
          "GLaDOS Cookie",
          message,
          `当前共保存 ${accounts.length} 个账号；` +
          `Cookie 类型：${sessionInfo.sessionKey}`
        );
      }

      finish();
    }
  }
} catch (error) {
  const message =
    error && error.stack
      ? error.stack
      : String(error);

  log(`抓取失败：${message}`);

  $notification.post(
    "GLaDOS Cookie",
    "Cookie 抓取失败",
    String(
      error && error.message
        ? error.message
        : error
    )
  );

  finish();
}
