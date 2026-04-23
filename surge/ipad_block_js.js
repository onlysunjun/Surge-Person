const TARGET_MODULE = "iPad Night Block";

// 当前小时
const hour = new Date().getHours();

// 22:00-23:59 或 00:00-06:59 => 启用
const shouldEnable = (hour >= 11 || hour < 24);

// 先读取当前模块状态
$httpAPI("GET", "/v1/modules", null, (result) => {
  if (!result || !result.enabled || !result.available) {
    console.log("Failed to query modules.");
    $done({});
    return;
  }

  const enabledModules = result.enabled || [];
  const availableModules = result.available || [];

  if (!availableModules.includes(TARGET_MODULE)) {
    console.log(`Module not found: ${TARGET_MODULE}`);
    $done({});
    return;
  }

  const isEnabled = enabledModules.includes(TARGET_MODULE);

  // 状态已正确，无需修改
  if (isEnabled === shouldEnable) {
    console.log(`No change needed. ${TARGET_MODULE}: ${isEnabled ? "enabled" : "disabled"}`);
    $done({});
    return;
  }

  // 切换模块状态
  const body = {};
  body[TARGET_MODULE] = shouldEnable;

  $httpAPI("POST", "/v1/modules", body, (resp) => {
    console.log(`${TARGET_MODULE} -> ${shouldEnable ? "enabled" : "disabled"}`);
    $done({});
  });
});
