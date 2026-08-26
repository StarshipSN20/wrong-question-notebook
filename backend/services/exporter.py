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

# 卷头用词按语言切换（跟随界面语言）。始终加载 ctex：即使界面是英文，
# 题目正文也可能含中文，缺 ctex 会导致 XeLaTeX 编译报错。
_WORDS = {
    "zh": {
        "title": "错题导出",
        "problem": "题目 {n}",
        "problem_plain": "第 {n} 题",
        "answer": "答案",
        "ref_answers": "参考答案",
        "uncategorized": "未分类",
        "no_content": "（无内容）",
    },
    "en": {
        "title": "Mistake Notebook Export",
        "problem": "Problem {n}",
        "problem_plain": "Problem {n}",
        "answer": "Answer",
        "ref_answers": "Answer Key",
        "uncategorized": "Uncategorized",
        "no_content": "(no content)",
    },
}

# 学科名在库里是中文，英文卷面需要翻译。
_SUBJECT_EN = {"数学": "Mathematics", "物理": "Physics", "化学": "Chemistry"}


def _preamble(title: str) -> str:
    return (
        "\\documentclass[12pt]{article}\n"
        "\\usepackage{amsmath}\n"
        "\\usepackage{amssymb}\n"
        "\\usepackage{ctex}  % 中文支持，请用 XeLaTeX 编译\n"
        "\\usepackage[margin=2.5cm]{geometry}\n"
        f"\\title{{{title}}}\n"
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


def _render_body(latex: str | None, raw: str | None, no_content: str) -> str:
    """渲染单段内容：优先 LaTeX 原样注入，否则纯文本转义。"""
    if latex and latex.strip():
        return latex.strip()
    if raw and raw.strip():
        return _escape_plain(raw.strip())
    return no_content


def _subject_label(subject: str | None, lang: str, uncategorized: str) -> str:
    """学科名按导出语言显示（库里存中文）。"""
    s = (subject or "").strip()
    if not s:
        return uncategorized
    return _SUBJECT_EN.get(s, s) if lang == "en" else s


def build_tex(
    problems: Iterable[dict],
    include_answers: bool = True,
    answers_last: bool = False,
    language: str = "zh",
) -> str:
    """把错题列表渲染成完整 .tex 源码字符串。

    每个 problem 需含 subject / question_latex / answer_latex 字段
    （question_latex 与 answer_latex 由后端从 latex_code 拆分）。
    language 控制卷头用词（zh/en），跟随界面语言。
    """
    lang = "en" if language == "en" else "zh"
    w = _WORDS[lang]
    problems = list(problems)
    parts = [_preamble(w["title"])]

    # 题目区：answers_last 时只出题目，否则每题后紧跟答案。
    for idx, p in enumerate(problems, start=1):
        subject = _subject_label(p.get("subject"), lang, w["uncategorized"])
        heading = w["problem"].format(n=idx)
        parts.append(f"\\section*{{{heading}（{subject}）}}\n" if lang == "zh"
                     else f"\\section*{{{heading} ({subject})}}\n")
        parts.append(
            _render_body(p.get("question_latex"), p.get("raw_text"), w["no_content"])
        )
        parts.append("\n\n")
        if include_answers and not answers_last:
            parts.append(f"\\subsection*{{{w['answer']}}}\n")
            parts.append(_render_body(p.get("answer_latex"), None, w["no_content"]))
            parts.append("\n\n")

    # 参考答案区：答案集中放到文末，另起一页。
    if answers_last and include_answers:
        parts.append("\\newpage\n")
        parts.append(f"\\section*{{{w['ref_answers']}}}\n\n")
        for idx, p in enumerate(problems, start=1):
            parts.append(f"\\textbf{{{w['problem_plain'].format(n=idx)}}}\n\n")
            parts.append(_render_body(p.get("answer_latex"), None, w["no_content"]))
            parts.append("\n\n")

    parts.append(_POSTAMBLE)
    return "".join(parts)
