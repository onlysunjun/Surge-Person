/**
 * GLaDOS Surge 多账号签到脚本
 *
 * 功能：
 * 1. 从 $persistentStore 读取多个 Cookie
 * 2. 逐个签到
 * 3. 查询账号状态
 * 4. 自动补全 email、userId
 * 5. 按 userId 合并重复 Cookie
 * 6. 自动删除确认失效的 Cookie（默认关闭）
 * 7. 账号与接口之间延迟、失败自动重试 3 次
 * 8. 汇总通知
 */

const BASE_URL = "https://glados.network";
const UPDATE_URL = "https://update.glados.network";

const CHECKIN_URL = `${BASE_URL}/api/user/checkin`;
const STATUS_URL = `${BASE_URL}/api/user/status`;

const STORE_KEY = "glados_accounts_v1";

/*
 * 是否自动删除确认失效的 Cookie。
 *
 * false：保留并在通知中提示，较安全。
 * true：接口明确返回未登录后自动删除。
 */
const AUTO_REMOVE_INVALID_COOKIE = false;

const REQUEST_TIMEOUT = 20; // 单次 HTTP 请求超时（秒）
const ACCOUNT_DELAY_MS = 3000; // 不同账号之间延迟 3 秒
const REQUEST_DELAY_MS = 1500; // 同一账号：签到与状态查询间隔 1.5 秒
const MAX_RETRIES = 3; // 失败后额外重试 3 次（最多执行 4 次）
const RETRY_DELAY_MS = 2000; // 失败后按 2、4、6 秒递增等待

function log(message) {
  console.log(`[GLaDOS] ${message}`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * 遇到网络异常、非 2xx 响应、非法 JSON 或接口业务失败时重试。
 * Cookie 已被明确判定失效时，直接返回，不重试。
 * 签到返回“已签到”也视为成功，避免重试导致误报。
 */
async function runWithRetry(task, description) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAY_MS * attempt;
      log(`${description}将在 ${delay / 1000} 秒后进行第 ${attempt} 次重试`);
      await sleep(delay);
    }

    try {
      const result = await task();
      if (result && result.invalidCookie) {
        log(`${description}检测到 Cookie 失效，停止重试`);
        return result;
      }

      if (result && result.success === false) {
        throw new Error(result.message || `${description}接口返回失败`);
      }

      if (attempt > 0) {
        log(`${description}重试成功（第 ${attempt} 次重试）`);
      }
      return result;
    } catch (error) {
      log(`${description}第 ${attempt + 1} 次请求失败：${String(error.message || error)}`);
      if (attempt >= MAX_RETRIES) {
        throw new Error(
          `${description}已重试 ${MAX_RETRIES} 次仍失败：${String(error.message || error)}`
        );
      }
    }
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function formatNumber(value, fallback = "0") {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  if (Number.isInteger(number)) {
    return String(number);
  }

  return number
    .toFixed(4)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

function maskEmail(email) {
  if (!email || !email.includes("@")) {
    return email || "未知账号";
  }

  const parts = email.split("@");
  const name = parts[0];
  const domain = parts.slice(1).join("@");

  if (name.length <= 2) {
    return `${name.slice(0, 1)}***@${domain}`;
  }

  return `${name.slice(0, 2)}***@${domain}`;
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
    log(`账号存储解析失败：${String(error)}`);
    return [];
  }
}

function writeAccounts(accounts) {
  return $persistentStore.write(
    JSON.stringify(accounts),
    STORE_KEY
  );
}

function request(method, options) {
  return new Promise((resolve, reject) => {
    const callback = (error, response, body) => {
      if (error) {
        reject(new Error(String(error)));
        return;
      }

      resolve({
        statusCode: Number(
          response && (response.status || response.statusCode)
        ) || 0,
        headers: response ? response.headers || {} : {},
        body: body || ""
      });
    };

    const requestOptions = {
      ...options,
      timeout: REQUEST_TIMEOUT
    };

    if (method === "GET") {
      $httpClient.get(requestOptions, callback);
    } else {
      $httpClient.post(requestOptions, callback);
    }
  });
}

function buildHeaders(cookie, includeJsonContentType = false) {
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
    Cookie: cookie,
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) " +
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
  };

  if (includeJsonContentType) {
    headers["Content-Type"] =
      "application/json;charset=UTF-8";
  }

  return headers;
}

function buildClashUrl(data) {
  if (!data || typeof data !== "object") {
    return "";
  }

  const userId =
    data.userId ||
    data.configureId ||
    "";

  const code = data.code || "";
  const port = data.port || "";

  if (!userId || !code || !port) {
    return "";
  }

  return (
    `${UPDATE_URL}/clash/` +
    `${userId}/${code}/${port}/glados.yaml`
  );
}

function getLatestCheckinRecord(records) {
  if (!Array.isArray(records)) {
    return null;
  }

  const checkins = records
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        item.business === "system:checkin"
    )
    .sort(
      (a, b) =>
        Number(b.time || 0) -
        Number(a.time || 0)
    );

  return checkins.length > 0 ? checkins[0] : null;
}

