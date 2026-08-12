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
    # ⚠️ Two traps at once:
    #
    # (1) autogenerate **did not notice this CHECK constraint changed** -- the
    #     name stayed the same and only the expression moved, which it cannot
    #     see (earlier migrations were caught because the name changed too).
    #     Drop and create by hand. Every CHECK change needs the generated
    #     migration read by a person.
    #
    # (2) **The order is the opposite of the last migration.** That one was
    #     "backfill, then SET NOT NULL"; this one has to drop the constraint,
    #     then change the data, then create the new constraint: the old one
    #     only allows ('front','kitchen','admin'), so writing 'front_manager'
    #     while it is still there is a straight CheckViolation.
    #
    #     The rule: **relaxing** a constraint means dropping it first;
    #     **tightening** one means fixing the data first.
    op.drop_constraint("ck_user_role", "app_user", type_="check")

    # The old 'front' splits in two. The existing front account becomes the
    # manager -- they are the one in charge; daily staff get their own account.
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
