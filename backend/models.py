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
    """返回给前端的错题条目。

    question_latex / answer_latex 是后端拆分后的题目部分与答案部分
    （从 latex_code 中按 【题目】/【解答】 标记拆分，旧数据自动兼容）。
    """

    id: int
    # seq：按 id 升序的连续序号（1,2,3…）。删除错题后不留空号，
    # 供前端展示；id 仍是数据库主键，用于接口调用。
    seq: int = 0
    image_path: Optional[str] = None
    raw_text: Optional[str] = None
    latex_code: Optional[str] = None
    question_latex: Optional[str] = None
    answer_latex: Optional[str] = None
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
    answer_latex: Optional[str] = None
    subject: Optional[str] = None
    tags: Optional[List[str]] = None


class ConfigModel(BaseModel):
    """AI 接口配置与界面偏好（读写「设置」页）。"""

    api_key: str = ""
    base_url: str = ""
    model_name: str = ""
    # 推理强度：minimal / low / medium / high / auto（auto=不发送该参数）
    reasoning_effort: str = "high"
    # 界面语言：zh / en
    ui_language: str = "zh"


class CorrectLatexRequest(BaseModel):
    """自然语言修正题目的入参。"""

    problem_id: int
    user_feedback: str


class GenerateSimilarRequest(BaseModel):
    """举一反三的入参：type 为「变式」或「拓展」。"""

    problem_id: int
    type: str = "变式"


class GenerateAnswerRequest(BaseModel):
    """用 AI 为题目生成答案的入参。"""

    problem_id: int


class ExportRequest(BaseModel):
    """批量导出的入参。

    include_answers：是否包含答案；answers_last：答案集中放到文档最后
    （两者都含答案时：false=答案紧跟每题，true=答案放在最后）。
    """

    problem_ids: List[int]
    include_answers: bool = True
    answers_last: bool = False
    # 卷头用词语言（zh/en），跟随界面语言，避免英文界面导出中文卷头
    language: str = "zh"
