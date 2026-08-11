"""Pydantic 核心数据模型。

ProblemCreate：新增错题时的入参模型。
ProblemOut：返回给前端的出参模型（含 id 与时间/复习字段）。
"""

from typing import List, Optional

from pydantic import BaseModel, Field


class ProblemCreate(BaseModel):
    """新增错题的入参。"""

    image_path: Optional[str] = Field(default=None, description="本地图片路径")
    raw_text: Optional[str] = Field(default=None, description="识别/输入的原题文本")
    latex_code: Optional[str] = Field(default=None, description="LaTeX 格式公式/题目")
    subject: Optional[str] = Field(default=None, description="学科：数学/物理/化学")
    tags: List[str] = Field(default_factory=list, description="知识点标签列表")


class ProblemOut(BaseModel):
    """返回给前端的错题条目。"""

    id: int
    image_path: Optional[str] = None
    raw_text: Optional[str] = None
    latex_code: Optional[str] = None
    subject: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    created_at: str
    next_review_date: str
    review_stage: int
    raw_image_hash: Optional[str] = None
    is_generated: bool = False
    parent_id: Optional[int] = None
    last_review_date: Optional[str] = None


class ProblemUpdate(BaseModel):
    """手动编辑错题的入参（全部可选，只更新提供的字段）。"""

    raw_text: Optional[str] = None
    latex_code: Optional[str] = None
    subject: Optional[str] = None
    tags: Optional[List[str]] = None


class ConfigModel(BaseModel):
    """AI 接口配置（读写「设置」页）。"""

    api_key: str = ""
    base_url: str = ""
    model_name: str = ""


class CorrectLatexRequest(BaseModel):
    """自然语言修正题目的入参。"""

    problem_id: int
    user_feedback: str


class GenerateSimilarRequest(BaseModel):
    """举一反三的入参：type 为「变式」或「拓展」。"""

    problem_id: int
    type: str = "变式"


class ExportRequest(BaseModel):
    """批量导出 LaTeX 的入参。"""

    problem_ids: List[int]
