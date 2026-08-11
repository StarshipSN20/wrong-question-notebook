"""FastAPI 入口：健康检查、错题 CRUD、AI 识图 / 修正、配置读写。

本地运行在 http://127.0.0.1:8000，供 Electron 主进程 spawn 拉起。
所有用户数据（DB / uploads / config）统一落在 USER_DATA 目录（见 database.py）。
"""

import base64
import hashlib
import json
import re
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import List, Optional

import aiofiles
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

import config
import database
from models import (
    ConfigModel,
    CorrectLatexRequest,
    ProblemCreate,
    ProblemOut,
    ProblemUpdate,
)
from services import ai_client

# 支持的图片扩展名 → MIME（走多模态 vision）。
IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}

# AI 识别提示词：要求严格返回 JSON，便于后端解析。
OCR_PROMPT = (
    "你是一个数理化错题识别助手。请识别图片中的题目，并只返回一个 JSON 对象，"
    "不要包含任何解释或 Markdown 代码块标记。JSON 字段如下：\n"
    '{"subject": "数学/物理/化学 之一", '
    '"latex_code": "题目内容，数学公式用 \\\\( \\\\) 行内或 \\\\[ \\\\] 行间 LaTeX 包裹", '
    '"raw_text": "题目的纯文本形式", '
    '"tags": ["知识点标签1", "知识点标签2"]}'
)

TEXT_PROMPT = (
    "你是一个数理化错题整理助手。下面是从文件中提取的题目文本，请整理它并只返回一个 "
    "JSON 对象，不要包含任何解释或 Markdown 代码块标记。JSON 字段如下：\n"
    '{"subject": "数学/物理/化学 之一", '
    '"latex_code": "题目内容，数学公式用 \\\\( \\\\) 行内或 \\\\[ \\\\] 行间 LaTeX 包裹", '
    '"raw_text": "题目的纯文本形式", '
    '"tags": ["知识点标签1", "知识点标签2"]}\n\n'
    "提取到的文本如下：\n"
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动时初始化数据库。"""
    database.init_db()
    yield


app = FastAPI(title="数理化错题本 API", version="0.2.0", lifespan=lifespan)

# 允许前端（Electron file:// 或 localhost）跨域访问本地 API。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def _row_to_problem(row) -> ProblemOut:
    """把 sqlite3.Row 转成 ProblemOut，tags 字段从 JSON 字符串反序列化。"""
    raw_tags = row["tags"]
    try:
        tags = json.loads(raw_tags) if raw_tags else []
    except (json.JSONDecodeError, TypeError):
        tags = []
    return ProblemOut(
        id=row["id"],
        image_path=row["image_path"],
        raw_text=row["raw_text"],
        latex_code=row["latex_code"],
        subject=row["subject"],
        tags=tags,
        created_at=row["created_at"],
        next_review_date=row["next_review_date"],
        review_stage=row["review_stage"],
        raw_image_hash=row["raw_image_hash"],
    )


def _fetch_problem(conn, problem_id: int):
    """按 id 查一条错题，返回 sqlite3.Row 或 None。"""
    return conn.execute(
        "SELECT * FROM problems WHERE id = ?", (problem_id,)
    ).fetchone()


def _parse_ai_json(text: str) -> dict:
    """从 AI 返回文本中解析出 JSON 对象，容忍 Markdown 代码块包裹。"""
    cleaned = text.strip()
    # 去掉 ```json ... ``` 或 ``` ... ``` 包裹
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", cleaned, re.DOTALL)
    if fence:
        cleaned = fence.group(1).strip()
    try:
        data = json.loads(cleaned)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass
    # 兜底：尝试截取第一个 { 到最后一个 }
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            data = json.loads(cleaned[start : end + 1])
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass
    # 实在解析不出，退回把整段文本当题目内容。
    return {"raw_text": text, "latex_code": text, "subject": None, "tags": []}


def _extract_pdf_text(path: Path) -> str:
    """提取 PDF 文本层（扫描版纯图片 PDF 会得到空串）。"""
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    return "\n".join((page.extract_text() or "") for page in reader.pages).strip()


def _extract_docx_text(path: Path) -> str:
    """提取 DOCX 段落文本。"""
    import docx

    document = docx.Document(str(path))
    return "\n".join(p.text for p in document.paragraphs).strip()


def _insert_problem(
    *,
    image_path: Optional[str],
    raw_text: Optional[str],
    latex_code: Optional[str],
    subject: Optional[str],
    tags: List[str],
    raw_image_hash: Optional[str],
) -> ProblemOut:
    """插入一条错题，created_at / next_review_date 默认当天，返回新记录。"""
    today = date.today().isoformat()
    tags_json = json.dumps(tags or [], ensure_ascii=False)

    conn = database.get_connection()
    try:
        cursor = conn.execute(
            """
            INSERT INTO problems
                (image_path, raw_text, latex_code, subject, tags,
                 created_at, next_review_date, review_stage, raw_image_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                image_path,
                raw_text,
                latex_code,
                subject,
                tags_json,
                today,
                today,
                0,
                raw_image_hash,
            ),
        )
        conn.commit()
        row = _fetch_problem(conn, cursor.lastrowid)
    finally:
        conn.close()

    if row is None:
        raise HTTPException(status_code=500, detail="创建错题后未能读取记录")
    return _row_to_problem(row)


