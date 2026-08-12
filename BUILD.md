# 打包说明

## 产物

| 平台 | 命令 | 产物 |
|------|------|------|
| Windows | `npm run dist:win` | `release/数理化错题本-0.1.0-setup.exe`（NSIS 安装包） |
| macOS | `npm run dist:mac` | `release/数理化错题本-0.1.0.dmg`（需在 Mac 上执行） |

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
