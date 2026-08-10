"""FastAPI 入口：健康检查与错题基础 CRUD 接口。

本地运行在 http://127.0.0.1:8000，供 Electron 主进程 spawn 拉起。
"""

import json
from contextlib import asynccontextmanager
from datetime import date
from typing import List

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import database
from models import ProblemCreate, ProblemOut


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动时初始化数据库。"""
    database.init_db()
    yield


app = FastAPI(title="数理化错题本 API", version="0.1.0", lifespan=lifespan)

# 允许前端（Electron file:// 或 localhost）跨域访问本地 API。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    )


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
            "SELECT * FROM problems ORDER BY id DESC"
        ).fetchall()
    finally:
        conn.close()
    return [_row_to_problem(row) for row in rows]


@app.post("/api/problems", response_model=ProblemOut, status_code=201)
def create_problem(problem: ProblemCreate) -> ProblemOut:
    """新增错题条目。

    created_at / next_review_date 默认当天，review_stage 默认 0。
    tags 序列化为 JSON 字符串存储。
    """
    today = date.today().isoformat()
    tags_json = json.dumps(problem.tags, ensure_ascii=False)

    conn = database.get_connection()
    try:
        cursor = conn.execute(
            """
            INSERT INTO problems
                (image_path, raw_text, latex_code, subject, tags,
                 created_at, next_review_date, review_stage)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                problem.image_path,
                problem.raw_text,
                problem.latex_code,
                problem.subject,
                tags_json,
                today,
                today,
                0,
            ),
        )
        conn.commit()
        new_id = cursor.lastrowid
        row = conn.execute(
            "SELECT * FROM problems WHERE id = ?", (new_id,)
        ).fetchone()
    finally:
        conn.close()

    if row is None:
        raise HTTPException(status_code=500, detail="创建错题后未能读取记录")
    return _row_to_problem(row)


if __name__ == "__main__":
    # 直接运行本文件即可启动服务（Electron 主进程通过 spawn 调用）。
    uvicorn.run(app, host="127.0.0.1", port=8000)
