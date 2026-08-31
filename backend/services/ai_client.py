"""AI 客户端：调用 OpenAI 兼容的 Chat Completions 接口（含多模态 vision）。

通过 config.json 读取 api_key / base_url / model_name，因此兼容任意
OpenAI 规范的服务（Qwen-VL、Claude、DeepSeek 等）。上层用一个统一的
call_ai(prompt, image_base64=None) 即可完成纯文本或图文混合调用。
"""

import asyncio

import httpx

import config
from services import effort as effort_svc


class AIConfigError(Exception):
    """配置缺失或不完整（前端应提示用户去「设置」页填写）。"""


class AIRequestError(Exception):
    """调用上游 AI 接口失败。"""


# 合法档位＝完整阶梯（none…max），由 services/effort.py 统一定义。
# 具体某个模型能用哪几档，交给 effort_svc 按「探测结果 > 已知表 > 全给出」决定。
VALID_EFFORTS = set(effort_svc.LADDER)


def _resolve_effort(cfg: dict) -> str | None:
    """按当前模型把配置里的档位落到真实可用的档位；返回 None 表示不发送该参数。"""
    requested = cfg.get("reasoning_effort")
    if not isinstance(requested, str):
        return None
    base_url = cfg.get("base_url", "")
    model = cfg.get("model_name", "")

    info = effort_svc.describe(base_url, model)
    # source=default 表示「毫无信息」，此时不要按 supported 裁剪（那会假装全支持），
    # 原样发送并依赖下面的去参重试 + record_rejection 逐步学准。
    supported = None if info["source"] == "default" else info["supported"]
    return effort_svc.resolve(requested, supported)


# 各档位的请求超时（秒）。档位越高模型思考越久，固定 120 秒会把高档位直接判死：
# 实测 gpt-5.6-luna 在 max 档解一道 1500 字的多问题目，120 秒必然超时（502）。
# 只有阶梯里的档位有意义；auto/不发送参数时按 medium 估。
_EFFORT_TIMEOUTS = {
    "none": 120.0,
    "minimal": 120.0,
    "low": 180.0,
    "medium": 240.0,
    "high": 360.0,
    "xhigh": 540.0,
    "max": 900.0,
}
_DEFAULT_TIMEOUT = 240.0


def _timeout_for(effort: str | None) -> float:
    """按推理档位给出超时。档位越高给得越宽，避免高档位被误判成接口故障。"""
    return _EFFORT_TIMEOUTS.get(effort or "", _DEFAULT_TIMEOUT)


def _rejects_reasoning(resp) -> bool:
    """判断上游是否因 reasoning_effort 参数而报错（用于去参重试）。"""
    if resp.status_code not in (400, 404, 422, 500):
        return False
    text = (resp.text or "").lower()
    keywords = ("reasoning", "effort", "unsupported", "unrecognized", "unknown")
    return any(k in text for k in keywords)


def _build_endpoint(base_url: str) -> str:
    """把 base_url 规整为 chat/completions 完整地址。

    兼容用户填写的两种风格：带 /v1 或不带；末尾带不带斜杠均可。
    若用户已直接填到 /chat/completions 则原样使用。
    """
    url = base_url.strip().rstrip("/")
    if url.endswith("/chat/completions"):
        return url
    return f"{url}/chat/completions"


