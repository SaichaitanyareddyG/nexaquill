"""add auto title flag

Revision ID: 0002
Revises: 0001
Create Date: 2025-11-09
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "chat_sessions",
        sa.Column("auto_title", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.alter_column("chat_sessions", "auto_title", server_default=None)


def downgrade() -> None:
    op.drop_column("chat_sessions", "auto_title")
