# -*- coding: utf-8 -*-
"""
URDF 可视化功能在线系统 — 后端（PRD v0.1，阶段 1-1）
- FastAPI + SQLAlchemy（本地 SQLite，设 DATABASE_URL 可切 MySQL）
- 邀请码注册 / 登录 / 3h 无操作自动登出
- 左/右手 URDF 上传与读取（供前端解析）
- 管理统计页 API：使用统计、人员权限、黑名单、邀请码
- 区域2镜像 / 区域3检查：1-2 阶段集成 urdf_mirror.py / urdf_parser_checker.py
"""
import hashlib
import hmac
import os
import re
import secrets
import time
from datetime import datetime
from pathlib import Path

from fastapi import Depends, FastAPI, Form, HTTPException, Request, UploadFile, File
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session as OrmSession

from db import DATA_DIR, Base, engine, get_db
from models import InviteCode, Session, UsageEvent, User

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
WORKSPACE_DIR = DATA_DIR / "workspace"          # 每用户的 urdf 工作区
WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
STANDARD_XLSX = DATA_DIR / "standard_urdf_name.xlsx"

SESSION_COOKIE = "urdf_session"
SESSION_IDLE_TTL = 3 * 3600                     # PRD：3h 无动作自动登出
PBKDF2_ITERS = 120_000
USERNAME_RE = re.compile(r"^[A-Za-z0-9_\-]{2,32}$")

Base.metadata.create_all(engine)

# ---------------- 密码 / 会话 ----------------

def hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), PBKDF2_ITERS).hex()


def new_session(db: OrmSession, username: str) -> str:
    token = secrets.token_urlsafe(32)
    db.add(Session(token=token, username=username,
                   created_at=time.time(), last_active=time.time()))
    db.commit()
    return token


def log_event(db: OrmSession, username: str, action: str, detail: str = None):
    db.add(UsageEvent(username=username, action=action,
                      created_at=time.time(), detail=detail))
    db.commit()


def current_user(request: Request, db: OrmSession = Depends(get_db)) -> User:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(401, "未登录")
    sess = db.get(Session, token)
    now = time.time()
    if not sess or now - sess.last_active > SESSION_IDLE_TTL:
        if sess:
            db.delete(sess)
            db.commit()
        raise HTTPException(401, "会话已过期，请重新登录")
    sess.last_active = now                      # 滑动续期
    db.commit()
    user = db.query(User).filter(User.username == sess.username).first()
    if not user:
        raise HTTPException(401, "用户不存在")
    if not user.is_enabled:
        db.query(Session).filter(Session.token == token).delete()
        db.commit()
        raise HTTPException(403, "该账号已被禁止登录，请联系管理员")
    return user


def admin_user(user: User = Depends(current_user)) -> User:
    if not (user.is_admin or user.is_super):
        raise HTTPException(403, "需要管理员权限")
    return user


def user_dict(u: User) -> dict:
    return {"id": u.id, "username": u.username, "is_admin": bool(u.is_admin),
            "is_super": bool(u.is_super), "is_enabled": bool(u.is_enabled),
            "created_at": u.created_at}


# ---------------- App ----------------

app = FastAPI(title="URDF 可视化功能在线系统")


@app.on_event("startup")
def startup():
    Base.metadata.create_all(bind=engine)
    db = next(get_db())
    if db.query(User).count() == 0:
        salt = secrets.token_hex(16)
        db.add(User(username="admin", pw_hash=hash_password("admin123", salt),
                    salt=salt, is_admin=1, is_super=1, is_enabled=1,
                    created_at=time.time()))
        db.commit()
        print("[init] 已创建超级管理员 admin / admin123，请登录后尽快修改密码")


# ---------- 注册 / 登录 ----------

@app.post("/api/register")
async def register(request: Request, db: OrmSession = Depends(get_db)):
    body = await request.json()
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    confirm = body.get("confirm") or ""
    code = (body.get("invite_code") or "").strip().upper()
    if not USERNAME_RE.match(username):
        raise HTTPException(400, "用户名需为 2~32 位字母/数字/下划线/中划线")
    if len(password) < 6:
        raise HTTPException(400, "密码至少 6 位")
    if password != confirm:
        raise HTTPException(400, "两次输入的密码不一致")
    inv = db.get(InviteCode, code)
    if not inv:
        raise HTTPException(400, "邀请码无效")
    if inv.used_by:
        raise HTTPException(400, "邀请码已被使用")
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(400, "用户名已存在")
    salt = secrets.token_hex(16)
    db.add(User(username=username, pw_hash=hash_password(password, salt), salt=salt,
                is_admin=0, is_super=0, is_enabled=1, created_at=time.time()))
    inv.used_by = username
    inv.used_at = time.time()
    db.commit()
    return {"ok": True, "msg": "注册成功，请登录"}


