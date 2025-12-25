"""Add admin and token quota fields to users.

Revision ID: 0008_add_admin_token_fields
Revises: 0007_add_password_reset_tokens
Create Date: 2025-12-24
"""

from __future__ import annotations

from datetime import datetime, timezone

from alembic import op
import sqlalchemy as sa

revision = "0008_add_admin_token_fields"
down_revision = "0007_add_password_reset_tokens"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("users", sa.Column("chat_tokens_limit", sa.Integer(), nullable=False, server_default=sa.text("10000")))
    op.add_column("users", sa.Column("chat_tokens_used", sa.Integer(), nullable=False, server_default=sa.text("0")))
    op.add_column("users", sa.Column("voice_tokens_limit", sa.Integer(), nullable=False, server_default=sa.text("10000")))
    op.add_column("users", sa.Column("voice_tokens_used", sa.Integer(), nullable=False, server_default=sa.text("0")))
    op.add_column("users", sa.Column("tokens_reset_at", sa.DateTime(timezone=True), nullable=True))

    users = sa.Table(
        "users",
        sa.MetaData(),
        sa.Column("tokens_reset_at", sa.DateTime(timezone=True)),
    )
    now = datetime.now(tz=timezone.utc)
    op.execute(users.update().values(tokens_reset_at=now))


def downgrade() -> None:
    op.drop_column("users", "tokens_reset_at")
    op.drop_column("users", "voice_tokens_used")
    op.drop_column("users", "voice_tokens_limit")
    op.drop_column("users", "chat_tokens_used")
    op.drop_column("users", "chat_tokens_limit")
    op.drop_column("users", "is_admin")
