# 打包说明

## 产物

| 平台 | 命令 | 产物 |
|------|------|------|
| Windows | `npm run dist:win` | `release/MistakeNotebook-<版本>-setup.exe`（NSIS 安装包） |
| macOS | `npm run dist:mac` | `release/MistakeNotebook-<版本>-<arch>.dmg`（需在 Mac 上执行） |

版本号取自 `package.json` 的 `version`；macOS 产物名带 arch（如 `-arm64`），
因为 PyInstaller 打出的后端二进制是跟着构建机架构走的，不同架构不能混用。

免安装版在 `release/win-unpacked/`（Windows 可直接运行其中的 `数理化错题本.exe`）。

## 前置步骤（两个平台都要做）

1. **打包后端**（PyInstaller 单文件）：
   ```bash
   cd backend
   venv\Scripts\pyinstaller backend.spec --noconfirm     # Windows
   venv/bin/pyinstaller backend.spec --noconfirm        # macOS
   ```
   产物：`backend/dist/mistake-backend(.exe)`。该目录被 electron-builder 作为
   `extraResources` 原样带进安装包。

2. **构建应用安装包**（Windows 本机即可；macOS 必须在 Mac 上执行，
   因为 dmg 与代码签名需要 macOS 环境）：
   ```bash
   npm run dist:win    # Windows
   npm run dist:mac    # macOS（需装 node/npm/electron 依赖）
   ```

## macOS 的两种构建方式

**方式一：有一台 Mac**（任何 Mac 都行，借一台也可以）
把项目拷过去，装好 Node.js 与 Python 3，然后按上面的两步执行即可：
```bash
cd backend && pip install -r requirements.txt pyinstaller && pyinstaller backend.spec --noconfirm
cd .. && npm install && npm run dist:mac
```
产物在 `release/MistakeNotebook-<版本>-<arch>.dmg`。

**方式二：没有 Mac**（用 GitHub Actions 免费 macOS 服务器，无需本地 Mac）
项目已内置 `.github/workflows/build-mac.yml`：
1. 在 GitHub 注册账号并新建一个仓库（设为 Private 即可）
2. 把整个 `wrong-question-notebook` 项目推上去（命令见下面）
3. 仓库的 **Actions** 页面 → 左侧选中 **Build macOS dmg** → 右侧 **Run workflow** → 运行
4. 跑完后（约 10 分钟）在运行记录里下载 **mac-dmg** 产物，即 `.dmg` 安装包

推送项目到 GitHub 的命令（首次）：
```bash
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git branch -M main
git push -u origin main
```

## macOS 报「已损坏，无法打开」怎么办

这是**没有签名**导致的，不是文件真的坏了。两个原因，可能同时存在：

**原因一：缺少签名（Apple Silicon 必然触发）**
Apple Silicon（M 系列芯片）上，macOS 内核**拒绝加载完全没有签名的 arm64 二进制**，
Finder 就报「已损坏」。这和「来自身份不明的开发者」是**两回事**：
- 「身份不明的开发者」→ 可以在「隐私与安全性」里点「仍要打开」放行；
- 「已损坏」→ **改任何隐私设置都没用**，因为二进制根本没被加载。

项目已通过 `scripts/afterPack.js` 打 **ad-hoc 签名**（`codesign --sign -`）解决，
不需要 Apple 开发者证书。CI 里有一步 `Verify ad-hoc signature` 专门校验它生效，
所以新构建的 dmg 不该再出现这个问题。

**原因二：隔离属性（quarantine）**
从浏览器 / GitHub 下载的 dmg 会被打上 `com.apple.quarantine`，
未签名（或仅 ad-hoc 签名）时也可能报「已损坏」。用户侧一行命令清掉：

```bash
# 对下载到的 dmg 执行（路径换成实际位置）
xattr -d com.apple.quarantine ~/Downloads/MistakeNotebook-0.2.0-arm64.dmg

# 若已经拖进「应用程序」后才报错，对 .app 执行：
xattr -cr /Applications/MistakeNotebook.app
```

之后正常双击即可。若仍提示「身份不明的开发者」，
去「系统设置 → 隐私与安全性」点「仍要打开」——那一步才是这个设置管的。

## 注意事项

- **macOS 上 PyInstaller 的 conda DLL 问题不存在**（mac 是 dylib 且 PyInstaller
  能正确收集）；`backend.spec` 里的 DLL 附加逻辑仅在 Windows 分支生效。
- `backend.spec` 的 conda DLL 探测路径写死了 `E:\miniconda3` 等常用位置，
  换机器打包时如遇 `DLL load failed while importing _ctypes/_sqlite3`，
  把实际 conda 路径加进 `conda_bases` 列表即可。
- 应用数据（数据库/上传文件/配置）存放在系统用户数据目录
  （Windows: `%APPDATA%\wrong-question-notebook`），卸载/升级不会丢数据。
- 图标未配置（使用 Electron 默认图标）；需要品牌图标时在 package.json
  build 配置里加 `icon` 并重新打包。
