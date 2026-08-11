"""store setting: timezone and business-day cutoff

Revision ID: b3d5c81a4e17
Revises: f816387a2ece
Create Date: 2026-08-10

手写，没用 autogenerate。两个原因：
  1. autogenerate 从不生成数据迁移，而这张单行表**必须**带着那一行
     一起建出来 —— 空表会让 period.py 退回 env 默认值，
     等于设置页显示的和实际生效的不是同一个东西。
  2. CHECK 约束的表达式 autogenerate 检测不可靠（这个坑踩过 4 次）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b3d5c81a4e17'
down_revision: Union[str, None] = 'f816387a2ece'
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'store_setting',
        # 单行表，id 恒为 1 —— 不要序列
        sa.Column('id', sa.Integer(), autoincrement=False, nullable=False),
        sa.Column('tz', sa.Text(), nullable=False),
        sa.Column('business_day_cutoff_hour', sa.Integer(), nullable=False),
        sa.Column('updated_by', sa.BigInteger(), nullable=True),
        sa.Column(
            'updated_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.CheckConstraint('id = 1', name='ck_store_setting_singleton'),
        sa.CheckConstraint(
            'business_day_cutoff_hour >= 0 AND business_day_cutoff_hour < 24',
            name='ck_store_setting_cutoff_range',
        ),
        sa.ForeignKeyConstraint(['updated_by'], ['app_user.id']),
        sa.PrimaryKeyConstraint('id'),
    )

    # 数据迁移：建表的同时把那一行放进去。
    #
    # 默认值 America/Los_Angeles ——  店在 Douglas County NV，属太平洋时区。
    # 这之前代码里写死的是 UTC-5（EST），差两小时，会让下午 13:00 就按
    # 晚市价收钱。设置页可以改，改错了也只是再改一次。
    op.execute(
        """
        INSERT INTO store_setting (id, tz, business_day_cutoff_hour)
        VALUES (1, 'America/Los_Angeles', 0)
        ON CONFLICT (id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_table('store_setting')