async def call_ai(
    prompt: str,
    image_base64: str | None = None,
    image_mime: str = "image/png",
    timeout: float | None = None,
) -> str:
    """调用 AI 并返回文本内容。

    prompt        ：文本指令。
    image_base64  ：可选，图片的 base64（不含 data: 前缀）。传入即走 vision。
    image_mime    ：图片 MIME 类型，用于拼 data URL。
    timeout       ：秒。缺省按推理档位自动给（见 _EFFORT_TIMEOUTS）——
                    高档位思考久，用固定值会把 max/xhigh 直接超时判死。
    """
    cfg = config.read_config()
    api_key = cfg.get("api_key", "").strip()
    base_url = cfg.get("base_url", "").strip()
    model_name = cfg.get("model_name", "").strip()

    missing = [
        name
        for name, value in (
            ("API Key", api_key),
            ("Base URL", base_url),
            ("Model Name", model_name),
        )
        if not value
    ]
    if missing:
        raise AIConfigError(
            "AI 配置不完整，请先在「设置」页填写：" + "、".join(missing)
        )

    if image_base64:
        content = [
            {"type": "text", "text": prompt},
            {
                "type": "image_url",
                "image_url": {"url": f"data:{image_mime};base64,{image_base64}"},
            },
        ]
    else:
        content = prompt

    payload = {
        "model": model_name,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.2,
    }

    # 推理强度：各家模型档位不一致（有的只到 high，有的还有 xhigh/max，
    # 有的完全不支持），故先按「该模型实际可用档位」降级（如选了 max 但只支持
    # 到 high → 发 high）；"auto"/空值不发送。发送后若仍被上游拒绝，
    # 下面会记录该档位并去掉参数重试一次，保证任何模型都能用。
    effort = _resolve_effort(cfg)
    if effort:
        payload["reasoning_effort"] = effort

    # 超时随档位放宽（调用方没显式指定时）
    effective_timeout = timeout if timeout is not None else _timeout_for(effort)

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    endpoint = _build_endpoint(base_url)

    async def _post(body: dict):
        try:
            async with httpx.AsyncClient(timeout=effective_timeout) as client:
                return await client.post(endpoint, json=body, headers=headers)
        except httpx.TimeoutException as exc:
            # 单独报超时：否则会被下面那条「无法连接」吞掉，用户以为是网络断了，
            # 实际是档位太高、题目太长。提示里给出可操作的建议。
            raise AIRequestError(
                f"AI 接口在 {effective_timeout:.0f} 秒内没有返回"
                f"（当前推理档位：{effort or 'auto'}）。"
                "题目较长时高档位会很慢，可在「设置」里把推理强度调低一档后重试。"
            ) from exc
        except httpx.RequestError as exc:
            raise AIRequestError(f"无法连接 AI 接口：{exc}") from exc

    resp = await _post(payload)

    # 模型不认 reasoning_effort（常见：非推理模型、档位名不同）→ 去掉重试。
    # 同时把「这一档被拒了」记进缓存，下次直接降到相邻可用档位，不用再白跑一趟。
    if resp.status_code != 200 and "reasoning_effort" in payload:
        if _rejects_reasoning(resp):
            effort_svc.record_rejection(base_url, model_name, payload["reasoning_effort"])
            retry_payload = {k: v for k, v in payload.items() if k != "reasoning_effort"}
            resp = await _post(retry_payload)

    if resp.status_code != 200:
        # 上游 5xx + 高档位：大概率是网关自己扛不住这么长的思考时间就断了。
        # 实测 gpt-5.6-luna 在 max 档解 1561 字的多问题目，网关 314 秒后回 502，
        # 同一题降到 high 只要 32 秒且正常返回。所以这种情况要给出可操作的建议，
        # 而不是把一串上游报文糊在用户脸上。
        # 注意这类失败**探测不出来**：探测用的是 "hi"，再高的档位也秒回。
        if resp.status_code >= 500 and effort in ("high", "xhigh", "max"):
            raise AIRequestError(
                f"AI 接口返回 {resp.status_code}（当前推理档位：{effort}）。"
                "题目较长时高档位耗时过久，上游网关可能中途断开；"
                "建议在「设置」里把推理强度降低一档后重试。"
                f"上游信息：{resp.text[:200]}"
            )
        raise AIRequestError(
            f"AI 接口返回 {resp.status_code}：{resp.text[:500]}"
        )

    try:
        data = resp.json()
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, ValueError) as exc:
        raise AIRequestError(f"AI 响应格式异常：{resp.text[:500]}") from exc


