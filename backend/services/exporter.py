"""LaTeX 导出：把若干错题拼成一个可编译的 .tex 文档。

用 article 文档类 + amsmath + ctex（中文支持，建议用 XeLaTeX 编译）。
题目正文里的 latex_code 已经是合法 LaTeX（含 \\( \\) / \\[ \\] 定界符，
来自 Phase 2 的识别格式），故原样注入；没有 latex_code 时退回 raw_text
并对 LaTeX 特殊字符做最小转义，避免破坏编译。
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


def build_tex(problems: Iterable[dict]) -> str:
    """把错题列表渲染成完整 .tex 源码字符串。

    每个 problem 需含 subject / latex_code / raw_text 字段（dict 或有对应键）。
    """
    parts = [_PREAMBLE]
    for idx, p in enumerate(problems, start=1):
        subject = (p.get("subject") or "未分类").strip()
        parts.append(f"\\section*{{题目 {idx}（{subject}）}}\n")

        latex_code = p.get("latex_code")
        raw_text = p.get("raw_text")
        if latex_code and latex_code.strip():
            body = latex_code.strip()  # 已是合法 LaTeX，原样注入
        elif raw_text and raw_text.strip():
            body = _escape_plain(raw_text.strip())
        else:
            body = "（无题目内容）"
        parts.append(body + "\n\n")

    parts.append(_POSTAMBLE)
    return "".join(parts)