@app.post("/api/login")
async def login(request: Request, db: OrmSession = Depends(get_db)):
    body = await request.json()
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    user = db.query(User).filter(User.username == username).first()
    if not user or not hmac.compare_digest(user.pw_hash, hash_password(password, user.salt)):
        raise HTTPException(401, "用户名或密码错误")
    if not user.is_enabled:
        raise HTTPException(403, "该账号已被禁止登录，请联系管理员")
    token = new_session(db, username)
    log_event(db, username, "login")
    resp = JSONResponse({"ok": True, **user_dict(user)})
    resp.set_cookie(SESSION_COOKIE, token, max_age=SESSION_IDLE_TTL,
                    httponly=True, samesite="lax")
    return resp


@app.post("/api/logout")
async def logout(request: Request, db: OrmSession = Depends(get_db)):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        db.query(Session).filter(Session.token == token).delete()
        db.commit()
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE)
    return resp


@app.get("/api/me")
async def me(user: User = Depends(current_user)):
    return user_dict(user)


@app.post("/api/change_password")
async def change_password(request: Request, user: User = Depends(current_user),
                          db: OrmSession = Depends(get_db)):
    body = await request.json()
    old, new = body.get("old") or "", body.get("new") or ""
    if len(new) < 6:
        raise HTTPException(400, "新密码至少 6 位")
    if not hmac.compare_digest(user.pw_hash, hash_password(old, user.salt)):
        raise HTTPException(400, "原密码错误")
    user.salt = secrets.token_hex(16)
    user.pw_hash = hash_password(new, user.salt)
    db.query(Session).filter(Session.username == user.username).delete()
    db.commit()
    return {"ok": True, "msg": "密码已修改，请重新登录"}


# ---------- URDF 导入（左/右手） ----------

def hand_or_400(hand: str) -> str:
    if hand not in ("left", "right"):
        raise HTTPException(400, "hand 必须是 left 或 right")
    return hand


@app.post("/api/urdf/upload")
async def upload_urdf(
    hand: str = Form(...),
    file: UploadFile = File(...),
    user: User = Depends(current_user),
    db: OrmSession = Depends(get_db),
):
    hand = hand_or_400(hand)
    if not file.filename.lower().endswith(".urdf"):
        raise HTTPException(400, "只能选择 .urdf 文件")
    content = await file.read()
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(400, "单个 URDF 不能超过 50MB")
    text = content.decode("utf-8", errors="replace")
    if "<robot" not in text:
        raise HTTPException(400, "文件内容不是有效的 URDF（缺少 <robot>）")
    d = WORKSPACE_DIR / user.username
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{hand}.urdf").write_text(text, encoding="utf-8")
    (d / f"{hand}.filename").write_text(file.filename, encoding="utf-8")
    log_event(db, user.username, "import_urdf", hand)
    return {"ok": True, "hand": hand, "filename": file.filename}


@app.get("/api/urdf/current")
async def current_urdf(hand: str, user: User = Depends(current_user)):
    hand = hand_or_400(hand)
    d = WORKSPACE_DIR / user.username
    fp = d / f"{hand}.urdf"
    if not fp.is_file():
        return {"exists": False, "hand": hand}
    name_fp = d / f"{hand}.filename"
    return {"exists": True, "hand": hand,
            "filename": name_fp.read_text(encoding="utf-8") if name_fp.is_file() else f"{hand}.urdf",
            "content": fp.read_text(encoding="utf-8")}


# ---------- 标准命名表 ----------

_names_cache = {"mtime": 0.0, "names": []}


def load_standard_names() -> list:
    if not STANDARD_XLSX.is_file():
        return []
    mtime = STANDARD_XLSX.stat().st_mtime
    if mtime == _names_cache["mtime"]:
        return _names_cache["names"]
    import openpyxl
    wb = openpyxl.load_workbook(STANDARD_XLSX, read_only=True, data_only=True)
    names = set()
    for ws in wb.worksheets:
        for row in ws.iter_rows(values_only=True):
            for cell in row:
                if cell is not None:
                    s = str(cell).strip()
                    if s:
                        names.add(s)
    wb.close()
    _names_cache.update(mtime=mtime, names=sorted(names))
    return _names_cache["names"]


@app.get("/api/standard-names")
async def standard_names(user: User = Depends(current_user)):
    names = load_standard_names()
    return {"loaded": bool(names), "count": len(names), "names": names}


@app.post("/api/admin/standard-names")
async def upload_standard_names(
    file: UploadFile = File(...),
    admin: User = Depends(admin_user),
):
    if not file.filename.lower().endswith(".xlsx"):
        raise HTTPException(400, "请上传 .xlsx 文件")
    STANDARD_XLSX.write_bytes(await file.read())
    _names_cache["mtime"] = 0.0
    names = load_standard_names()
    return {"ok": True, "count": len(names)}


