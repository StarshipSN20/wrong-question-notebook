"""LaTeX 导出：把若干错题拼成一个可编译的 .tex 文档。

用 article 文档类 + amsmath + ctex（中文支持，建议用 XeLaTeX 编译）。
题目正文里的 latex_code 已经是合法 LaTeX（含 \\( \\) / \\[ \\] 定界符），
故原样注入；没有 latex_code 时退回 raw_text 并对 LaTeX 特殊字符做最小转义。

三个版本（include_answers / answers_last）：
- 含答案：每题题目后紧跟答案。
- 不含答案：只有题目，按题型留答题空白。
- 答案在最后：题目部分在前，参考答案集中放到文末另起一页。

图片：problem["image_path"] 非空即表示「要嵌这张图」（由 main.py 按用户勾选决定）。
build_tex_with_images 把图片复制到导出目录的 images/ 下，.tex 用相对路径引用。
"""

import shutil
from pathlib import Path
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
        "image_caption": "（题目原图）",
    },
    "en": {
        "title": "Mistake Notebook Export",
        "problem": "Problem {n}",
        "problem_plain": "Problem {n}",
        "answer": "Answer",
        "ref_answers": "Answer Key",
        "uncategorized": "Uncategorized",
        "no_content": "(no content)",
        "image_caption": "(original image)",
    },
}

# 学科名在库里是中文，英文卷面需要翻译。
_SUBJECT_EN = {"数学": "Mathematics", "物理": "Physics", "化学": "Chemistry"}

# 题与题之间的间距（所有版本都加，让卷面不挤在一起）。
_PROBLEM_GAP = "\\vspace{0.8cm}\n\n"


def _preamble(title: str) -> str:
    return (
        "\\documentclass[12pt]{article}\n"
        "\\usepackage{amsmath}\n"
        "\\usepackage{amssymb}\n"
        "\\usepackage{graphicx}\n"
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
    return "".join(_ESCAPE.get(ch, ch) for ch in text)


def _render_body(latex: str | None, raw: str | None, no_content: str) -> str:
    """渲染单段内容：优先 LaTeX 原样注入，否则纯文本转义。"""
    if latex and latex.strip():
        return latex.strip()
    if raw and raw.strip():
        return _escape_plain(raw.strip())
    return no_content


def _render_image(rel_path: str, caption: str) -> str:
    """嵌入题目原图：限宽 0.75\\textwidth，居中，下面一行小字说明。"""
    return (
        "\\begin{center}\n"
        f"\\includegraphics[width=0.75\\textwidth,height=0.45\\textheight,keepaspectratio]{{{rel_path}}}\\\\\n"
        f"{{\\small\\textit{{{caption}}}}}\n"
        "\\end{center}\n\n"
    )


def _subject_label(subject: str | None, lang: str, uncategorized: str) -> str:
    """学科名按导出语言显示（库里存中文）。"""
    s = (subject or "").strip()
    if not s:
        return uncategorized
    return _SUBJECT_EN.get(s, s) if lang == "en" else s


def answer_space_cm(question_type: str | None, question_latex: str | None) -> float:
    """「不含答案」版每题的答题留白高度（cm）。

    MC/TF 不留白；SAQ 基础 3cm + 按题长最多加 3cm；LAQ（及未识别）6cm + 最多加 6cm。
    前端 PDF 导出（render.js answerSpaceCm）用同一套规则，改这里要同步改那边。
    """
    if question_type in ("MC", "TF"):
        return 0.0
    estimated_lines = len(question_latex or "") / 80
    if question_type == "SAQ":
        return 3.0 + min(estimated_lines * 0.5, 3.0)
    return 6.0 + min(estimated_lines * 0.8, 6.0)


def build_tex(
    problems: Iterable[dict],
    include_answers: bool = True,
    answers_last: bool = False,
    language: str = "zh",
    image_map: dict[str, str] | None = None,
) -> str:
    """把错题列表渲染成完整 .tex 源码字符串。

    每个 problem 需含 subject / question_latex / answer_latex / raw_text /
    question_type / image_path。image_path 非空且在 image_map 里有对应的相对路径时，
    题干前嵌入该图（image_map 由 build_tex_with_images 生成；直接调 build_tex 不嵌图）。
    """
    lang = "en" if language == "en" else "zh"
    w = _WORDS[lang]
    image_map = image_map or {}
    problems = list(problems)
    parts = [_preamble(w["title"])]

    # 题目区：answers_last 时只出题目，否则每题后紧跟答案。
    for idx, p in enumerate(problems, start=1):
        subject = _subject_label(p.get("subject"), lang, w["uncategorized"])
        heading = w["problem"].format(n=idx)
        parts.append(
            f"\\section*{{{heading}（{subject}）}}\n"
            if lang == "zh"
            else f"\\section*{{{heading} ({subject})}}\n"
        )

        rel = image_map.get(p.get("image_path") or "")
        if rel:
            parts.append(_render_image(rel, w["image_caption"]))

        parts.append(_render_body(p.get("question_latex"), p.get("raw_text"), w["no_content"]))
        parts.append("\n\n")

        if include_answers and not answers_last:
            parts.append(f"\\subsection*{{{w['answer']}}}\n")
            parts.append(_render_body(p.get("answer_latex"), None, w["no_content"]))
            parts.append("\n\n")
        elif not include_answers:
            # 无答案版：为学生答题留白（按题型和题目长度）
            space = answer_space_cm(p.get("question_type"), p.get("question_latex"))
            if space > 0:
                parts.append(f"\\vspace{{{space:.1f}cm}}\n\n")

        parts.append(_PROBLEM_GAP)

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


def build_tex_with_images(
    problems: Iterable[dict],
    export_dir: Path,
    include_answers: bool = True,
    answers_last: bool = False,
    language: str = "zh",
) -> str:
    """生成 .tex 并把各题的 image_path 复制到 export_dir/images/。

    返回 .tex 源码，调用者负责写文件 / 打包。图片按题号重命名
    （problem_1.png …），.tex 里用 images/problem_1.png 这样的相对路径引用。
    """
    problems = list(problems)
    images_dir = export_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    image_map: dict[str, str] = {}
    for idx, p in enumerate(problems, start=1):
        src_str = p.get("image_path")
        if not src_str:
            continue
        src = Path(src_str)
        if not src.is_file():
            continue
        dest_name = f"problem_{idx}{src.suffix.lower()}"
        shutil.copy2(src, images_dir / dest_name)
        image_map[src_str] = f"images/{dest_name}"

    return build_tex(
        problems,
        include_answers=include_answers,
        answers_last=answers_last,
        language=language,
        image_map=image_map,
    )
