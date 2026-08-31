"""AI 文本收敛：把模型返回的内容修成前端 KaTeX 能渲染的正文。

抽成独立模块的原因：main.py（AI 调用点）和 database.py（老数据迁移）都要用，
放在任一边都会形成循环导入。这里全是纯函数，也方便单独测。

## 为什么要有 repair_json_escapes

所有 AI 调用点统一走「模型返回 JSON、这里解析」这条路（见 main.py 的 FORMAT_CONTRACT）。
但 LaTeX 全是反斜杠，而 JSON 里 `\\(` 不是合法转义——模型十次有一两次会直接写
`"latex_code": "\\(x\\)"`，于是 `json.loads` 在那个位置直接报
`Invalid \\escape`。真实事故：一条 2623 字的答案在 char 878 处炸掉，
解析失败后整坨 JSON 被当正文存进库，前端渲染出一堆 `{"latex_code":...}`。

**光靠提示词管不住这件事**，所以解析前先把非法转义补齐。这是整条链路的关键一环，
别当成多余的防御删掉。

入口：
- parse_ai_json      ：解析模型返回的 JSON（自动修非法转义 + 多层兜底）。
- coerce_ai_text     ：从返回内容里取出单段正文（JSON / 代码块 / 裸文本都吃）。
- sanitize_latex     ：统一公式定界符为 \\( \\) / \\[ \\]。
- repair_answer      ：答案落库前的完整修复（coerce + sanitize）。
"""

import json
import re

# JSON 规范里反斜杠后合法的字符；其余都必须写成 \\。
_VALID_JSON_ESCAPES = set('"\\/bfnrtu')


def repair_json_escapes(text: str) -> str:
    """把 JSON 字符串里的非法反斜杠转义补成合法的双反斜杠。

    从左到右扫描：合法转义对（\\n、\\\\、\\" 等）原样保留，
    落单的反斜杠（如 LaTeX 的 \\( \\frac \\mathbf）补成两个。
    这样 `"\\(x\\)"` 会变成 `"\\\\(x\\\\)"`，json.loads 解出来正好是 `\\(x\\)`。
    """
    if not text or "\\" not in text:
        return text

    def repl(m: re.Match) -> str:
        pairs, ch = m.group(1), m.group(2)
        if ch == "u":
            # \uXXXX 只有跟满 4 位十六进制才合法
            tail = m.string[m.end() : m.end() + 4]
            ok = bool(re.match(r"[0-9a-fA-F]{4}", tail))
            return pairs + ("\\u" if ok else "\\\\u")
        if ch in _VALID_JSON_ESCAPES:
            return pairs + "\\" + ch
        return pairs + "\\\\" + ch

    # (?:\\\\)* 先把已经正确的双反斜杠整对吃掉，避免二次翻倍；
    # 剩下的那个落单反斜杠交给 repl 判断。
    return re.sub(r"((?:\\\\)*)\\(.)", repl, text, flags=re.DOTALL)

# 从 JSON 兜底提取正文时，按优先级找这些键。
TEXT_KEYS = ("answer_latex", "latex_code", "answer", "content", "text", "raw_text")


# 控制字符 → 它原本大概率是哪个 LaTeX 命令的开头。
#
# 【这是一类会静默出错的坑】`\f` `\b` `\v` 在 JSON 里是**合法**转义，
# 所以模型写 `"\frac{1}{2}"` 时 json.loads 不报错，只是解出来变成
# 换页符 + "rac{1}{2}"——公式静默错掉，比解析失败更难发现。
# 换页/退格/垂直制表符在题目与解答正文里**永远不会**合理出现，
# 因此见到就一定是被吃掉的反斜杠，可以无条件还原。
_ALWAYS_SAFE_CONTROL = {
    "\x0c": "\\f",  # \frac \forall \flat \frown
    "\x08": "\\b",  # \beta \bar \binom \bigcup
    "\x0b": "\\v",  # \vec \varphi \vdots
}

# \n \t \r 三个不一样：它们在正文里是**合法**的换行/制表，不能无条件还原
# （`"step1\nstep2"` 里的 \n 就是真换行）。只在后面紧跟这些「一看就是 LaTeX
# 命令尾巴」的字母序列时才还原——这些序列出现在换行/制表符后面的概率极低。
# 宁可漏修也不能把真换行改坏，所以只收长且特征明显的命令。
_CONDITIONAL_CONTROL = (
    ("\n", "n", ("abla", "eq", "otin", "onumber", "ewline", "warrow", "earrow")),
    ("\t", "t", ("heta", "imes", "ext", "ilde", "riangle", "frac", "extbf", "extit")),
    ("\r", "r", ("ho", "ightarrow", "ight", "angle", "floor", "ceil")),
)


def undo_control_damage(text: str) -> str:
    """还原被 JSON 合法转义吃掉的 LaTeX 反斜杠。

    必须在 json.loads **之后**调用（那时反斜杠已经变成真的控制字符了）。
    """
    if not text:
        return text

    for ch, prefix in _ALWAYS_SAFE_CONTROL.items():
        if ch in text:
            text = text.replace(ch, prefix)

    for ch, letter, tails in _CONDITIONAL_CONTROL:
        if ch not in text:
            continue
        for tail in tails:
            text = text.replace(ch + tail, "\\" + letter + tail)
    return text


def _strip_fence(text: str) -> str:
    """去掉 ``` / ```json / ```latex 代码块包裹。"""
    fence = re.match(r"^```(?:[a-zA-Z]*)?\s*(.*?)\s*```$", text.strip(), re.DOTALL)
    return fence.group(1).strip() if fence else text.strip()


