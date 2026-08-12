# backend.spec — PyInstaller 打包 FastAPI 后端的配置。
#
# 用法（在 backend/ 目录下）：
#   venv\Scripts\pyinstaller backend.spec
# 产物：backend/dist/mistake-backend(.exe)
#
# console=False：不弹黑窗（Electron 主进程以子进程方式启动它）。
# 注意：windowed 模式下后端的 stdout/stderr 不再可见，日志仅供开发用。

import os
import sys

from PyInstaller.utils.hooks import collect_submodules

# uvicorn 通过动态导入加载 loop/protocol/lifespan 实现，需显式收集子模块，
# 否则打包后启动会报 "No loop implementation specified" 之类错误。
hiddenimports = collect_submodules("uvicorn")

# conda 构建的 Python：标准库与扩展模块（_ctypes / _sqlite3 / _ssl 等）依赖
# conda Library\\bin 下的 DLL，PyInstaller 常常漏收集，运行时报
# "DLL load failed while importing xxx"。下面按 pefile 扫描出的清单收集。
# （macOS 不需要；binaries/datas 必须在此初始化，供各平台共用。）
binaries = []
datas = []
if sys.platform == "win32":
    conda_bases = [
        os.environ.get("CONDA_PREFIX", ""),
        os.path.dirname(os.path.dirname(sys.executable)),  # venv 的上级
        r"C:\ProgramData\miniconda3",
        r"C:\ProgramData\anaconda3",
        r"C:\miniconda3",
        r"C:\anaconda3",
        r"E:\miniconda3",
    ]
    needed = [
        "ffi.dll",            # _ctypes
        "sqlite3.dll",        # _sqlite3
        "libcrypto-3-x64.dll",  # _ssl / hashlib
        "libssl-3-x64.dll",   # _ssl
        "libbz2.dll",         # _bz2
        "liblzma.dll",        # _lzma
        "libmpdec-4.dll",     # _decimal
        "libexpat.dll",       # pyexpat
    ]
    found = []
    for base in conda_bases:
        if not base:
            continue
        bindir = os.path.join(base, "Library", "bin")
        for name in needed:
            p = os.path.join(bindir, name)
            if os.path.exists(p) and p not in found:
                found.append(p)
        if len(found) >= len(needed):
            break
    binaries = [(p, ".") for p in found]
    if found:
        print(f"[backend.spec] 已附带 conda DLL: {[os.path.basename(p) for p in found]}")
    # 注意：sqlite3.dll 会被 PyInstaller 的 hook 收集逻辑从 binaries 中去重掉，
    # 导致 pkg 里缺失。故改走 datas + 运行时 os.add_dll_directory(_MEIPASS)。
    for base in conda_bases:
        if not base:
            continue
        p = os.path.join(base, "Library", "bin", "sqlite3.dll")
        if os.path.exists(p):
            datas = [(p, ".")]
            break
    if datas:
        print(f"[backend.spec] sqlite3.dll 走 datas 携带: {datas}")

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=[
        "tkinter",
        "matplotlib",
        "numpy",
        "pandas",
        "scipy",
        "PIL",
        "IPython",
        "jupyter",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="mistake-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,  # 不显示控制台窗口
    disable_windowed_traceback=False,
)