# ---------- 使用事件（前端操作埋点） ----------

ALLOWED_ACTIONS = {"param_export", "mirror_run", "check_run"}


@app.post("/api/events")
async def post_event(request: Request, user: User = Depends(current_user),
                     db: OrmSession = Depends(get_db)):
    body = await request.json()
    action = body.get("action") or ""
    if action not in ALLOWED_ACTIONS:
        raise HTTPException(400, "未知的事件类型")
    log_event(db, user.username, action, body.get("detail"))
    return {"ok": True}


# ---------- 管理统计页 ----------

@app.get("/api/admin/stats")
async def admin_stats(year: int = None, month: int = None, day: int = None,
                      admin: User = Depends(admin_user),
                      db: OrmSession = Depends(get_db)):
    now = datetime.now()
    year = year or now.year
    if day:
        start = datetime(year, month or now.month, day)
        end_ts = start.timestamp() + 86400
        label = start.strftime("%Y-%m-%d")
    elif month:
        start = datetime(year, month, 1)
        label = start.strftime("%Y-%m")
        end_ts = (datetime(year + (month == 12), month % 12 + 1, 1)).timestamp()
    else:
        start = datetime(year, 1, 1)
        label = str(year)
        end_ts = datetime(year + 1, 1, 1).timestamp()
    start_ts = start.timestamp()
    rows = db.query(UsageEvent).filter(
        UsageEvent.created_at >= start_ts, UsageEvent.created_at < end_ts).all()
    actions = {}
    for r in rows:
        actions[r.action] = actions.get(r.action, 0) + 1
    return {"label": label,
            "active_users": len({r.username for r in rows}),
            "actions": actions}


@app.get("/api/admin/users")
async def admin_users(q: str = None, admin: User = Depends(admin_user),
                      db: OrmSession = Depends(get_db)):
    query = db.query(User)
    if q:
        query = query.filter(User.username.like(f"%{q}%"))
    return {"users": [user_dict(u) for u in query.order_by(User.id).all()]}


@app.patch("/api/admin/users/{uid}")
async def admin_update_user(uid: int, request: Request,
                            admin: User = Depends(admin_user),
                            db: OrmSession = Depends(get_db)):
    body = await request.json()
    target = db.get(User, uid)
    if not target:
        raise HTTPException(404, "用户不存在")
    if target.is_super and (body.get("is_admin") is False or body.get("is_enabled") is False):
        raise HTTPException(400, "超级管理员拥有永久权限，不能降权或禁用")
    if target.username == admin.username and body.get("is_admin") is False:
        raise HTTPException(400, "不能取消自己的管理员权限")
    if "is_admin" in body:
        target.is_admin = 1 if body["is_admin"] else 0
    if "is_enabled" in body:
        target.is_enabled = 1 if body["is_enabled"] else 0
        if not body["is_enabled"]:
            db.query(Session).filter(Session.username == target.username).delete()
    db.commit()
    return {"ok": True}


@app.post("/api/admin/ban_all")
async def ban_all(admin: User = Depends(admin_user), db: OrmSession = Depends(get_db)):
    db.query(User).filter(User.is_super == 0).update({User.is_enabled: 0})
    db.query(Session).filter(
        Session.username.notin_(
            db.query(User.username).filter(User.is_super == 1))).delete(
        synchronize_session=False)
    db.commit()
    return {"ok": True, "msg": "已禁止除超级管理员外的所有用户登录"}


@app.post("/api/admin/unban_all")
async def unban_all(admin: User = Depends(admin_user), db: OrmSession = Depends(get_db)):
    db.query(User).update({User.is_enabled: 1})
    db.commit()
    return {"ok": True, "msg": "已恢复全员登录权限"}


# ---------- 邀请码 ----------

@app.post("/api/admin/invite-codes")
async def create_invite(admin: User = Depends(admin_user), db: OrmSession = Depends(get_db)):
    code = secrets.token_hex(4).upper()          # 8 位随机码
    db.add(InviteCode(code=code, created_by=admin.username, created_at=time.time()))
    db.commit()
    return {"ok": True, "code": code}


@app.get("/api/admin/invite-codes")
async def list_invites(admin: User = Depends(admin_user), db: OrmSession = Depends(get_db)):
    rows = db.query(InviteCode).order_by(InviteCode.created_at.desc()).limit(50).all()
    return {"codes": [{"code": r.code, "created_by": r.created_by,
                       "used_by": r.used_by,
                       "created_at": r.created_at, "used_at": r.used_at} for r in rows]}


# ---------- 静态页面 ----------

app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
