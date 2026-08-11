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
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    endpoint = _build_endpoint(base_url)

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(endpoint, json=payload, headers=headers)
    except httpx.RequestError as exc:
        raise AIRequestError(f"无法连接 AI 接口：{exc}") from exc

    if resp.status_code != 200:
        raise AIRequestError(
            f"AI 接口返回 {resp.status_code}：{resp.text[:500]}"
        )

    try:
        data = resp.json()
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, ValueError) as exc:
        raise AIRequestError(f"AI 响应格式异常：{resp.text[:500]}") from exc
