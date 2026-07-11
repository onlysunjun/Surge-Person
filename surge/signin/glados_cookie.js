const cookie = $request.headers["Cookie"] || $request.headers["cookie"];

if (cookie.includes("koa:sess")) {
    $persistentStore.write(cookie, "glados_cookie");

    $notification.post(
        "GLaDOS",
        "Cookie更新成功",
        "已保存到 Surge 持久化存储"
    );
}

$done({});
