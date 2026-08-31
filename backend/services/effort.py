"""推理强度（reasoning_effort）档位：探测、缓存、按模型降级。

为什么不能只靠一张写死的表：
用户的 base_url 往往是**中转网关**（本机实测就是 api.apikey.fun + gpt-5.6-luna），
能用哪些档位由网关决定，跟模型名对不上；而且各家文档本身就不准（Gemini 3 Preview
拒收 medium、Gemini 3 Flash 不认文档里写着的 minimal）。
所以以「真实探测结果」为准，写死的表只当没探测过时的提示。

三层数据来源，优先级从高到低：
1. probe   ：真的往上游发一次最小请求，看哪些档位不被拒（最可信）。
2. catalog ：按模型名匹配的已知档位（提示性质，可能过时）。
3. default ：整条阶梯全给出，发送时若被拒再自动去参重试（旧行为兜底）。

缓存落在 {userData}/effort_cache.json，按 "base_url::model" 分键，
因此换网关/换模型互不干扰。调用被上游拒绝时也会写回缓存（record_rejection），
用着用着就自己学准了。
"""

import json
import re
from pathlib import Path
from typing import Iterable

import database

# 完整阶梯，从低到高。"auto" 不在阶梯里——它表示「不发送该参数」。
LADDER = ("none", "minimal", "low", "medium", "high", "xhigh", "max")

AUTO = "auto"

# 已知模型的档位（提示用，不是真理）。键是对模型名做的正则匹配，先匹配到的先用。
# 依据是各家公开文档 + 社区实测，且文档本身就常有出入，故一律可被探测结果覆盖。
CATALOG: tuple[tuple[str, tuple[str, ...]], ...] = (
    # OpenAI Codex 系：额外有 xhigh
    (r"codex", ("none", "minimal", "low", "medium", "high", "xhigh")),
    # OpenAI GPT-5 及以后：none/minimal 起步
    (r"^gpt-5", ("none", "minimal", "low", "medium", "high")),
    # OpenAI o 系推理模型：low/medium/high
    (r"^o[134](?:-|$)", ("low", "medium", "high")),
    # Claude：effort 档位为 low/medium/high（Opus 5 起支持）
    (r"claude", ("low", "medium", "high")),
    # Gemini：OpenAI 兼容层收 none/low/high，medium 在部分版本被拒
    (r"gemini", ("none", "low", "medium", "high")),
    # Grok mini 支持 low/high；非 mini 的 Grok 多数不支持该参数
    (r"grok.*mini", ("low", "high")),
    # DeepSeek reasoner 不收 reasoning_effort
    (r"deepseek.*(reasoner|r1)", ()),
    # Qwen 思考模型走 enable_thinking，OpenAI 兼容层多数不认 effort
    (r"qwen", ()),
)


# ---------------------------------------------------------------------------
# 缓存
# ---------------------------------------------------------------------------
def _cache_path() -> Path:
    return database.get_data_dir() / "effort_cache.json"


def cache_key(base_url: str, model: str) -> str:
    """按「网关 + 模型」分键：同一模型换网关，可用档位可能不同。"""
    return f"{(base_url or '').strip().rstrip('/')}::{(model or '').strip()}"


def _read_cache() -> dict:
    path = _cache_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_cache(data: dict) -> None:
    try:
        _cache_path().write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError:
        pass  # 缓存写失败不影响功能，下次再探测即可


def read_entry(base_url: str, model: str) -> dict | None:
    """读某个「网关+模型」的探测记录；没有返回 None。"""
    entry = _read_cache().get(cache_key(base_url, model))
    return entry if isinstance(entry, dict) else None


def _normalize_levels(levels: Iterable[str]) -> list[str]:
    """按阶梯顺序排好、去重、丢掉非法值。"""
    seen = {str(v).strip().lower() for v in levels or ()}
    return [level for level in LADDER if level in seen]