# ---------------------------------------------------------------------------
# 基础接口
# ---------------------------------------------------------------------------
@app.get("/health")
def health() -> dict:
    """健康检查：返回服务运行状态。"""
    return {"status": "ok"}


@app.get("/api/problems", response_model=List[ProblemOut])
def list_problems() -> List[ProblemOut]:
    """获取错题列表（按创建时间倒序）。"""
    conn = database.get_connection()
    try:
        rows = conn.execute("SELECT * FROM problems ORDER BY id DESC").fetchall()
    finally:
        conn.close()
    return [_row_to_problem(row) for row in rows]


@app.post("/api/problems", response_model=ProblemOut, status_code=201)
def create_problem(problem: ProblemCreate) -> ProblemOut:
    """新增错题条目（手动录入）。"""
    return _insert_problem(
        image_path=problem.image_path,
        raw_text=problem.raw_text,
        latex_code=problem.latex_code,
        subject=problem.subject,
        tags=problem.tags,
        raw_image_hash=None,
    )


@app.patch("/api/problems/{problem_id}", response_model=ProblemOut)
def update_problem(problem_id: int, patch: ProblemUpdate) -> ProblemOut:
    """手动编辑错题（部分字段），支撑前端 LaTeX 源码「更新」按钮。"""
    conn = database.get_connection()
    try:
        row = _fetch_problem(conn, problem_id)
        if row is None:
            raise HTTPException(status_code=404, detail="错题不存在")

        fields = []
        values = []
        if patch.raw_text is not None:
            fields.append("raw_text = ?")
            values.append(patch.raw_text)
        if patch.latex_code is not None:
            fields.append("latex_code = ?")
            values.append(patch.latex_code)
        if patch.subject is not None:
            fields.append("subject = ?")
            values.append(patch.subject)
        if patch.tags is not None:
            fields.append("tags = ?")
            values.append(json.dumps(patch.tags, ensure_ascii=False))

        if fields:
            values.append(problem_id)
            conn.execute(
                f"UPDATE problems SET {', '.join(fields)} WHERE id = ?", values
            )
            conn.commit()

        row = _fetch_problem(conn, problem_id)
    finally:
        conn.close()
    return _row_to_problem(row)


# ---------------------------------------------------------------------------
# 配置接口
# ---------------------------------------------------------------------------
@app.get("/api/config", response_model=ConfigModel)
def get_config() -> ConfigModel:
    """读取 AI 配置。"""
    return ConfigModel(**config.read_config())


@app.post("/api/config", response_model=ConfigModel)
def save_config(cfg: ConfigModel) -> ConfigModel:
    """保存 AI 配置。"""
    saved = config.write_config(cfg.model_dump())
    return ConfigModel(**saved)


