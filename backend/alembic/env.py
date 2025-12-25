from __future__ import annotations

import os
import sys
from logging.config import fileConfig

from sqlalchemy import create_engine
from sqlalchemy import pool

from alembic import context

# add src path
sys.path.append(os.path.join(os.path.dirname(__file__), "..", "src"))

from nexaquill_api.db.session import Base
from nexaquill_api.db.url import prefer_psycopg_driver
from nexaquill_api.db import models  # noqa
from nexaquill_api.settings import get_settings

config = context.config
cfg = get_settings()
if cfg.DATABASE_URL:
    normalized_url = prefer_psycopg_driver(cfg.DATABASE_URL)
    config.set_main_option("sqlalchemy.url", normalized_url)
    print(f"[alembic] Using DATABASE_URL from .env: {normalized_url}")
else:
    print("[alembic] DATABASE_URL not configured; using alembic.ini sqlalchemy.url")

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    url = config.get_main_option("sqlalchemy.url")
    connectable = create_engine(url, poolclass=pool.NullPool)

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
