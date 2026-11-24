# 浏览器端到端验证脚本（PRD v0.1 / 阶段1-1）
import subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "tmp_shots"
SHOTS.mkdir(exist_ok=True)
PORT = 8016
USER2 = "u" + str(int(time.time()))[-7:]

server = subprocess.Popen(
    [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(PORT)],
    cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(40):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/", timeout=1); break
        except Exception:
            time.sleep(0.5)

    errors, failures = [], []
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1440, "height": 960}, accept_downloads=True)
        pg = ctx.new_page()
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("response", lambda r: failures.append(f"{r.status} {r.url}") if r.status >= 400 else None)

        pg.goto(f"http://127.0.0.1:{PORT}/")
        pg.wait_for_selector(".login-card")
        pg.screenshot(path=SHOTS / "1_login.png")

        # ---- admin 登录 ----
        pg.fill(".login-card input >> nth=0", "admin")
        pg.fill(".login-card input[type=password]", "admin123")
        pg.click(".login-card form button.btn-primary")
        pg.wait_for_selector(".topbar")
        print("1. admin 登录 OK")

        # ---- 生成邀请码 ----
        pg.click("text=管理统计")
        pg.wait_for_selector(".admin-grid")
        pg.click("text=生成新邀请码")
        pg.wait_for_timeout(600)
        code = pg.inner_text(".invite-list .invite-item >> nth=0 >> span >> nth=0").strip()
        print("2. 邀请码:", code)
        pg.screenshot(path=SHOTS / "2_admin.png")

        # ---- 统计页查询 ----
        pg.click("button:has-text('查询')")
        pg.wait_for_timeout(500)
        print("3. 统计卡片数:", pg.eval_on_selector_all(".stat-card", "e=>e.length"))

        # ---- 回主页导入左手 URDF ----
        pg.click("text=返回主功能页")
        pg.set_input_files(".region >> nth=0 >> input[type=file] >> nth=0",
                           str(ROOT / "examples" / "left_hand_demo.urdf"))
        pg.wait_for_timeout(1200)
        stat_line = pg.inner_text(".dof-stats")
        print("4. 自由度统计:", stat_line)
        n_nodes = pg.eval_on_selector_all(".region >> nth=0 >> .jg-node", "e=>e.length")
        n_m = pg.eval_on_selector_all(".region >> nth=0 >> .m-badge", "e=>e.length")
        print(f"   节点数: {n_nodes}, 主动标记m: {n_m}")
        pg.screenshot(path=SHOTS / "3_region1_graph.png")

        # 点击节点显示全称
        pg.click(".region >> nth=0 >> .jg-node >> nth=0")
        pg.wait_for_timeout(300)
        tip = pg.inner_text(".jg-tip")
        print("5. 节点提示:", " | ".join(tip.splitlines()))

        # ---- 区域4：参数修改 ----
        pg.click(".region4-grid .jg-node >> nth=0")
        pg.wait_for_timeout(400)
        joint_name = pg.inner_text(".cur-joint-label b >> nth=0")
        print("6. 选中 joint:", joint_name)
        # 输入非法值 -> 标红 + 禁止导出
        pg.fill(".ptable td >> nth=1 >> input", "abc")
        pg.click("text=确认修改")
        pg.wait_for_timeout(300)
        n_red = pg.eval_on_selector_all(".cell-invalid", "e=>e.length")
        exp_disabled = pg.is_disabled("button:has-text('导出 URDF')")
        print(f"7. 非法值校验: 标红单元格={n_red}, 导出禁用={exp_disabled}")
        pg.screenshot(path=SHOTS / "4_param_invalid.png")
        # 修正后确认 + 导出
        pg.fill(".ptable td >> nth=1 >> input", "0.5")
        pg.click("text=确认修改")
        pg.wait_for_timeout(300)
        exp_disabled2 = pg.is_disabled("button:has-text('导出 URDF')")
        print("8. 修正后导出禁用:", exp_disabled2)
        with pg.expect_download() as dl_info:
            pg.click("button:has-text('导出 URDF')")
        dl = dl_info.value
        out = SHOTS / dl.suggested_filename
        dl.save_as(out)
        content = out.read_text(encoding="utf-8")
        ok = 'lower="0.5"' in content or '>0.5<' in content or 'lower="0.5' in content
        print("9. 导出文件:", dl.suggested_filename, "| 包含修改值:", ok)
        pg.wait_for_timeout(800)
        pg.screenshot(path=SHOTS / "5_param_export.png")

        # ---- 退出并用邀请码注册新用户 ----
        pg.click("text=退出")
        pg.wait_for_selector(".login-card")
        pg.click(".auth-tabs button >> nth=1")
        pg.fill(".login-card input >> nth=0", USER2)
        pg.fill(".login-card input[type=password] >> nth=0", "user123456")
        pg.fill(".login-card input[type=password] >> nth=1", "user123456")
        pg.fill(".login-card input >> nth=3", code)
        pg.click(".login-card form button.btn-primary")
        pg.wait_for_timeout(800)
        err_el = pg.query_selector(".login-card .form-error")
        ok_el = pg.query_selector(".login-card .form-ok")
        print("   注册反馈:", (err_el.inner_text() if err_el else "") or (ok_el.inner_text() if ok_el else "(无)"))
        pg.fill(".login-card input >> nth=0", USER2)
        pg.fill(".login-card input[type=password]", "user123456")
        pg.click(".login-card form button.btn-primary")
        pg.wait_for_selector(".topbar")
        admin_btn = pg.query_selector("text=管理统计")
        print("10. 注册用户登录 OK，管理统计按钮可见:", admin_btn is not None and admin_btn.is_visible())

        # 新用户应看到 admin 导入的左手文件？不应看到（每用户隔离）
        left_disabled = pg.eval_on_selector(".hand-switch button >> nth=0", "e=>e.disabled")
        print("11. 新用户左手按钮禁用(无文件):", left_disabled)
        ctx.close()

        # ---- admin 拉黑 user02，验证无法登录 ----
        ctx2 = b.new_context(viewport={"width": 1440, "height": 960})
        pg2 = ctx2.new_page()
        pg2.goto(f"http://127.0.0.1:{PORT}/")
        pg2.fill(".login-card input >> nth=0", "admin")
        pg2.fill(".login-card input[type=password]", "admin123")
        pg2.click(".login-card form button.btn-primary")
        pg2.wait_for_selector(".topbar")
        pg2.click("text=管理统计")
        pg2.wait_for_selector(".admin-grid")
        pg2.fill("input[placeholder='输入用户名']", USER2)
        pg2.click("button:has-text('禁止登录')")
        pg2.wait_for_timeout(600)
        print("12. 拉黑提示:", pg2.inner_text(".page > .hint"))
        pg2.click("text=退出")
        pg2.wait_for_selector(".login-card")
        pg2.fill(".login-card input >> nth=0", USER2)
        pg2.fill(".login-card input[type=password]", "user123456")
        pg2.click(".login-card form button.btn-primary")
        pg2.wait_for_timeout(600)
        print("13. 被拉黑用户登录提示:", pg2.inner_text(".form-error"))
        pg2.screenshot(path=SHOTS / "6_banned.png")
        ctx2.close()
        b.close()

    print("\n=== console errors ===")
    print("\n".join(errors) if errors else "(none)")
    print("=== http failures (预期含401探测) ===")
    print("\n".join(failures) if failures else "(none)")
finally:
    server.terminate()
