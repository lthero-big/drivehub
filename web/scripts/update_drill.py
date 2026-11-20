"""DEPTAI-484 UI drill (Playwright, python): real upgrade + rollback through the admin
"系统更新" page, and the "刷新以加载新版本" banner on an already-open page.

BASE=http://localhost:8484 DH_USER=admin DH_PASS=.. SHOTS=dir \
GOOD=http://127.0.0.1:8485/v0.2.0/release-manifest.json \
BAD=http://127.0.0.1:8485/v0.3.0/release-manifest.json python3 update_drill.py
"""
import os, sys, time
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:8484")
U, P = os.environ["DH_USER"], os.environ["DH_PASS"]
SHOTS = os.environ.get("SHOTS", "")
GOOD, BAD = os.environ["GOOD"], os.environ["BAD"]
errors, fails = [], []

def check(name, cond):
    (fails.append(name) if not cond else None)
    print(("PASS " if cond else "FAIL ") + name, flush=True)

def shot(page, name, full=True):
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/{name}.png", full_page=full)

def wait_text(page, text, secs):
    t = time.time()
    while time.time() - t < secs:
        if page.get_by_text(text, exact=False).count() > 0:
            return True
        page.wait_for_timeout(500)
    return False

def set_source_and_check(page, url):
    page.goto(BASE + "/#/admin/update"); page.wait_for_selector("text=更新设置", timeout=15000)
    src = page.get_by_label("更新源（清单 URL）")
    src.fill(url)
    page.get_by_role("button", name="保存").click(); page.wait_for_timeout(600)
    page.get_by_role("button", name="检查更新").click(); page.wait_for_timeout(1500)

with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 1360, "height": 900}, color_scheme="light")
    page = ctx.new_page()
    for p in (page,):
        p.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
    page.goto(BASE + "/"); page.wait_for_selector("form")
    page.get_by_label("用户名或邮箱").fill(U); page.get_by_label("密码").fill(P)
    page.get_by_role("button", name="登录").click()
    page.wait_for_selector("#main", timeout=10000)

    # open "user" tab that stays on the old bundle
    files = ctx.new_page()
    files.on("pageerror", lambda e: errors.append(f"pageerror(files) {e}"))
    files.goto(BASE + "/#/files"); files.wait_for_timeout(1200)
    check("files tab footer shows server 0.1.0", files.get_by_text("Server 0.1.0").count() > 0)

    page.bring_to_front()
    set_source_and_check(page, GOOD)
    check("update available badge", page.get_by_text("有可用更新").count() > 0)
    check("release notes rendered", page.locator(".prose-dh h2").count() > 0)
    shot(page, "01-update-page-available")

    page.get_by_role("button", name="立即更新").first.click()
    page.get_by_role("dialog").get_by_role("button", name="立即更新").click()
    page.wait_for_timeout(700)
    shot(page, "02-update-in-progress", full=False)
    ok = wait_text(page, "更新成功", 120)
    check("upgrade succeeded (UI)", ok)
    page.wait_for_timeout(1500)
    check("0.2.0 no longer offered after install", page.get_by_text("已是最新").count() > 0)
    page.wait_for_timeout(800)
    shot(page, "03-update-succeeded-refresh-prompt")
    check("page shows refresh prompt", page.get_by_text("刷新以加载新版本").count() > 0)

    files.bring_to_front()
    files.evaluate("window.dispatchEvent(new Event('focus'))"); files.wait_for_timeout(1500)
    check("open files tab shows banner", files.get_by_text("刷新以加载新版本").count() > 0)
    shot(files, "04-files-refresh-banner", full=False)
    with files.expect_navigation():
        files.get_by_role("button", name="刷新页面").click()
    files.wait_for_selector("#main", timeout=15000); files.wait_for_timeout(2500)
    check("after reload web+server are 0.2.0", files.get_by_text("Web 0.2.0 · Server 0.2.0").count() > 0)
    check("banner gone after reload", files.get_by_text("刷新以加载新版本").count() == 0)

    # rollback drill: 0.3.0 is built with DRIVEHUB_BUILD_FAULT=unhealthy
    page.bring_to_front(); page.reload(); page.wait_for_timeout(1000)
    set_source_and_check(page, BAD)
    check("0.3.0 offered", page.get_by_text("0.3.0").count() > 0)
    page.get_by_role("button", name="立即更新").first.click()
    page.get_by_role("dialog").get_by_role("button", name="立即更新").click()
    ok = wait_text(page, "已回滚", 150)
    check("unhealthy release rolled back (UI)", ok)
    page.wait_for_timeout(800)
    shot(page, "05-rolled-back")
    br.close()

print("errors:", errors)
sys.exit(1 if fails or errors else 0)
