"""应用配置读写：AI 接口凭证等。

配置落在 {userData}/config.json（复用 database.get_data_dir()，保证与数据库、
uploads 同处一个跨平台用户数据目录，禁止硬编码绝对路径）。

存储字段（兼容 OpenAI 规范的 API，如 Qwen-VL / Claude / DeepSeek）：
- api_key    ：接口密钥
- base_url   ：接口 Endpoint（如 https://api.openai.com/v1）
- model_name ：模型名（需具备多模态 vision 能力才能识图）
"""

import json
from pathlib import Path

import database

DEFAULT_CONFIG = {
    "api_key": "",
    "base_url": "",
    "model_name": "",
}


def get_config_path() -> Path:
    """返回配置文件完整路径。"""
    return database.get_data_dir() / "config.json"


def read_config() -> dict:
    """读取配置，缺文件/缺字段时用默认空串补齐。"""
    path = get_config_path()
    if not path.exists():
        return dict(DEFAULT_CONFIG)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return dict(DEFAULT_CONFIG)
    merged = dict(DEFAULT_CONFIG)
    for key in DEFAULT_CONFIG:
        value = data.get(key)
        if isinstance(value, str):
            merged[key] = value
    return merged


def write_config(data: dict) -> dict:
    """写入配置（只保留已知字段），返回落盘后的完整配置。"""
    merged = read_config()
    for key in DEFAULT_CONFIG:
        value = data.get(key)
        if isinstance(value, str):
            merged[key] = value
    get_config_path().write_text(
        json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return merged
