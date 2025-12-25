"""Add pgvector embeddings to upload_chunks."""

from alembic import op
import sqlalchemy as sa
from pgvector.sqlalchemy import Vector

revision = "0005_add_upload_chunk_embeddings"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.add_column("upload_chunks", sa.Column("embedding", Vector(1536), nullable=True))


def downgrade() -> None:
    op.drop_column("upload_chunks", "embedding")
