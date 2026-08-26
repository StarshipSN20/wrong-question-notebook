"""AI 客户端：调用 OpenAI 兼容的 Chat Completions 接口（含多模态 vision）。

通过 config.json 读取 api_key / base_url / model_name，因此兼容任意
OpenAI 规范的服务（Qwen-VL、Claude、DeepSeek 等）。上层用一个统一的
call_ai(prompt, image_base64=None) 即可完成纯文本或图文混合调用。
"""

import httpx

import config


class AIConfigError(Exception):
    """配置缺失或不完整（前端应提示用户去「设置」页填写）。"""


class AIRequestError(Exception):
    """调用上游 AI 接口失败。"""


# 允许的推理强度档位（OpenAI / OpenRouter 通用命名）。
VALID_EFFORTS = {"minimal", "low", "medium", "high"}


def _normalize_effort(value) -> str | None:
    """规整推理强度：合法档位返回小写字符串，auto/空/非法值返回 None（=不发送）。"""
    if not isinstance(value, str):
        return None
    v = value.strip().lower()
    return v if v in VALID_EFFORTS else None


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
    timeout: float = 120.0,
) -> str:
    """调用 AI 并返回文本内容。

    prompt        ：文本指令。
    image_base64  ：可选，图片的 base64（不含 data: 前缀）。传入即走 vision。
    image_mime    ：图片 MIME 类型，用于拼 data URL。
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

    # 推理强度：各家模型档位不一致（有的只支持 low/medium/high，有的还有
    # minimal，有的完全不支持），故 "auto"/空值时不发送；发送后若被上游拒绝，
    # 下面会自动去掉该参数重试一次，保证任何模型都能用。
    effort = _normalize_effort(cfg.get("reasoning_effort"))
    if effort:
        payload["reasoning_effort"] = effort

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    endpoint = _build_endpoint(base_url)

    async def _post(body: dict):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                return await client.post(endpoint, json=body, headers=headers)
        except httpx.RequestError as exc:
            raise AIRequestError(f"无法连接 AI 接口：{exc}") from exc

    resp = await _post(payload)

    # 模型不认 reasoning_effort（常见：非推理模型、档位名不同）→ 去掉重试。
    if resp.status_code != 200 and "reasoning_effort" in payload:
        if _rejects_reasoning(resp):
            retry_payload = {k: v for k, v in payload.items() if k != "reasoning_effort"}
            resp = await _post(retry_payload)

    if resp.status_code != 200:
        raise AIRequestError(
            f"AI 接口返回 {resp.status_code}：{resp.text[:500]}"
        )

    try:
        data = resp.json()
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, ValueError) as exc:
        raise AIRequestError(f"AI 响应格式异常：{resp.text[:500]}") from exc