function isAlreadyChecked(message) {
  return /already|checked|repeat|已签到|重复签到|今天已经/i.test(
    String(message || "")
  );
}

function isInvalidLoginResponse(json, statusCode) {
  if (statusCode === 401 || statusCode === 403) {
    return true;
  }

  if (!json || typeof json !== "object") {
    return false;
  }

  const message = String(
    json.message ||
    json.msg ||
    ""
  );

  return /login|unauthorized|cookie|session|登录|未登录|失效/i.test(
    message
  );
}

async function checkin(cookie) {
  const response = await request("POST", {
    url: CHECKIN_URL,
    headers: buildHeaders(cookie, true),
    body: JSON.stringify({
      token: "glados.network"
    })
  });

  const json = safeJsonParse(response.body);

  if (isInvalidLoginResponse(json, response.statusCode)) {
    return {
      success: false,
      invalidCookie: true,
      message: "Cookie 已失效或账号未登录",
      points: "0",
      balance: "",
      streak: 0
    };
  }

  if (
    response.statusCode < 200 ||
    response.statusCode >= 300
  ) {
    throw new Error(
      `签到 HTTP ${response.statusCode}：` +
      response.body.slice(0, 160)
    );
  }

  if (!json) {
    throw new Error(
      `签到返回非 JSON：${response.body.slice(0, 160)}`
    );
  }

  const message = String(
    json.message ||
    json.msg ||
    "无签到信息"
  );

  const latestRecord = getLatestCheckinRecord(json.list);

  const points = formatNumber(
    json.points !== undefined
      ? json.points
      : latestRecord
        ? latestRecord.change
        : 0
  );

  const balance = latestRecord
    ? formatNumber(latestRecord.balance, "")
    : "";

  return {
    success: json.code === 0 || isAlreadyChecked(message),
    invalidCookie: false,
    code: json.code,
    message,
    points,
    balance,
    streak: Number(json.streak || 0),
    date: latestRecord
      ? String(latestRecord.detail || "")
      : ""
  };
}

async function getStatus(cookie) {
  const response = await request("GET", {
    url: STATUS_URL,
    headers: buildHeaders(cookie)
  });

  const json = safeJsonParse(response.body);

  if (isInvalidLoginResponse(json, response.statusCode)) {
    return {
      success: false,
      invalidCookie: true,
      message: "Cookie 已失效或账号未登录"
    };
  }

  if (
    response.statusCode < 200 ||
    response.statusCode >= 300
  ) {
    throw new Error(
      `状态查询 HTTP ${response.statusCode}：` +
      response.body.slice(0, 160)
    );
  }

  if (!json) {
    throw new Error(
      `状态返回非 JSON：${response.body.slice(0, 160)}`
    );
  }

  if (json.code !== 0 || !json.data) {
    return {
      success: false,
      invalidCookie: false,
      message:
        json.message ||
        json.msg ||
        `状态接口 code=${json.code}`
    };
  }

  const data = json.data;

  const notifications = Array.isArray(data.notifications)
    ? data.notifications.filter(
        (item) => item && item.enable
      )
    : [];

  return {
    success: true,
    invalidCookie: false,
    email: String(data.email || ""),
    userId: String(
      data.userId ||
      data.configureId ||
      ""
    ),
    configureId: String(data.configureId || ""),
    leftDays: formatNumber(data.leftDays),
    vip: data.vip || 0,
    region: String(data.region || ""),
    traffic: data.traffic || 0,
    clashUrl: buildClashUrl(data),
    notifications
  };
}

function formatAccountResult(
  index,
  account,
  checkinResult,
  statusResult,
  errors
) {
  const email =
    statusResult && statusResult.email
      ? statusResult.email
      : account.email || `账号 ${index + 1}`;

  const lines = [
    `【${index + 1}】${maskEmail(email)}`
  ];

  if (checkinResult) {
    lines.push(`签到：${checkinResult.message}`);

    if (!checkinResult.invalidCookie) {
      lines.push(`本次点数：${checkinResult.points}`);

      if (checkinResult.balance) {
        lines.push(`当前积分：${checkinResult.balance}`);
      }

      lines.push(
        `连续签到：${checkinResult.streak} 天`
      );
    }
  }

  if (statusResult && statusResult.success) {
    lines.push(
      `剩余天数：${statusResult.leftDays} 天`
    );
    lines.push(`会员等级：VIP ${statusResult.vip}`);
    lines.push(
      `区域：${statusResult.region || "未知"}`
    );

    /*
     * 订阅地址属于敏感信息，默认不放入系统通知。
     * 仍会保存在 persistent-store 的账号数据中。
     */

    for (const notice of statusResult.notifications) {
      lines.push(
        `系统通知：${notice.title || "系统通知"}`
      );

      const messages = Array.isArray(notice.messages)
        ? notice.messages
        : [];

      for (const message of messages) {
        lines.push(`通知内容：${message}`);
      }
    }
  }

  if (errors.length > 0) {
    lines.push(`异常：${errors.join("；")}`);
  }

  return lines.join("\n");
}

