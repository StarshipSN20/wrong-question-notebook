"""SQLite 数据库连接与建表逻辑。

阶段一只使用 Python 标准库 sqlite3，不引入 ORM，保持骨架最小可运行。

数据目录优先取环境变量 USER_DATA（由 Electron 主进程通过 app.getPath('userData')
传入），未设置时退回到 backend/data，便于脱离 Electron 单独调试后端。
所有路径用 pathlib 处理，确保 Windows 与 macOS 无缝运行。
"""

import os
import sqlite3
from pathlib import Path


def get_data_dir() -> Path:
    """返回数据根目录（含数据库与后续的 uploads），不存在时自动创建。"""
    env_dir = os.environ.get("USER_DATA")
    if env_dir:
        data_dir = Path(env_dir)
    else:
        # 兜底：backend/data（基于本文件位置，避免受启动工作目录影响）
        data_dir = Path(__file__).resolve().parent / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def get_db_path() -> Path:
    """返回数据库文件完整路径。"""
    return get_data_dir() / "notebook.db"


def get_connection() -> sqlite3.Connection:
    """返回一个新的数据库连接。

    row_factory 设为 sqlite3.Row，便于把查询结果转换成 dict。
    """
    conn = sqlite3.connect(get_db_path())
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """初始化数据库：创建 problems（错题）表。"""
    conn = get_connection()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS problems (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                image_path       TEXT,
                raw_text         TEXT,
                latex_code       TEXT,
                subject          TEXT,
                tags             TEXT,
                created_at       TEXT NOT NULL,
                next_review_date TEXT NOT NULL,
                review_stage     INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.commit()
    finally:
        conn.close()