# ---------------------------------------------------------------------------
# AI 接口
# ---------------------------------------------------------------------------
@app.post("/api/upload", response_model=ProblemOut, status_code=201)
async def upload_problem(file: UploadFile = File(...)) -> ProblemOut:
    """上传图片/PDF/DOCX，AI 识别后存库并返回。

    图片走多模态 vision；PDF/DOCX 提取文本层后交给 AI 结构化。
    以文件内容 sha256 去重：命中已存在记录则直接返回旧记录。
    """
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="上传文件为空")

    file_hash = hashlib.sha256(content).hexdigest()

    # 去重：同一文件已上传过则直接返回旧记录。
    conn = database.get_connection()
    try:
        existing = conn.execute(
            "SELECT * FROM problems WHERE raw_image_hash = ?", (file_hash,)
        ).fetchone()
    finally:
        conn.close()
    if existing is not None:
        return _row_to_problem(existing)

    ext = Path(file.filename or "").suffix.lower()
    saved_path = database.get_uploads_dir() / f"{file_hash}{ext}"
    async with aiofiles.open(saved_path, "wb") as f:
        await f.write(content)

    try:
        if ext in IMAGE_MIME:
            image_b64 = base64.b64encode(content).decode("ascii")
            ai_text = await ai_client.call_ai(
                OCR_PROMPT, image_base64=image_b64, image_mime=IMAGE_MIME[ext]
            )
        elif ext == ".pdf":
            extracted = _extract_pdf_text(saved_path)
            if not extracted:
                raise HTTPException(
                    status_code=422,
                    detail="PDF 未提取到文本层（可能是扫描版纯图片 PDF），本阶段暂不支持。",
                )
            ai_text = await ai_client.call_ai(TEXT_PROMPT + extracted)
        elif ext == ".docx":
            extracted = _extract_docx_text(saved_path)
            if not extracted:
                raise HTTPException(status_code=422, detail="DOCX 未提取到文本内容。")
            ai_text = await ai_client.call_ai(TEXT_PROMPT + extracted)
        else:
            raise HTTPException(
                status_code=415,
                detail=f"不支持的文件类型：{ext or '未知'}（支持 PNG/JPG/PDF/DOCX）",
            )
    except ai_client.AIConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ai_client.AIRequestError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    parsed = _parse_ai_json(ai_text)
    return _insert_problem(
        image_path=str(saved_path),
        raw_text=parsed.get("raw_text"),
        latex_code=parsed.get("latex_code"),
        subject=parsed.get("subject"),
        tags=parsed.get("tags") or [],
        raw_image_hash=file_hash,
    )


@app.post("/api/correct-latex", response_model=ProblemOut)
async def correct_latex(req: CorrectLatexRequest) -> ProblemOut:
    """按用户的自然语言指令修正题目的 LaTeX，并更新数据库。"""
    conn = database.get_connection()
    try:
        row = _fetch_problem(conn, req.problem_id)
    finally:
        conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail="错题不存在")

    current_latex = row["latex_code"] or row["raw_text"] or ""
    prompt = (
        "你是一个 LaTeX 题目修正助手。下面是当前题目的 LaTeX 代码，请根据用户的修改要求"
        "输出修正后的完整 LaTeX 代码。只返回修正后的 LaTeX 代码本身，不要任何解释、"
        "不要 Markdown 代码块标记。\n\n"
        f"当前 LaTeX：\n{current_latex}\n\n"
        f"用户修改要求：{req.user_feedback}"
    )

    try:
        corrected = await ai_client.call_ai(prompt)
    except ai_client.AIConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ai_client.AIRequestError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    corrected = corrected.strip()
    # 去掉可能的代码块包裹
    fence = re.match(r"^```(?:latex)?\s*(.*?)\s*```$", corrected, re.DOTALL)
    if fence:
        corrected = fence.group(1).strip()

    conn = database.get_connection()
    try:
        conn.execute(
            "UPDATE problems SET latex_code = ? WHERE id = ?",
            (corrected, req.problem_id),
        )
        conn.commit()
        row = _fetch_problem(conn, req.problem_id)
    finally:
        conn.close()
    return _row_to_problem(row)


if __name__ == "__main__":
    # 直接运行本文件即可启动服务（Electron 主进程通过 spawn 调用）。
    uvicorn.run(app, host="127.0.0.1", port=8000)
