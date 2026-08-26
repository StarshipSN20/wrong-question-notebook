"""FastAPI 入口：健康检查、错题 CRUD、AI 识图 / 修正、配置读写。

本地运行在 http://127.0.0.1:8000，供 Electron 主进程 spawn 拉起。
所有用户数据（DB / uploads / config）统一落在 USER_DATA 目录（见 database.py）。
"""

import base64
import hashlib
import json
import os
import re
import sys
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import List, Optional

# PyInstaller 打包运行时：conda 扩展模块（_sqlite3 等）依赖的 DLL 在
# 解压目录 _MEIPASS 里，需显式加入 DLL 搜索路径（见 backend.spec）。
if getattr(sys, "frozen", False) and sys.platform == "win32":
    os.add_dll_directory(sys._MEIPASS)

import aiofiles
import uvicorn
from fastapi import FastAPI, File, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware

import config
import database
from models import (
    ConfigModel,
    CorrectLatexRequest,
    ExportRequest,
    GenerateAnswerRequest,
    GenerateSimilarRequest,
    ProblemCreate,
    ProblemOut,
    ProblemUpdate,
)
from services import ai_client, exporter, scheduler

# 支持的图片扩展名 → MIME（走多模态 vision）。
IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}

# 语言一致性规则：AI 输出必须与题目原文同语言（英文题不要翻译成中文，反之亦然）。
# 所有 AI 调用（识图 / 文本整理 / 生成答案 / 举一反三 / 修正）共用。
LANGUAGE_RULE = (
    "5. 【语言一致性】输出内容的语言必须与题目原文的语言完全一致："
    "题目是英文就全程用英文（题干、解答、标签都用英文），"
    "题目是中文就全程用中文；题目为其它语言时同样沿用该语言。"
    "严禁把题目翻译成另一种语言，也严禁中英混杂。\n"
)

# 统一的格式规则：确保前端 KaTeX 能正确渲染，且多题不会挤在一起。
FORMAT_RULES = (
    "严格遵守以下格式规则：\n"
    "1. 所有数学/物理/化学公式必须用 \\\\( \\\\) 包裹行内公式、用 \\\\[ \\\\] 包裹行间公式；"
    "禁止使用 $ … $、$$ … $$、\\\\begin{equation} 等任何其它公式定界符。\n"
    "2. 如果内容里有多道题，每道题各占一段，题与题之间用换行符 \\n 分隔，并在每题开头标注序号（如 1.、2.、3.）。\n"
    "3. latex_code 是 JSON 字符串，LaTeX 里的反斜杠必须按 JSON 规则转义（例如 \\\\frac 写成 \\\\\\\\frac）。\n"
    "4. 只返回一个 JSON 对象，不要输出任何解释、前后缀或 Markdown 代码块标记。\n"
    + LANGUAGE_RULE
)

# JSON 字段说明（OCR 与文本整理共用）。
JSON_SPEC = (
    "JSON 字段如下：\n"
    '{"subject": "数学/物理/化学 之一", '
    '"latex_code": "题目内容（遵守上述格式规则）", '
    '"raw_text": "题目的纯文本形式", '
    '"tags": ["知识点标签1", "知识点标签2", "知识点标签3"], '
    '"answer_latex": "题目的解答/答案（遵守上述格式规则；若原图或原文中没有解答，则输出空字符串 \\"\\"）"}'
    "\n"
    "tags 字段是必填项，不得为空数组：必须为每道题给出 2-4 个具体的知识点标签"
    "（例如「二次函数」「数列递推」「牛顿第二定律」「氧化还原反应」这种细分知识点，"
    "而不是「数学」「物理」这类学科名）。标签语言与题目语言保持一致。\n"
    "注意：subject 是固定枚举，只能填「数学」「物理」「化学」三个中文词之一，"
    "不受上述语言一致性规则约束——即使题目是英文，subject 也必须是中文。\n"
)

OCR_PROMPT = (
    "你是一个数理化错题识别助手。请识别图片中的全部题目。\n" + FORMAT_RULES + JSON_SPEC
)

