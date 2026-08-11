"""buffet board: dishes by period/page/slot, tray_event points at it

Revision ID: d7a2f4c19b60
Revises: c4e91f27a8b3
Create Date: 2026-08-11

手写，不用 autogenerate：种子数据它从来不生成，CHECK 约束的表达式变化
也检测不可靠（踩过 4 次）。

tray_event 原本挂在 menu_item 上。自助台上的菜和菜单上能点的菜是两回事，
而且台上的菜比 menu_item 里那 12 道 is_buffet_dish 多得多。趁 tray_event
**还是空表**换掉外键 —— 有数据之后再改就要写数据迁移了。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd7a2f4c19b60'
down_revision: Union[str, None] = 'c4e91f27a8b3'
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'buffet_dish',
        sa.Column('id', sa.BigInteger(), nullable=False),
        sa.Column('period_kind', sa.Text(), nullable=False),
        sa.Column('page', sa.Integer(), nullable=False),
        sa.Column('pos', sa.Integer(), nullable=False),
        sa.Column('name_zh', sa.Text(), nullable=False),
        sa.Column('name_en', sa.Text(), nullable=False, server_default=''),
        sa.Column('active', sa.Boolean(), nullable=False, server_default=sa.text('true')),
        sa.CheckConstraint("period_kind IN ('lunch','dinner')", name='ck_bd_period'),
        sa.CheckConstraint('page BETWEEN 1 AND 3', name='ck_bd_page'),
        sa.CheckConstraint('pos BETWEEN 1 AND 10', name='ck_bd_pos'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_bd_layout', 'buffet_dish', ['period_kind', 'page', 'pos'])

    # 种子：菜单里已经标了 is_buffet_dish 的 12 道，午市晚市各来一份。
    # 用现成的名字而不是"占位 1/占位 2" —— 老板打开就能用，
    # 剩下的格子留空让他自己填。
    #
    # ⚠️ 同一道菜在午市和晚市是**两行**。它们是两个不同的消耗过程，
    #    合成一行反而要在模型里再拆开。
    op.execute(
        """
        INSERT INTO buffet_dish (period_kind, page, pos, name_zh, name_en)
        SELECT p.kind,
               ((r.rn - 1) / 10) + 1,
               ((r.rn - 1) % 10) + 1,
               r.name_zh,
               r.name_en
          FROM (SELECT 'lunch' AS kind UNION ALL SELECT 'dinner') p
         CROSS JOIN (
                SELECT name_zh, name_en,
                       row_number() OVER (ORDER BY sort_order, id) AS rn
                  FROM menu_item
                 WHERE is_buffet_dish
               ) r
         WHERE r.rn <= 30
        """
    )

    # tray_event：换外键。空表，直接改。
    op.drop_index('ix_tray_item_time', table_name='tray_event')
    op.drop_column('tray_event', 'menu_item_id')
    op.add_column(
        'tray_event', sa.Column('buffet_dish_id', sa.BigInteger(), nullable=False)
    )
    op.create_foreign_key(
        'fk_tray_dish', 'tray_event', 'buffet_dish', ['buffet_dish_id'], ['id']
    )
    op.create_index('ix_tray_dish_time', 'tray_event', ['buffet_dish_id', 'observed_at'])


def downgrade() -> None:
    op.drop_index('ix_tray_dish_time', table_name='tray_event')
    op.drop_constraint('fk_tray_dish', 'tray_event', type_='foreignkey')
    op.drop_column('tray_event', 'buffet_dish_id')
    # 回滚会丢掉补菜记录指向的菜 —— 先清空，否则 NOT NULL 加不上
    op.execute('DELETE FROM tray_event')
    op.add_column(
        'tray_event', sa.Column('menu_item_id', sa.BigInteger(), nullable=False)
    )
    op.create_index('ix_tray_item_time', 'tray_event', ['menu_item_id', 'observed_at'])

    op.drop_index('ix_bd_layout', table_name='buffet_dish')
    op.drop_table('buffet_dish')
