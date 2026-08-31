// electron-builder afterPack 钩子：给 macOS 产物打「ad-hoc 签名」。
//
// 【为什么必须做这件事】
// Apple Silicon（arm64）上，macOS 内核**拒绝执行完全没有签名的 arm64 二进制**，
// Finder 报的是「已损坏，无法打开，你应该将它移到废纸篓」。
// 注意这**不是** Gatekeeper 的「来自身份不明的开发者」——两者是不同的拦截：
//   - Gatekeeper（身份不明）：可以用「隐私与安全性 → 仍要打开」放行；
//   - 缺签名（已损坏）    ：改任何隐私设置都没用，因为二进制根本加载不了。
// 用户实测：把「允许任何来源」打开后仍报「已损坏」，正是后者。
//
// ad-hoc 签名（codesign --sign -）不需要任何 Apple 开发者证书，
// 只是给二进制盖一个自签的空标识，足以让内核愿意加载它。
//
// 【签名顺序很重要】必须从内到外：先签嵌套的可执行文件，最后签 .app 外壳。
// 反过来做会破坏外壳的封印（签完 .app 再改内部文件 → 签名失效 → 又变「已损坏」）。

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function sign(target, extraArgs = []) {
  execFileSync(
    "codesign",
    ["--force", "--timestamp=none", "--sign", "-", ...extraArgs, target],
    { stdio: "inherit" }
  );
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[afterPack] ad-hoc 签名：${appPath}`);

  // 1. 先签 PyInstaller 打出来的后端二进制。
  //    它走 extraResources 放在 Resources/backend/ 下，不在标准 bundle 位置，
  //    --deep 不一定覆盖得到，所以显式签一次。
  const backend = path.join(
    appPath,
    "Contents",
    "Resources",
    "backend",
    "mistake-backend"
  );
  if (fs.existsSync(backend)) {
    console.log("[afterPack] 签名后端二进制 mistake-backend");
    sign(backend);
  } else {
    console.warn(`[afterPack] 警告：未找到后端二进制 ${backend}`);
  }

  // 2. 再签整个 .app（--deep 一并覆盖 Electron Framework 与各 Helper）。
  //    --deep 在正式签名场景下已不推荐，但 ad-hoc 只求内核放行，这样最省事。
  console.log("[afterPack] 签名 .app 外壳");
  sign(appPath, ["--deep"]);

  // 3. 立刻自检：签名无效的话现在就失败，别等用户装完才发现。
  console.log("[afterPack] 校验签名");
  execFileSync("codesign", ["--verify", "--deep", "--verbose=2", appPath], {
    stdio: "inherit",
  });
  console.log("[afterPack] ad-hoc 签名完成");
};
