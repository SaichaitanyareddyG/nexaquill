"""add upload chunks table

Revision ID: 0004
Revises: 0003
Create Date: 2025-12-17
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "upload_chunks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("upload_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("page_number", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.ForeignKeyConstraint(["upload_id"], ["uploads.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_upload_chunks_upload_id", "upload_chunks", ["upload_id"])


def downgrade() -> None:
    op.drop_index("ix_upload_chunks_upload_id", table_name="upload_chunks")
    op.drop_table("upload_chunks")