def _extract_key_raw(text: str, key: str) -> str | None:
    """JSON 彻底解析不出时的兜底：直接从文本里抠出某个键的字符串值。

    用于模型输出被截断（结尾少个引号或大括号）的情况——这时宁可拿到大半段正文，
    也比把整坨 JSON 存进库好。抠出来后手工做一次 JSON 反转义。
    """
    m = re.search(rf'"{re.escape(key)}"\s*:\s*"(.*)', text, re.DOTALL)
    if not m:
        return None
    body = m.group(1)
    # 找到未被转义的收尾引号；找不到（被截断）就取到末尾
    out, i = [], 0
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body):
            nxt = body[i + 1]
            # \f \b \v 不在表里：这里保留成 \f 等原样，正是想要的效果
            # （在 LaTeX 语境里 \frac 才是本意，不是换页符）
            out.append(
                {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "/": "/"}.get(
                    nxt, "\\" + nxt
                )
            )
            i += 2
            continue
        if ch == '"':
            break
        out.append(ch)
        i += 1
    return "".join(out).strip() or None


def parse_ai_json(text: str, keys: tuple[str, ...] = ()) -> dict:
    """解析模型返回的 JSON 对象，非法转义会先修好。

    三层兜底，保证「一定拿到能用的东西」：
    1. 直接 json.loads；
    2. 修非法转义（LaTeX 的 \\( \\frac 等）后再 loads —— 真实事故就靠这一层救回来；
    3. 仍失败则按 keys 逐个用正则抠值（应对输出被截断）。
    全都失败返回 {}，由调用方决定怎么退化。
    """
    cleaned = _strip_fence(text or "")
    if not cleaned:
        return {}
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start != -1 and end > start:
        candidate = cleaned[start : end + 1]
    else:
        candidate = cleaned

    for attempt in (candidate, repair_json_escapes(candidate)):
        try:
            data = json.loads(attempt)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(data, dict):
            # 还原被合法 JSON 转义吃掉的反斜杠（\frac → 换页符+rac 这类静默损坏）
            return {
                k: undo_control_damage(v) if isinstance(v, str) else v
                for k, v in data.items()
            }

    # 截断兜底：这条路也要做控制字符还原，否则被吃掉的 \frac 会漏过去
    # （正常解析路径在上面已经做过了）。
    salvaged = {}
    for key in keys or TEXT_KEYS:
        value = _extract_key_raw(candidate, key)
        if value:
            salvaged[key] = undo_control_damage(value)
    return salvaged


def coerce_ai_text(text: str) -> str:
    """把 AI 的「纯文本」回复收敛成真正的正文。

    提示词已明确禁止 JSON 与代码块，但模型并不总听话（库里真存过整坨
    {"latex_code": "..."}，前端因此渲染不出公式）。三层兜底：
    1. 去掉 ``` / ```latex / ```json 代码块包裹；
    2. 若整段是 JSON 对象，按 TEXT_KEYS 取出正文（顺带完成 JSON 反转义，
       \\\\[ 会还原成 \\[）；
    3. 若仍是「双反斜杠定界符」（JSON 风格但没包在 JSON 里），还原成单反斜杠。
    """
    cleaned = _strip_fence(text or "")
    if not cleaned:
        return ""

    # 走统一的 JSON 解析（含非法转义修复与截断兜底），取出第一个像正文的字段。
    if cleaned.startswith("{"):
        data = parse_ai_json(cleaned)
        for key in TEXT_KEYS:
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                cleaned = value.strip()
                break

    # 走到这里若仍是双反斜杠定界符（模型没包 JSON、却按 JSON 规则转义了），
    # 还原成单反斜杠——KaTeX 找的是 \( \) \[ \]。
    # 只动这四种定界符，别碰 LaTeX 合法的换行 \\。
    if "\\\\(" in cleaned or "\\\\[" in cleaned:
        for double, single in (
            ("\\\\(", "\\("),
            ("\\\\)", "\\)"),
            ("\\\\[", "\\["),
            ("\\\\]", "\\]"),
        ):
            cleaned = cleaned.replace(double, single)
    return cleaned.strip()


def sanitize_latex(latex: str) -> str:
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

    # 合并重复的行间定界符：\[ \[ → \[，\] \] → \]。
    # 两个来源都会造成重复：
    # 1. 模型自己就写了两遍（真实数据里见过 "\\[\n\\[\\begin{aligned}"）；
    # 2. 上面 aligned 那条规则会给 \begin{aligned} 补一个 \[，
    #    原文已有 \[ 时就叠成了 \[\[。
    # KaTeX 遇到 \[\[ 直接渲染失败，所以必须合并。嵌套行间公式在 LaTeX 里
    # 本来就不合法，因此无条件合并是安全的；循环到稳定以处理三重以上。
    for _ in range(4):
        collapsed = re.sub(r"\\\[(\s*)\\\[", r"\\[", latex)
        collapsed = re.sub(r"\\\](\s*)\\\]", r"\\]", collapsed)
        if collapsed == latex:
            break
        latex = collapsed

    # 清理多余空行（连续 3+ 个换行 → 2 个）
    latex = re.sub(r"\n{3,}", "\n\n", latex)

    return latex


def repair_answer(text: str) -> str:
    """答案落库前的完整修复：先收敛正文，再统一定界符。"""
    return sanitize_latex(coerce_ai_text(text))
