# -*- coding: utf-8 -*-
"""数据库连接层：本地默认 SQLite，上阿里云时设环境变量 DATABASE_URL 切 MySQL。
MySQL 示例：DATABASE_URL=mysql+pymysql://user:pass@host:3306/urdf_web?charset=utf8mb4
"""
import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

BASE_DIR = Path(__file__).resolve().parent
_data_dir = os.getenv("DATA_DIR")
DATA_DIR = Path(_data_dir) if _data_dir else BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = os.getenv("DATABASE_URL") or f"sqlite:///{DATA_DIR / 'app.db'}"

_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=_connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
