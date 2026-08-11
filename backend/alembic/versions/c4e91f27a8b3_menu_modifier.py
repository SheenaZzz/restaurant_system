"""menu modifier catalog and per-line modifiers

Revision ID: c4e91f27a8b3
Revises: b3d5c81a4e17
Create Date: 2026-08-11

手写，不用 autogenerate：CHECK 约束的表达式变化检测不可靠（踩过 4 次），
而且目录的种子数据 autogenerate 从来不生成。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c4e91f27a8b3'
down_revision: Union[str, None] = 'b3d5c81a4e17'
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'menu_modifier',
        sa.Column('id', sa.BigInteger(), nullable=False),
        sa.Column('name_zh', sa.Text(), nullable=False),
        sa.Column('name_en', sa.Text(), nullable=False),
        sa.Column('price_cents', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('active', sa.Boolean(), nullable=False, server_default=sa.text('true')),
        sa.CheckConstraint('price_cents >= 0', name='ck_modifier_price_nonneg'),
        sa.PrimaryKeyConstraint('id'),
    )

    op.create_table(
        'order_line_modifier',
        sa.Column('id', sa.BigInteger(), nullable=False),
        sa.Column('order_line_id', sa.BigInteger(), nullable=False),
        sa.Column('modifier_id', sa.BigInteger(), nullable=True),
        sa.Column('label', sa.Text(), nullable=False),
        sa.Column('price_cents', sa.Integer(), nullable=False),
        sa.CheckConstraint('price_cents >= 0', name='ck_line_modifier_price_nonneg'),
        sa.ForeignKeyConstraint(['order_line_id'], ['order_line.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['modifier_id'], ['menu_modifier.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_line_modifier_line', 'order_line_modifier', ['order_line_id'])

    # 种子：店里现在的加料规则。
    # 加辣不收钱；换/加肉 $2；加蔬菜 $1。价格随时可以改这张表，
    # 改了只影响之后的单 —— 历史账单存的是快照。
    op.execute(
        """
        INSERT INTO menu_modifier (name_zh, name_en, price_cents, sort_order) VALUES
          ('加辣',   'Extra Spicy',      0,  10),
          ('少辣',   'Mild',             0,  20),
          ('加牛肉', 'Add Beef',       200,  30),
          ('加鸡肉', 'Add Chicken',    200,  40),
          ('加虾',   'Add Shrimp',     200,  50),
          ('加蔬菜', 'Add Vegetables', 100,  60),
          ('不要葱', 'No Scallion',      0,  70),
          ('不要蒜', 'No Garlic',        0,  80)
        """
    )


def downgrade() -> None:
    op.drop_index('ix_line_modifier_line', table_name='order_line_modifier')
    op.drop_table('order_line_modifier')
    op.drop_table('menu_modifier')
