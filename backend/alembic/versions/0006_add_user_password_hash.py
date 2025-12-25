"""Add password_hash column to users.

Revision ID: 0006_add_user_password_hash
Revises: 0005_add_upload_chunk_embeddings
Create Date: 2025-12-22
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0006_add_user_password_hash"
down_revision = "0005_add_upload_chunk_embeddings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("password_hash", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "password_hash")