function mergeDuplicateAccounts(accounts) {
  const result = [];
  const userIdMap = {};

  for (const account of accounts) {
    const userId = String(account.userId || "");

    if (!userId) {
      result.push(account);
      continue;
    }

    if (userIdMap[userId] === undefined) {
      userIdMap[userId] = result.length;
      result.push(account);
      continue;
    }

    const oldIndex = userIdMap[userId];
    const oldAccount = result[oldIndex];

    /*
     * 同一 userId 保留更新时间较新的 Cookie。
     */
    if (
      Number(account.updatedAt || 0) >=
      Number(oldAccount.updatedAt || 0)
    ) {
      result[oldIndex] = {
        ...oldAccount,
        ...account
      };
    }
  }

  return result;
}

async function processAccount(account, index) {
  const errors = [];
  let checkinResult = null;
  let statusResult = null;
  let invalidCookie = false;

  try {
    checkinResult = await runWithRetry(
      () => checkin(account.cookie),
      `账号 ${index + 1} 签到`
    );

    if (checkinResult.invalidCookie) {
      invalidCookie = true;
    }
  } catch (error) {
    errors.push(`签到失败：${String(error.message || error)}`);
  }

  // 无论签到成功还是失败，查询状态前都主动等待，避免连续请求。
  await sleep(REQUEST_DELAY_MS);

  try {
    statusResult = await runWithRetry(
      () => getStatus(account.cookie),
      `账号 ${index + 1} 状态查询`
    );

    if (statusResult.invalidCookie) {
      invalidCookie = true;
    }
  } catch (error) {
    errors.push(
      `状态查询失败：${String(error.message || error)}`
    );
  }

  const now = Date.now();
  const updatedAccount = {
    ...account,
    updatedAt: now
  };

  if (statusResult && statusResult.success) {
    updatedAccount.email = statusResult.email;
    updatedAccount.userId = statusResult.userId;
    updatedAccount.configureId =
      statusResult.configureId;
    updatedAccount.leftDays =
      statusResult.leftDays;
    updatedAccount.vip = statusResult.vip;
    updatedAccount.region =
      statusResult.region;
    updatedAccount.clashUrl =
      statusResult.clashUrl;
  }

  if (checkinResult && checkinResult.success) {
    updatedAccount.lastCheckin = {
      message: checkinResult.message,
      points: checkinResult.points,
      balance: checkinResult.balance,
      streak: checkinResult.streak,
      date: checkinResult.date,
      time: now
    };
  }

  if (
    errors.length === 0 &&
    !invalidCookie &&
    statusResult &&
    statusResult.success
  ) {
    updatedAccount.lastSuccessAt = now;
    updatedAccount.lastError = "";
  } else {
    updatedAccount.lastError = invalidCookie
      ? "Cookie 已失效"
      : errors.join("；");
  }

  const message = formatAccountResult(
    index,
    updatedAccount,
    checkinResult,
    statusResult,
    errors
  );

  return {
    account: updatedAccount,
    message,
    invalidCookie,
    success:
      !invalidCookie &&
      Boolean(checkinResult && checkinResult.success) &&
      Boolean(statusResult && statusResult.success)
  };
}

async function main() {
  let accounts = readAccounts();

  if (accounts.length === 0) {
    $notification.post(
      "GLaDOS 签到",
      "尚未保存 Cookie",
      "请开启模块后登录 glados.network，并进入账户页面。"
    );

    log("未读取到账号 Cookie");
    return;
  }

  const processedAccounts = [];
  const messages = [];

  let successCount = 0;
  let failedCount = 0;
  let invalidCount = 0;

  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index];

    log(`开始处理账号 ${index + 1}`);

    try {
      const result = await processAccount(
        account,
        index
      );

      if (result.invalidCookie) {
        invalidCount += 1;

        if (!AUTO_REMOVE_INVALID_COOKIE) {
          processedAccounts.push(result.account);
        }
      } else {
        processedAccounts.push(result.account);
      }

      if (result.success) {
        successCount += 1;
      } else {
        failedCount += 1;
      }

      messages.push(result.message);
    } catch (error) {
      failedCount += 1;

      processedAccounts.push({
        ...account,
        lastError: String(error),
        updatedAt: Date.now()
      });

      messages.push(
        `【${index + 1}】账号处理失败\n${String(error)}`
      );
    }

    if (index < accounts.length - 1) {
      await sleep(ACCOUNT_DELAY_MS);
    }
  }

  accounts = mergeDuplicateAccounts(processedAccounts);
  writeAccounts(accounts);

  const subtitle =
    `成功 ${successCount}｜异常 ${failedCount}` +
    (invalidCount > 0
      ? `｜失效 ${invalidCount}`
      : "");

  const body =
    messages.join("\n\n") +
    `\n\n当前保存账号：${accounts.length}`;

  log(`${subtitle}\n${body}`);

  $notification.post(
    "GLaDOS 多账号签到",
    subtitle,
    body
  );
}

main()
  .catch((error) => {
    const message = String(error);

    log(`脚本运行失败：${message}`);

    $notification.post(
      "GLaDOS 签到",
      "脚本运行失败",
      message
    );
  })
  .finally(() => {
    $done();
  });
