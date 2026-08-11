"""LaTeX 导出：把若干错题拼成一个可编译的 .tex 文档。

用 article 文档类 + amsmath + ctex（中文支持，建议用 XeLaTeX 编译）。
题目正文里的 latex_code 已经是合法 LaTeX（含 \\( \\) / \\[ \\] 定界符），
故原样注入；没有 latex_code 时退回 raw_text 并对 LaTeX 特殊字符做最小转义。

支持三个版本（build_tex 的 include_answers / answers_last 参数）：
- 含答案：每题题目后紧跟答案。
- 不含答案：只有题目。
- 答案在最后：题目部分在前，参考答案集中放到文末。
"""

from typing import Iterable

_PREAMBLE = (
    "\\documentclass[12pt]{article}\n"
    "\\usepackage{amsmath}\n"
    "\\usepackage{amssymb}\n"
    "\\usepackage{ctex}  % 中文支持，请用 XeLaTeX 编译\n"
    "\\usepackage[margin=2.5cm]{geometry}\n"
    "\\title{错题导出}\n"
    "\\date{}\n"
    "\\begin{document}\n"
    "\\maketitle\n\n"
)

_POSTAMBLE = "\n\\end{document}\n"

# raw_text 兜底转义：这些字符在 LaTeX 里有特殊含义。
_ESCAPE = {
    "\\": r"\textbackslash{}",
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "{": r"\{",
    "}": r"\}",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}


def _escape_plain(text: str) -> str:
    """对纯文本做 LaTeX 转义（先转反斜杠，避免二次转义）。"""
    out = []
    for ch in text:
        out.append(_ESCAPE.get(ch, ch))
    return "".join(out)


def _render_body(latex: str | None, raw: str | None) -> str:
    """渲染单段内容：优先 LaTeX 原样注入，否则纯文本转义。"""
    if latex and latex.strip():
        return latex.strip()
    if raw and raw.strip():
        return _escape_plain(raw.strip())
    return "（无内容）"


def build_tex(
    problems: Iterable[dict],
    include_answers: bool = True,
    answers_last: bool = False,
) -> str:
    """把错题列表渲染成完整 .tex 源码字符串。

    每个 problem 需含 subject / question_latex / answer_latex 字段
    （question_latex 与 answer_latex 由后端从 latex_code 拆分）。
    """
    problems = list(problems)
    parts = [_PREAMBLE]

    if answers_last:
        # 答案集中放最后：先输出全部题目。
        for idx, p in enumerate(problems, start=1):
            subject = (p.get("subject") or "未分类").strip()
            parts.append(f"\\section*{{题目 {idx}（{subject}）}}\n")
            parts.append(_render_body(p.get("question_latex"), p.get("raw_text")))
            parts.append("\n\n")
    else:
        for idx, p in enumerate(problems, start=1):
            subject = (p.get("subject") or "未分类").strip()
            parts.append(f"\\section*{{题目 {idx}（{subject}）}}\n")
            parts.append(_render_body(p.get("question_latex"), p.get("raw_text")))
            parts.append("\n\n")
            if include_answers:
                parts.append("\\subsection*{答案}\n")
                parts.append(_render_body(p.get("answer_latex"), None))
                parts.append("\n\n")

    if answers_last and include_answers:
        parts.append("\\newpage\n")
        parts.append("\\section*{参考答案}\n\n")
        for idx, p in enumerate(problems, start=1):
            parts.append(f"\\textbf{{第 {idx} 题}}\n\n")
            parts.append(_render_body(p.get("answer_latex"), None))
            parts.append("\n\n")

    parts.append(_POSTAMBLE)
    return "".join(parts)
