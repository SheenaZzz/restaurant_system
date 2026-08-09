"""split front role into employee and manager

Revision ID: 1e18aeaf89d6
Revises: e868c96c898a
Create Date: 2026-08-09 22:19:37.517557
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '1e18aeaf89d6'
down_revision: Union[str, None] = 'e868c96c898a'
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None


def upgrade() -> None:
    # ⚠️ 两个坑叠在一起：
    #
    # ① autogenerate **没检测到这个 CHECK 约束的变化** —— 约束名没变、
    #    只有表达式变了，它认不出来（前几个迁移能检测到是因为名字也变了）。
    #    必须手写 drop + create。CHECK 约束的改动每次都要人工核对生成的迁移。
    #
    # ② **顺序和上一个迁移相反。** 上次是"回填数据 → SET NOT NULL"，
    #    这次必须"先 drop 约束 → 再改数据 → 最后建新约束"：
    #    旧约束只允许 ('front','kitchen','admin')，
    #    在它还在的时候写入 'front_manager' 会直接 CheckViolation。
    #
    #    规律：**放宽**约束要先 drop；**收紧**约束要先修数据。
    op.drop_constraint("ck_user_role", "app_user", type_="check")

    # 原来的 'front' 拆成两级。现有的 front 账号提升为主管：
    # 他是店里那个说了算的人，日常员工另开账号。
    op.execute("UPDATE app_user SET role = 'front_manager' WHERE role = 'front'")

    op.create_check_constraint(
        "ck_user_role",
        "app_user",
        "role IN ('front_employee','front_manager','kitchen','admin')",
    )


def downgrade() -> None:
    op.execute("UPDATE app_user SET role = 'front' WHERE role LIKE 'front_%'")
    op.drop_constraint("ck_user_role", "app_user", type_="check")
    op.create_check_constraint(
        "ck_user_role", "app_user", "role IN ('front','kitchen','admin')"
    )