def save_probe(base_url: str, model: str, supported: Iterable[str], rejected: Iterable[str]) -> dict:
    """写入一次探测结果，返回该条记录。

    若这次探测**全是结论不明**（网络抖动等，supported 与 rejected 都空），
    不覆盖已有记录——否则一次超时就把之前探到/学到的结果清空了。
    """
    key = cache_key(base_url, model)
    ok_levels = _normalize_levels(supported)
    bad_levels = _normalize_levels(rejected)

    cache = _read_cache()
    if not ok_levels and not bad_levels:
        existing = cache.get(key)
        if isinstance(existing, dict):
            return existing

    entry = {"source": "probe", "supported": ok_levels, "rejected": bad_levels}
    cache[key] = entry
    _write_cache(cache)
    return entry


def record_rejection(base_url: str, model: str, level: str) -> None:
    """真实调用中某档位被上游拒了 → 记下来，以后不再送这档。

    这让「没主动探测过」的用户也能越用越准：第一次撞墙之后，
    后续请求会自动降到相邻的可用档位，不用每次都白跑一趟再去参重试。
    """
    level = (level or "").strip().lower()
    if level not in LADDER:
        return
    cache = _read_cache()
    key = cache_key(base_url, model)
    entry = cache.get(key) if isinstance(cache.get(key), dict) else {}

    rejected = set(entry.get("rejected") or ())
    rejected.add(level)
    supported = [lv for lv in (entry.get("supported") or ()) if lv != level]

    cache[key] = {
        # 只有整条链路都靠拒绝推断出来时才叫 learned；探测过的保持 probe。
        "source": entry.get("source") or "learned",
        "supported": _normalize_levels(supported),
        "rejected": _normalize_levels(rejected),
    }
    _write_cache(cache)


def catalog_levels(model: str) -> list[str] | None:
    """按模型名查已知档位；没匹配到返回 None（注意空 tuple 表示「已知不支持」）。"""
    name = (model or "").strip().lower()
    if not name:
        return None
    for pattern, levels in CATALOG:
        if re.search(pattern, name):
            return list(levels)
    return None


def describe(base_url: str, model: str) -> dict:
    """给前端的档位信息：整条阶梯 + 当前模型可用的档位 + 数据来源。

    前端据此构建下拉框：supported 里的正常显示，其它标注「该模型可能不支持」
    而不是直接藏掉——万一探测结果偏保守，用户仍可手动选。
    """
    entry = read_entry(base_url, model)
    if entry and (entry.get("supported") or entry.get("rejected")):
        supported = _normalize_levels(entry.get("supported") or ())
        # learned 记录只知道「哪些被拒」，其余档位按未知处理（仍可选）。
        if entry.get("source") == "learned" and not supported:
            rejected = set(entry.get("rejected") or ())
            supported = [lv for lv in LADDER if lv not in rejected]
        return {
            "ladder": list(LADDER),
            "supported": supported,
            "rejected": _normalize_levels(entry.get("rejected") or ()),
            "source": entry.get("source") or "learned",
            "model": model,
        }

    known = catalog_levels(model)
    if known is not None:
        return {
            "ladder": list(LADDER),
            "supported": _normalize_levels(known),
            "rejected": [],
            "source": "catalog",
            "model": model,
        }

    # 完全未知（典型：中转网关的自定义模型名）→ 全给出，靠发送时降级兜底。
    return {
        "ladder": list(LADDER),
        "supported": list(LADDER),
        "rejected": [],
        "source": "default",
        "model": model,
    }


def resolve(requested: str | None, supported: Iterable[str] | None) -> str | None:
    """把用户选的档位落到该模型真的支持的档位上。

    规则（就是需求里的第 2 条兜底）：选了 max 但模型最高只到 high → 用 high。
    优先向下找最近的可用档位；下面没有了再向上找最低的可用档位；
    supported 为空（已知完全不支持）→ 返回 None，即不发送该参数。
    requested 为 auto/空/非法 → None。
    """
    level = (requested or "").strip().lower()
    if level == AUTO or level not in LADDER:
        return None

    available = _normalize_levels(supported or ())
    if not available:
        # 区分「已知不支持」与「压根没信息」：supported 传 None 表示无信息，
        # 此时原样发送，让上游自己判断（配合去参重试）。
        return None if supported is not None else level
    if level in available:
        return level

    idx = LADDER.index(level)
    lower = [lv for lv in available if LADDER.index(lv) < idx]
    if lower:
        return lower[-1]  # available 已按阶梯排序，取最后一个＝最接近的下一档
    return available[0]  # 下面没有可用档位 → 退到最低的可用档位