# ---------------------------------------------------------------------------
# 档位探测 / 模型列表
# ---------------------------------------------------------------------------
def _require_config() -> tuple[str, str, str]:
    """取出并校验 api_key / base_url / model_name。"""
    cfg = config.read_config()
    api_key = cfg.get("api_key", "").strip()
    base_url = cfg.get("base_url", "").strip()
    model_name = cfg.get("model_name", "").strip()
    missing = [
        name
        for name, value in (
            ("API Key", api_key),
            ("Base URL", base_url),
            ("Model Name", model_name),
        )
        if not value
    ]
    if missing:
        raise AIConfigError("AI 配置不完整，请先在「设置」页填写：" + "、".join(missing))
    return api_key, base_url, model_name


async def list_models(timeout: float = 30.0) -> list[str]:
    """拉上游的模型列表（GET {base_url}/models），返回模型 id 列表。

    OpenAI 规范里 /models 是标准接口，中转网关一般也实现了；
    拿不到就抛错，由前端提示用户手填模型名。
    """
    api_key, base_url, _ = _require_config()
    url = base_url.rstrip("/")
    if url.endswith("/chat/completions"):
        url = url[: -len("/chat/completions")]
    url = f"{url}/models"

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers={"Authorization": f"Bearer {api_key}"})
    except httpx.RequestError as exc:
        raise AIRequestError(f"无法连接 AI 接口：{exc}") from exc

    if resp.status_code != 200:
        raise AIRequestError(f"获取模型列表失败（{resp.status_code}）：{resp.text[:300]}")

    try:
        data = resp.json()
    except ValueError as exc:
        raise AIRequestError("模型列表响应不是合法 JSON") from exc

    items = data.get("data") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise AIRequestError("模型列表响应格式异常")

    models = []
    for item in items:
        if isinstance(item, dict):
            mid = item.get("id") or item.get("name")
        else:
            mid = item
        if isinstance(mid, str) and mid.strip():
            models.append(mid.strip())
    return sorted(set(models))


async def probe_efforts(timeout: float = 60.0) -> dict:
    """逐档试探当前模型支持哪些 reasoning_effort，并把结果写进缓存。

    做法：对阶梯上每一档各发一次极小请求（1 个 token 的问题），看是否被拒。
    - 200            → 支持
    - 命中「拒收该参数」特征 → 不支持
    - 其它错误/超时   → 结论不明（inconclusive），既不算支持也不算不支持

    先发一次**不带该参数**的基线请求：若基线本身就失败（key 错、模型名错、
    网关不认 max_tokens 之类），说明失败与档位无关，这时直接报错，
    绝不能把「全都失败」误判成「一档都不支持」。
    """
    api_key, base_url, model_name = _require_config()
    endpoint = _build_endpoint(base_url)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    def body(level: str | None) -> dict:
        payload = {
            "model": model_name,
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 16,
        }
        if level:
            payload["reasoning_effort"] = level
        return payload

    async def send(level: str | None):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                return await client.post(endpoint, json=body(level), headers=headers)
        except httpx.RequestError:
            return None  # 超时/网络错 → 结论不明

    baseline = await send(None)
    if baseline is None:
        raise AIRequestError("无法连接 AI 接口，探测中止")
    if baseline.status_code != 200:
        raise AIRequestError(
            "基线请求（不带 reasoning_effort）就失败了，"
            f"请先检查 API Key / Base URL / 模型名：{baseline.status_code} "
            f"{baseline.text[:300]}"
        )

    results = await asyncio.gather(*(send(level) for level in effort_svc.LADDER))

    supported, rejected, inconclusive = [], [], []
    for level, resp in zip(effort_svc.LADDER, results):
        if resp is None:
            inconclusive.append(level)
        elif resp.status_code == 200:
            supported.append(level)
        elif _rejects_reasoning(resp):
            rejected.append(level)
        else:
            inconclusive.append(level)

    entry = effort_svc.save_probe(base_url, model_name, supported, rejected)
    return {
        "model": model_name,
        "supported": entry["supported"],
        "rejected": entry["rejected"],
        "inconclusive": inconclusive,
        "ladder": list(effort_svc.LADDER),
        "source": "probe",
    }
