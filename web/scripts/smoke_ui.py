"""UI smoke (Playwright, python). Usage: BASE=http://localhost:8480 DH_USER=.. DH_PASS=.. SHOTS=dir python3 smoke_ui.py
Covers login, file list, preview, account tabs, admin pages, custom select/checkbox/pager, theme; fails on console errors."""
import os, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:8480")
U, P = os.environ["DH_USER"], os.environ["DH_PASS"]
SHOTS = os.environ.get("SHOTS", "")
errors, fails = [], []

def check(name, cond):
    if not cond:
        fails.append(name)
    print(("PASS " if cond else "FAIL ") + name)

def shot(page, tag, name):
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/{tag}-{name}.png")

def run(pw, tag, vp, mobile):
    br = pw.chromium.launch()
    ctx = br.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile, color_scheme="light")
    page = ctx.new_page()
    page.on("console", lambda m: m.type == "error" and errors.append(f"[{tag}] {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"[{tag}] pageerror {e}"))
    page.goto(BASE + "/")
    page.wait_for_selector("form")
    shot(page, tag, "01-login")
    page.get_by_label("用户名或邮箱").fill(U)
    page.get_by_label("密码").fill(P)
    page.get_by_role("button", name="登录").click()
    page.wait_for_selector("#main", timeout=10000)
    page.wait_for_timeout(500)
    check(f"{tag} login", page.locator("#main").count() == 1)
    # files
    page.goto(BASE + "/#/files"); page.wait_for_timeout(600)
    shot(page, tag, "02-files-root")
    page.goto(BASE + "/#/files/示例"); page.wait_for_timeout(800)
    rows = page.locator('[role=row][data-path], [aria-label=文件网格] li')
    check(f"{tag} file list has rows", rows.count() > 0)
    # checkbox hit area >= 40px
    cb = page.locator("label.check").nth(1)
    if cb.count():
        bb = cb.bounding_box()
        check(f"{tag} checkbox hit area >=40", bb and bb["width"] >= 40 and bb["height"] >= 40)
        cb.click(force=True); page.wait_for_timeout(200)
    shot(page, tag, "03-files-selected")
    page.keyboard.press("Escape")
    # preview a file
    link = page.locator('[role=row][data-path] a').filter(has_text=".txt")
    if link.count():
        link.first.dblclick(); page.wait_for_timeout(800)
        check(f"{tag} preview opens", page.locator('[role=dialog]').count() > 0 or page.locator("text=示例发票").count() > 0)
        shot(page, tag, "04-preview")
        page.keyboard.press("Escape")
    # account tabs
    page.goto(BASE + "/#/account"); page.wait_for_timeout(600)
    shot(page, tag, "05-account-profile")
    for t, label in [("security", "安全"), ("tokens", "令牌"), ("devices", "登录设备")]:
        page.get_by_role("tab", name=label).click(); page.wait_for_timeout(400)
        check(f"{tag} account tab {t}", page.url.endswith("/account/" + t))
        shot(page, tag, f"06-account-{t}")
    # custom select in tokens tab
    page.get_by_role("tab", name="令牌").click(); page.wait_for_timeout(300)
    sel = page.get_by_role("combobox", name="有效期")
    sel.click(); page.wait_for_timeout(300)
    shot(page, tag, "07-select-open")
    page.get_by_role("option", name="1 年").click()
    check(f"{tag} custom select works", "1 年" in sel.inner_text())
    check(f"{tag} no native select", page.locator("select").count() == 0)
    # admin
    for r, name in [("dashboard", "dash"), ("users", "users"), ("audit", "audit"), ("mounts", "mounts"), ("acl", "acl"), ("settings", "settings"), ("settings/service", "settings-service")]:
        page.goto(BASE + "/#/admin/" + r); page.wait_for_timeout(700)
        shot(page, tag, f"08-admin-{name}")
    page.goto(BASE + "/#/admin/settings"); page.wait_for_timeout(300)
    page.get_by_role("tab", name="服务状态").click(); page.wait_for_timeout(300)
    check(f"{tag} admin settings tabs", page.url.endswith("/settings/service"))
    page.goto(BASE + "/#/tasks"); page.wait_for_timeout(500)
    page.goto(BASE + "/#/search?q=a"); page.wait_for_timeout(800)
    shot(page, tag, "09-search")
    # dark theme
    page.evaluate("localStorage.setItem('dh_theme','dark')"); page.goto(BASE + "/#/files/示例"); page.reload(); page.wait_for_timeout(800)
    check(f"{tag} dark applied", page.evaluate("document.documentElement.dataset.theme") == "dark")
    shot(page, tag, "10-files-dark")
    page.goto(BASE + "/#/admin/dashboard"); page.wait_for_timeout(600)
    shot(page, tag, "11-admin-dark")
    page.evaluate("localStorage.setItem('dh_theme','light')")
    # native dialogs never used
    br.close()

with sync_playwright() as pw:
    run(pw, "desktop", {"width": 1440, "height": 900}, False)
    run(pw, "mobile", {"width": 390, "height": 844}, True)
print("console errors:", len(errors))
for e in errors: print("  ", e)
sys.exit(1 if fails or errors else 0)
