# -*- coding: utf-8 -*-
"""数据模型：用户 / 会话 / 邀请码 / 使用事件"""
import time

from sqlalchemy import Column, Float, Integer, String, Text

from db import Base


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(32), unique=True, nullable=False, index=True)
    pw_hash = Column(String(128), nullable=False)
    salt = Column(String(64), nullable=False)
    is_admin = Column(Integer, default=0, nullable=False)    # 管理员
    is_super = Column(Integer, default=0, nullable=False)    # 超级管理员（永久权限）
    is_enabled = Column(Integer, default=1, nullable=False)  # 0 = 黑名单，禁止登录
    created_at = Column(Float, default=time.time, nullable=False)


class Session(Base):
    __tablename__ = "sessions"
    token = Column(String(64), primary_key=True)
    username = Column(String(32), nullable=False, index=True)
    created_at = Column(Float, default=time.time, nullable=False)
    last_active = Column(Float, default=time.time, nullable=False)


class InviteCode(Base):
    __tablename__ = "invite_codes"
    code = Column(String(16), primary_key=True)
    created_by = Column(String(32), nullable=False)
    used_by = Column(String(32), nullable=True)
    created_at = Column(Float, default=time.time, nullable=False)
    used_at = Column(Float, nullable=True)


class UsageEvent(Base):
    """使用统计事件：action ∈ login / import_urdf / param_export / mirror_run / check_run"""
    __tablename__ = "usage_events"
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(32), nullable=False, index=True)
    action = Column(String(32), nullable=False, index=True)
    created_at = Column(Float, default=time.time, nullable=False, index=True)
    detail = Column(Text, nullable=True)
