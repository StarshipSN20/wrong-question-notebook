"""艾宾浩斯复习调度：根据复习阶段计算下次复习日期。

review_stage 语义：已成功复习的次数（0 = 从未复习）。
- 新题 stage=0 → 下次复习 = 今天 + INTERVALS[0]（1 天）。
- 每次「标记已复习」stage += 1，并按新 stage 重算下次复习日期。
- stage >= len(INTERVALS) 视为已掌握，不再进入待复习列表。
"""

from datetime import date, timedelta

# 艾宾浩斯遗忘曲线间隔（天）。
INTERVALS = [1, 2, 4, 7, 15]


def next_review_date(review_stage: int, from_date: date | None = None) -> str:
    """返回下次复习日期（ISO 字符串）。

    stage 超出区间时用最后一个间隔兜底，保证已掌握题目也有一个有效日期。
    """
    base = from_date or date.today()
    idx = min(max(review_stage, 0), len(INTERVALS) - 1)
    return (base + timedelta(days=INTERVALS[idx])).isoformat()


def is_mastered(review_stage: int) -> bool:
    """复习阶段是否已达上限（掌握，不再提醒）。"""
    return review_stage >= len(INTERVALS)