TEXT_PROMPT = (
    "你是一个数理化错题整理助手。请整理下面从文件中提取的题目文本。\n"
    + FORMAT_RULES
    + JSON_SPEC
    + "\n\n提取到的文本如下：\n"
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
# 统一的查询列：附带 seq —— 按 id 升序的连续序号。
# 用子查询（COUNT id <= 自身）而不是 rowid，保证删除错题后序号依然连续，
# 前端展示 seq、接口调用仍用 id。
SELECT_COLS = (
    "p.*, (SELECT COUNT(*) FROM problems q WHERE q.id <= p.id) AS seq"
)


# 学科在库里统一存中文枚举（数学/物理/化学），界面再按语言翻译显示。
# 但「输出跟随题目语言」的规则会让模型对英文题返回 "Mathematics"，
# 导致学科色块失效、自动附加的学科标签中英分裂（同一学科两种标签、
# 按标签搜索被割裂）。故入库前统一归一化。
SUBJECT_ALIASES = {
    "math": "数学",
    "maths": "数学",
    "mathematics": "数学",
    "physics": "物理",
    "physic": "物理",
    "chemistry": "化学",
    "chem": "化学",
}


def _normalize_subject(subject: Optional[str]) -> Optional[str]:
    """把英文/异体学科名归一成中文枚举；无法识别时原样返回。"""
    if not subject:
        return subject
    s = subject.strip()
    return SUBJECT_ALIASES.get(s.lower(), s)


def _split_q_a(content: str) -> tuple[str, Optional[str]]:
    """把「【题目】…【解答】…」的内容拆成（题目, 答案）。

    旧数据里题目和解答混在 latex_code 中（如举一反三生成的题），
    这里按标记拆分；没有标记则整段视为题目，答案为 None。
    """
    if not content:
        return "", None
    m = re.search(r"【\s*题目\s*】(.*?)【\s*解答\s*】(.*)", content, re.DOTALL)
    if m:
        question = m.group(1).strip()
        answer = m.group(2).strip()
        return question, answer or None
    return content.strip(), None


def _row_to_problem(row) -> ProblemOut:
    """把 sqlite3.Row 转成 ProblemOut，tags 字段从 JSON 字符串反序列化。

    question_latex / answer_latex：优先用库里的 answer_latex 列；
    为空时尝试从 latex_code 按【题目】/【解答】标记拆分（兼容旧数据）。
    """
    raw_tags = row["tags"]
    try:
        tags = json.loads(raw_tags) if raw_tags else []
    except (json.JSONDecodeError, TypeError):
        tags = []
    question, split_answer = _split_q_a(row["latex_code"] or row["raw_text"] or "")
    answer = row["answer_latex"] or split_answer
    keys = row.keys()
    return ProblemOut(
        id=row["id"],
        seq=row["seq"] if "seq" in keys else 0,
        image_path=row["image_path"],
        raw_text=row["raw_text"],
        latex_code=row["latex_code"],
        question_latex=question or None,
        answer_latex=answer or None,
        subject=row["subject"],
        tags=tags,
        created_at=row["created_at"],
        next_review_date=row["next_review_date"],
        review_stage=row["review_stage"],
        raw_image_hash=row["raw_image_hash"],
        is_generated=bool(row["is_generated"]),
        parent_id=row["parent_id"],
        last_review_date=row["last_review_date"],
    )


def _fetch_problem(conn, problem_id: int):
    """按 id 查一条错题（含 seq 连续序号），返回 sqlite3.Row 或 None。"""
    return conn.execute(
        f"SELECT {SELECT_COLS} FROM problems p WHERE p.id = ?", (problem_id,)
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


def _sanitize_latex(latex: str) -> str:
    """后处理 AI 生成的 LaTeX，修复常见格式偏差。

    即使提示词要求了 \\( \\) / \\[ \\]，某些模型仍可能输出
    $…$、$$…$$、\\begin{equation} 等格式——这些 KaTeX 也能渲染，
    但为了统一和避免嵌套冲突，统一转成 \\( \\) / \\[ \\]。
    """
    if not latex:
        return latex

    # 行间：\begin{equation} / \begin{equation*} / \begin{align} / \begin{align*} → \[
    latex = re.sub(r"\\begin\{equation\*?\}", r"\\[", latex)
    latex = re.sub(r"\\end\{equation\*?\}", r"\\]", latex)
    latex = re.sub(r"\\begin\{align\*?\}", r"\\[", latex)
    latex = re.sub(r"\\end\{align\*?\}", r"\\]", latex)
    latex = re.sub(r"\\begin\{aligned\*?\}", r"\\[\\begin{aligned}", latex)
    latex = re.sub(r"\\end\{aligned\*?\}", r"\\end{aligned}\\]", latex)

    # 行间：$$ … $$ → \[ … \]（避免与 KaTeX 的 $$ 分隔符产生冲突）
    latex = re.sub(r"\$\$\s*(.+?)\s*\$\$", r"\\[\1\\]", latex, flags=re.DOTALL)

    # 行内：$ … $ → \( … \)
    latex = re.sub(r"(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)", r"\\(\1\\)", latex)

    # 清理多余空行（连续 3+ 个换行 → 2 个）
    latex = re.sub(r"\n{3,}", "\n\n", latex)

    return latex


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
    is_generated: bool = False,
    parent_id: Optional[int] = None,
    answer_latex: Optional[str] = None,
) -> ProblemOut:
    """插入一条错题：created_at 为当天，next_review_date 按艾宾浩斯首个间隔计算。

    tags 自动带上学科标签（如数学/物理/化学），方便按学科筛选。
    """
    today = date.today().isoformat()
    # 学科归一化：模型对英文题可能返回 "Mathematics"，统一转中文枚举，
    # 保证色块、自动标签、按标签搜索在中英界面下都一致。
    subject = _normalize_subject(subject)
    # 学科标签自动附加（去重）：所有录入路径统一生效。
    tags = list(tags or [])
    if subject and subject not in tags:
        tags = [subject] + tags
    tags_json = json.dumps(tags, ensure_ascii=False)
    next_review = scheduler.next_review_date(0)

    conn = database.get_connection()
    try:
        cursor = conn.execute(
            """
            INSERT INTO problems
                (image_path, raw_text, latex_code, subject, tags,
                 created_at, next_review_date, review_stage, raw_image_hash,
                 is_generated, parent_id, answer_latex)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                image_path,
                raw_text,
                latex_code,
                subject,
                tags_json,
                today,
                next_review,
                0,
                raw_image_hash,
                1 if is_generated else 0,
                parent_id,
                answer_latex,
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
        rows = conn.execute(
            f"SELECT {SELECT_COLS} FROM problems p ORDER BY p.id DESC"
        ).fetchall()
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


@app.get("/api/problems/{problem_id}", response_model=ProblemOut)
def get_problem(problem_id: int) -> ProblemOut:
    """按 id 获取单道错题。"""
    conn = database.get_connection()
    try:
        row = _fetch_problem(conn, problem_id)
    finally:
        conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail="错题不存在")
    return _row_to_problem(row)


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
        if patch.answer_latex is not None:
            fields.append("answer_latex = ?")
            values.append(patch.answer_latex)
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


@app.delete("/api/problems/{problem_id}", status_code=204)
def delete_problem(problem_id: int) -> Response:
    """删除错题，并清理其孤立的上传文件（每个文件按 hash 唯一，删记录即可删文件）。"""
    conn = database.get_connection()
    try:
        row = _fetch_problem(conn, problem_id)
        if row is None:
            raise HTTPException(status_code=404, detail="错题不存在")
        image_path = row["image_path"]
        conn.execute("DELETE FROM problems WHERE id = ?", (problem_id,))
        # 全部删空时重置自增计数器，下次录入从 id=1 重新开始（避免 id 无限增长）。
        remaining = conn.execute("SELECT COUNT(*) FROM problems").fetchone()[0]
        if remaining == 0:
            conn.execute("DELETE FROM sqlite_sequence WHERE name = 'problems'")
        conn.commit()
    finally:
        conn.close()

    if image_path:
        try:
            p = Path(image_path)
            if p.exists():
                p.unlink()
        except OSError:
            pass  # 文件清理失败不影响删除结果

    return Response(status_code=204)


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
            f"SELECT {SELECT_COLS} FROM problems p WHERE p.raw_image_hash = ?",
            (file_hash,),
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
        answer_latex=_sanitize_latex(parsed.get("answer_latex") or "") or None,
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
        "输出修正后的完整 LaTeX 代码。\n"
        "公式一律用 \\( \\) 包裹行内、\\[ \\] 包裹行间，禁止使用 $ 或 $$；多道题之间用换行符分隔。\n"
        "【语言一致性】修正后的内容必须与原题语言保持一致，不要翻译成其它语言。\n"
        "只返回修正后的 LaTeX 代码本身，不要任何解释，不要 Markdown 代码块标记。\n\n"
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


@app.post("/api/generate-answer", response_model=ProblemOut)
async def generate_answer(req: GenerateAnswerRequest) -> ProblemOut:
    """用 AI 根据题目生成完整解答，存入 answer_latex 并返回。"""
    conn = database.get_connection()
    try:
        row = _fetch_problem(conn, req.problem_id)
    finally:
        conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail="错题不存在")

    question, _ = _split_q_a(row["latex_code"] or row["raw_text"] or "")
    if not question:
        raise HTTPException(status_code=400, detail="题目内容为空，无法生成答案")

    prompt = (
        "你是一个数理化解题助手。请为下面这道题写出完整、清晰的解答步骤，"
        "包含必要的公式推导与最终答案。\n"
        + FORMAT_RULES
        + "\n只返回解答内容本身，不要任何解释，不要 Markdown 代码块标记。\n\n"
        + f"题目：\n{question}"
    )

    try:
        ai_text = await ai_client.call_ai(prompt)
    except ai_client.AIConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ai_client.AIRequestError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    # 去掉可能的代码块包裹
    cleaned = ai_text.strip()
    fence = re.match(r"^```(?:latex)?\s*(.*?)\s*```$", cleaned, re.DOTALL)
    if fence:
        cleaned = fence.group(1).strip()
    answer = _sanitize_latex(cleaned) or None

    conn = database.get_connection()
    try:
        conn.execute(
            "UPDATE problems SET answer_latex = ? WHERE id = ?",
            (answer, req.problem_id),
        )
        conn.commit()
        row = _fetch_problem(conn, req.problem_id)
    finally:
        conn.close()
    return _row_to_problem(row)


# ---------------------------------------------------------------------------
# 举一反三
# ---------------------------------------------------------------------------
@app.post("/api/generate-similar", response_model=ProblemOut, status_code=201)
async def generate_similar(req: GenerateSimilarRequest) -> ProblemOut:
    """基于父题用 AI 生成「变式」或「拓展」新题，作为独立错题存库并返回。"""
    conn = database.get_connection()
    try:
        row = _fetch_problem(conn, req.problem_id)
    finally:
        conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail="错题不存在")

    gen_type = (req.type or "变式").strip()
    if gen_type == "拓展":
        task = (
            "请基于下面这道题，生成一道【进阶拓展题】：在原题知识点基础上适度提高难度、"
            "综合更多知识点或增加推理步骤，保持同一学科。"
        )
    else:
        gen_type = "变式"
        task = (
            "请基于下面这道题，生成一道【同类变式题】：考查相同知识点，"
            "更换数值/情境/表述，难度与原题相当，保持同一学科。"
        )

    source = row["latex_code"] or row["raw_text"] or ""
    subject = row["subject"]
    prompt = (
        "你是一个数理化出题助手。"
        + task
        + "\n新题必须附带完整解题步骤。\n"
        + FORMAT_RULES
        + JSON_SPEC
        + "\n特别要求：latex_code 内先写【题目】再写【解答】，两部分之间用换行分隔。\n"
        + "\n！！！重要警告！！！\n"
        + "- 严禁在 JSON 的 latex_code 字符串内使用未转义的反斜杠（如 \\frac 在 JSON 中必须写作 \\\\frac），否则前端 KaTeX 渲染会失败。\n"
        + "- 严禁使用 $…$ 或 $$…$$ 作为公式分隔符，必须使用 \\(…\\) 和 \\[…\\]。\n"
        + "- 严禁使用 \\begin{equation} 或 \\begin{align} 环境，必须用 \\[ … \\] 替代。\n"
        + "- 只输出纯 JSON 对象，禁止包裹在 ```json 代码块或任何其他标记中。\n"
        + "\n"
        + f"原题（学科：{subject or '未知'}）：\n{source}"
    )

    try:
        ai_text = await ai_client.call_ai(prompt)
    except ai_client.AIConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ai_client.AIRequestError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    parsed = _parse_ai_json(ai_text)
    return _insert_problem(
        image_path=None,
        raw_text=parsed.get("raw_text"),
        latex_code=_sanitize_latex(parsed.get("latex_code") or ""),
        subject=parsed.get("subject") or subject,
        tags=parsed.get("tags") or [],
        raw_image_hash=None,
        is_generated=True,
        parent_id=req.problem_id,
    )


# ---------------------------------------------------------------------------
# 复习计划（艾宾浩斯）
# ---------------------------------------------------------------------------
@app.get("/api/review/due", response_model=List[ProblemOut])
def review_due() -> List[ProblemOut]:
    """返回今日（含逾期）待复习、且未掌握的错题。"""
    today = date.today().isoformat()
    max_stage = len(scheduler.INTERVALS)
    conn = database.get_connection()
    try:
        rows = conn.execute(
            f"""
            SELECT {SELECT_COLS} FROM problems p
            WHERE p.next_review_date <= ? AND p.review_stage < ?
            ORDER BY p.next_review_date, p.id
            """,
            (today, max_stage),
        ).fetchall()
    finally:
        conn.close()
    return [_row_to_problem(row) for row in rows]


@app.post("/api/review/{problem_id}/complete", response_model=ProblemOut)
def complete_review(problem_id: int) -> ProblemOut:
    """标记一道错题为已复习：推进复习阶段并重算下次复习日期。"""
    today = date.today()
    conn = database.get_connection()
    try:
        row = _fetch_problem(conn, problem_id)
        if row is None:
            raise HTTPException(status_code=404, detail="错题不存在")

        new_stage = int(row["review_stage"]) + 1
        next_review = scheduler.next_review_date(new_stage, today)
        conn.execute(
            """
            UPDATE problems
            SET review_stage = ?, last_review_date = ?, next_review_date = ?
            WHERE id = ?
            """,
            (new_stage, today.isoformat(), next_review, problem_id),
        )
        conn.commit()
        row = _fetch_problem(conn, problem_id)
    finally:
        conn.close()
    return _row_to_problem(row)


# ---------------------------------------------------------------------------
# LaTeX 导出
# ---------------------------------------------------------------------------
@app.post("/api/export")
def export_latex(req: ExportRequest) -> Response:
    """按勾选的 problem_ids 生成 .tex 文件流供前端下载。"""
    if not req.problem_ids:
        raise HTTPException(status_code=400, detail="未选择任何错题")

    placeholders = ",".join("?" for _ in req.problem_ids)
    conn = database.get_connection()
    try:
        rows = conn.execute(
            f"SELECT * FROM problems WHERE id IN ({placeholders})",
            tuple(req.problem_ids),
        ).fetchall()
    finally:
        conn.close()
    if not rows:
        raise HTTPException(status_code=404, detail="所选错题不存在")

    # 按用户勾选顺序排列，拆分题目/答案。
    by_id = {row["id"]: row for row in rows}
    ordered = [by_id[i] for i in req.problem_ids if i in by_id]
    problems = []
    for r in ordered:
        question, split_answer = _split_q_a(r["latex_code"] or r["raw_text"] or "")
        problems.append(
            {
                "subject": r["subject"],
                "question_latex": question or None,
                "answer_latex": r["answer_latex"] or split_answer,
                "raw_text": r["raw_text"],
            }
        )

    tex = exporter.build_tex(
        problems,
        include_answers=req.include_answers,
        answers_last=req.answers_last,
        language=req.language,
    )
    return Response(
        content=tex,
        media_type="application/x-tex",
        headers={"Content-Disposition": "attachment; filename=mistakes.tex"},
    )


if __name__ == "__main__":
    # 直接运行本文件即可启动服务（Electron 主进程通过 spawn 调用）。
    uvicorn.run(app, host="127.0.0.1", port=8000)
