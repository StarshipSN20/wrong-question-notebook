"""后端导出回归测试：起临时 USER_DATA 的子进程，往库里写题，打 /api/export 断言。

用法：backend/venv/Scripts/python.exe tests/test_export_backend.py
（在仓库根目录运行；不会碰真实用户数据）
"""

import io
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = ROOT / "backend" / "venv" / "Scripts" / "python.exe"
PORT = 8765
BASE = f"http://127.0.0.1:{PORT}"

# 1x1 PNG
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d"
    "4944415478da63f8ffff3f0300050001c9d8f2da0000000049454e44ae426082"
)


def req(method, path, body=None, raw=False):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(f"{BASE}{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            payload = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            return resp.status, ctype, payload if raw else json.loads(payload or b"null")
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), e.read()


def wait_ready():
    for _ in range(60):
        try:
            with urllib.request.urlopen(f"{BASE}/health", timeout=1):
                return True
        except Exception:
            time.sleep(0.25)
    return False


def main():
    failures = []

    def check(cond, msg):
        print(("  ok   " if cond else "  FAIL ") + msg)
        if not cond:
            failures.append(msg)

    with tempfile.TemporaryDirectory() as tmp:
        env = {**os.environ, "USER_DATA": tmp}
        code = (
            "import sys; sys.path.insert(0, r'%s'); import uvicorn, main; "
            "uvicorn.run(main.app, host='127.0.0.1', port=%d, log_level='warning')"
        ) % (str(ROOT / "backend"), PORT)
        proc = subprocess.Popen(
            [str(PY), "-c", code],
            cwd=str(ROOT / "backend"),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        try:
            if not wait_ready():
                out = proc.stdout.read().decode(errors="replace") if proc.stdout else ""
                print("backend failed to start:\n" + out)
                return 1

            # 归属证明：写一条记录，确认落在临时库里
            status, _, p1 = req("POST", "/api/problems", {
                "raw_text": "q1", "latex_code": "\\(1+1=2\\)", "subject": "数学", "tags": ["加法"],
            })
            check(status == 201, "create problem #1")
            check((Path(tmp) / "notebook.db").exists(), "db lives in temp USER_DATA")

            # 第二题：直接写库补 image_path / question_type（模拟图片上传）
            img = Path(tmp) / "uploads" / "abc.png"
            img.parent.mkdir(parents=True, exist_ok=True)
            img.write_bytes(PNG)
            status, _, p2 = req("POST", "/api/problems", {
                "raw_text": "q2", "latex_code": "geometry", "subject": "物理", "tags": [],
            })
            check(status == 201, "create problem #2")
            import sqlite3
            conn = sqlite3.connect(Path(tmp) / "notebook.db")
            conn.execute(
                "UPDATE problems SET image_path=?, question_type='LAQ', has_diagram=1 WHERE id=?",
                (str(img), p2["id"]),
            )
            conn.execute("UPDATE problems SET question_type='MC' WHERE id=?", (p1["id"],))
            conn.commit()
            conn.close()

            # 第三题：image_path 指向不存在的文件（勾了含图也不该崩、不该嵌）
            status, _, p3 = req("POST", "/api/problems", {
                "raw_text": "q3", "latex_code": "missing img", "subject": "化学", "tags": [],
            })
            conn = sqlite3.connect(Path(tmp) / "notebook.db")
            conn.execute(
                "UPDATE problems SET image_path=? WHERE id=?",
                (str(Path(tmp) / "uploads" / "nope.png"), p3["id"]),
            )
            conn.commit()
            conn.close()

            # 列表返回新字段
            status, _, lst = req("GET", "/api/problems")
            check(status == 200 and len(lst) == 3, "list has 3 problems")
            by_id = {p["id"]: p for p in lst}
            check(by_id[p2["id"]]["question_type"] == "LAQ", "question_type round-trips")
            check(by_id[p2["id"]]["has_diagram"] is True, "has_diagram round-trips")
            check("seq" in by_id[p1["id"]], "seq present")

            # 导出 1：无图 → .tex，含题间距，不含 XeLaTeX 编译路径
            status, ctype, body = req("POST", "/api/export", {
                "problem_ids": [p1["id"], p2["id"]],
                "include_answers": False,
                "image_problem_ids": [],
            }, raw=True)
            check(status == 200 and "x-tex" in ctype, f"no-image export is .tex ({ctype})")
            tex = body.decode()
            check("\\includegraphics" not in tex, "no image in .tex when none requested")
            check(tex.count("\\vspace{0.8cm}") == 2, "per-problem gap present for both problems")
            # MC 不留白，LAQ 留白 ≥ 6cm
            check("\\vspace{6." in tex, "LAQ answer space emitted")
            sec1 = tex.index("题目 1")
            sec2 = tex.index("题目 2")
            check("\\vspace{3" not in tex[sec1:sec2] and "\\vspace{6" not in tex[sec1:sec2],
                  "MC problem has no answer space")

            # 导出 2：勾了含图 → .zip，包含 images/problem_2.png 且 .tex 引用它
            status, ctype, body = req("POST", "/api/export", {
                "problem_ids": [p1["id"], p2["id"], p3["id"]],
                "include_answers": True,
                "image_problem_ids": [p2["id"], p3["id"]],
            }, raw=True)
            check(status == 200 and "zip" in ctype, f"image export is .zip ({ctype})")
            zf = zipfile.ZipFile(io.BytesIO(body))
            names = zf.namelist()
            check("mistakes.tex" in names, "zip has mistakes.tex")
            check("images/problem_2.png" in names, f"zip has images/problem_2.png ({names})")
            check(len([n for n in names if n.startswith("images/")]) == 1,
                  "missing-file image is skipped, not zipped")
            tex = zf.read("mistakes.tex").decode()
            check("\\includegraphics" in tex and "images/problem_2.png" in tex,
                  ".tex references the copied image")
            check(tex.count("\\includegraphics") == 1, "only the existing image is embedded")
            check("\\usepackage{graphicx}" in tex, "graphicx loaded")

            # 导出 3：顺序跟随 problem_ids
            status, _, body = req("POST", "/api/export", {
                "problem_ids": [p2["id"], p1["id"]],
                "image_problem_ids": [],
            }, raw=True)
            tex = body.decode()
            check(tex.index("geometry") < tex.index("1+1=2"), "export order follows problem_ids")

            # 导出 4：答案在最后
            status, _, body = req("POST", "/api/export", {
                "problem_ids": [p1["id"]],
                "include_answers": True, "answers_last": True,
                "image_problem_ids": [],
            }, raw=True)
            tex = body.decode()
            check("\\newpage" in tex and "参考答案" in tex, "answers-last section emitted")

            # 旧字段 compile_pdf 被忽略而非 422
            status, ctype, body = req("POST", "/api/export", {
                "problem_ids": [p1["id"]], "compile_pdf": True, "image_problem_ids": [],
            }, raw=True)
            check(status == 200, "unknown compile_pdf field is ignored")

            # 英文卷头
            status, _, body = req("POST", "/api/export", {
                "problem_ids": [p1["id"]], "language": "en", "image_problem_ids": [],
            }, raw=True)
            check("Mistake Notebook Export" in body.decode(), "english header")

            # 空选 → 400
            status, _, _ = req("POST", "/api/export", {"problem_ids": []}, raw=True)
            check(status == 400, "empty selection → 400")
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    print()
    if failures:
        print(f"{len(failures)} FAILED")
        return 1
    print("ALL PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
