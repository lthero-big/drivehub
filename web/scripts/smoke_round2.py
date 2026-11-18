"""DEPTAI-485 round-2 UI checks + screenshots (Playwright, python).
Usage: BASE=http://localhost:8480 DH_USER=.. DH_PASS=.. SHOTS=dir python3 smoke_round2.py
Covers: top bar (theme switch + search icon), avatar menu (no scrollbar), selection dock, context menu,
⋯ menu on the last row (portal + collision), opaque popovers, multi-tab file view with sidebar, sidebar collapse,
folder icon hover, delete → undo toast, confirm-morph button, image card stack, dark theme, mobile."""
import json, os, sys, urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:8480")
U, P = os.environ["DH_USER"], os.environ["DH_PASS"]
SHOTS = os.environ.get("SHOTS", "/tmp")
DOC = "/示例/文档"
errors, fails = [], []

def check(name, cond):
    (fails.append(name) if not cond else None)
    print(("PASS " if cond else "FAIL ") + name)

def shot(page, name, **kw):
    page.screenshot(path=f"{SHOTS}/{name}.png", **kw)

def api(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json", **({"authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b"{}")

def listing(path, tok):
    return [i["name"] for i in api("GET", "/api/fs/list?" + urllib.parse.urlencode({"path": path, "refresh": "true"}), token=tok)["items"]]

import urllib.parse
tok = api("POST", "/api/auth/login", {"login": U, "password": P})["access_token"]
for n in ["撤销测试", "提交测试"]:
    try: api("POST", "/api/fs/delete", {"path": f"{DOC}/{n}"}, tok)
    except Exception: pass
    api("POST", "/api/fs/mkdir", {"path": f"{DOC}/{n}"}, tok)

def login(page):
    page.goto(BASE + "/")
    page.wait_for_selector("form")
    page.get_by_label("用户名或邮箱").fill(U)
    page.get_by_label("密码").fill(P)
    page.get_by_role("button", name="登录").click()
    page.wait_for_selector("#main", timeout=10000)
    page.wait_for_timeout(400)

def in_view(page, loc):
    bb = loc.bounding_box(); vp = page.viewport_size
    return bb and bb["y"] >= 0 and bb["x"] >= 0 and bb["y"] + bb["height"] <= vp["height"] + 0.5 and bb["x"] + bb["width"] <= vp["width"] + 0.5

def opaque(page, sel):
    return page.evaluate("""s => { const e = document.querySelector(s); if (!e) return false; const c = getComputedStyle(e).backgroundColor;
      const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return false; const p = m[1].split(/[ ,\\/]+/).filter(Boolean); return p.length < 4 || parseFloat(p[3]) === 1; }""", sel)

def row(page, name, d=DOC):
    return page.locator(f'[role=row][data-path="{d}/{name}"]')

def desktop(pw):
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 1440, "height": 900}, color_scheme="light")
    page = ctx.new_page()
    page.on("console", lambda m: m.type == "error" and errors.append(f"[desktop] {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"[desktop] pageerror {e}"))
    login(page)
    page.evaluate("localStorage.setItem('dh_theme','light')")
    page.goto(BASE + "/#/files" + DOC); page.wait_for_timeout(900)
    # 1/2 top bar
    hdr = page.locator("header").first
    check("topbar has theme switch (3 options)", hdr.get_by_role("radio").count() == 3)
    check("topbar search is icon only", hdr.get_by_role("button", name="搜索（⌘K）").count() == 1 and hdr.locator("input").count() == 0)
    shot(page, "01-light-files")
    shot(page, "02-topbar", clip={"x": 0, "y": 0, "width": 1440, "height": 64})
    hdr.get_by_role("button", name="搜索（⌘K）").click(); page.wait_for_timeout(300)
    check("search icon opens global palette", page.get_by_role("dialog", name="命令面板").count() == 1)
    page.keyboard.press("Escape")
    # avatar menu
    page.get_by_role("button", name="账户菜单").click(); page.wait_for_timeout(400)
    m = page.locator("[role=menu]")
    check("avatar menu opens upward inside viewport", m.count() == 1 and in_view(page, m))
    check("avatar menu has no theme items", m.get_by_text("深色").count() == 0)
    check("no page scrollbar with avatar menu", page.evaluate("document.documentElement.scrollHeight <= innerHeight"))
    shot(page, "03-avatar-menu")
    page.keyboard.press("Escape"); page.mouse.click(900, 300); page.wait_for_timeout(200)
    # 3 selection dock
    row(page, "报告.txt").locator("a").click(); row(page, "README.md").locator("a").click(modifiers=["Control"]); page.wait_for_timeout(600)
    dock = page.get_by_role("toolbar", name="批量操作")
    bb = dock.bounding_box() if dock.count() else None
    check("selection dock floats bottom-centre", bool(bb) and abs(bb["x"] + bb["width"] / 2 - 720) < 4 and bb["y"] > 780)
    check("path bar no longer hosts the selection toolbar", page.locator(".sticky [role=toolbar]").count() == 0)
    dock.get_by_role("button", name="打包下载").hover(); page.wait_for_timeout(400)
    shot(page, "04-action-dock")
    # confirm morph in the dock
    dock.get_by_role("button", name="删除").click(); page.wait_for_timeout(600)
    check("confirm-morph armed shows 取消 + 删除 N 项", dock.get_by_role("button", name="删除 2 项").count() == 1 and dock.get_by_role("button", name="取消", exact=True).count() == 1)
    shot(page, "05-confirm-morph-dock")
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    check("Esc disarms confirm-morph", dock.get_by_role("button", name="删除 2 项").count() == 0)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    # context menu
    r = row(page, "报告.pdf"); b = r.bounding_box()
    page.mouse.click(b["x"] + 300, b["y"] + b["height"] / 2, button="right"); page.wait_for_timeout(400)
    cm = page.get_by_role("menu", name="文件操作")
    names = cm.get_by_role("menuitem").all_inner_texts() if cm.count() else []
    want = ["打开", "在新标签页打开", "下载", "分享", "重命名", "移动到", "复制到", "复制链接", "复制路径", "收藏", "属性", "删除"]
    check("context menu has rich actions", all(any(w in n for n in names) for w in want))
    check("context menu opaque", opaque(page, "[role=menu]"))
    shot(page, "06-context-menu")
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    # 4 ⋯ menu on the bottom row with a short viewport
    page.set_viewport_size({"width": 1440, "height": 560})
    page.goto(BASE + "/#/files/示例/照片"); page.wait_for_timeout(900)
    page.evaluate("document.getElementById('main').scrollTo(0, 1e6)"); page.wait_for_timeout(300)
    last = page.locator("[role=row][data-path]").last
    last.hover(); last.get_by_role("button", name="更多操作").click(); page.wait_for_timeout(500)
    m = page.locator("[role=menu]")
    check("⋯ menu on last row fully visible (flipped/shifted)", m.count() == 1 and in_view(page, m))
    shot(page, "07-row-menu-bottom")
    page.keyboard.press("Escape")
    page.set_viewport_size({"width": 1440, "height": 900})
    # 5 opaque dropdowns
    page.goto(BASE + "/#/files" + DOC); page.wait_for_timeout(700)
    page.get_by_role("button", name="排序：名称").click(); page.wait_for_timeout(400)
    check("sort dropdown opaque", opaque(page, "[role=menu]"))
    shot(page, "08-dropdown-opaque")
    page.keyboard.press("Escape")
    page.goto(BASE + "/#/account/tokens"); page.wait_for_timeout(700)
    page.get_by_role("combobox", name="有效期").click(); page.wait_for_timeout(400)
    check("select listbox opaque", opaque(page, "[role=listbox]"))
    shot(page, "09-select-opaque")
    page.keyboard.press("Escape")
    # 6 tabs
    page.goto(BASE + "/#/files" + DOC); page.wait_for_timeout(800)
    row(page, "README.md").dblclick(); page.wait_for_timeout(900)
    page.get_by_role("tab").first.click(); page.wait_for_timeout(500)
    row(page, "报告.txt").dblclick(); page.wait_for_timeout(700)
    page.goto(BASE + "/#/files" + DOC + "/代码"); page.wait_for_timeout(800)
    row(page, "transfer_api.rs", DOC + "/代码").dblclick(); page.wait_for_timeout(1000)
    tabs = page.get_by_role("tablist", name="已打开的文件").get_by_role("tab")
    check("3 files open as tabs (+ folder tab)", tabs.count() == 4)
    check("sidebar stays visible with a file open", page.locator("aside[aria-label=侧栏]").is_visible())
    check("file view shows path breadcrumb", page.get_by_role("navigation", name="文件路径").count() == 1)
    check("no fullscreen preview dialog", page.locator("[role=dialog][aria-modal=true]").count() == 0)
    shot(page, "10-tabs-with-sidebar")
    page.get_by_role("button", name="切换同目录文件").click(); page.wait_for_timeout(400)
    shot(page, "10b-breadcrumb-switcher")
    page.keyboard.press("Escape")
    tabs.nth(2).click(button="middle"); page.wait_for_timeout(400)
    check("middle click closes a tab", tabs.count() == 3)
    page.reload(); page.wait_for_timeout(1200)
    check("tabs persist after reload", page.get_by_role("tablist", name="已打开的文件").get_by_role("tab").count() == 3 and page.get_by_role("navigation", name="文件路径").count() == 1)
    # 7 sidebar collapse
    page.get_by_role("button", name="收起侧栏（Ctrl/⌘ B）").click(); page.wait_for_timeout(500)
    w = page.locator("aside[aria-label=侧栏]").bounding_box()["width"]
    check("sidebar collapses to icon rail", w < 80)
    shot(page, "11-sidebar-collapsed")
    page.reload(); page.wait_for_timeout(900)
    check("collapsed state remembered", page.locator("aside[aria-label=侧栏]").bounding_box()["width"] < 80)
    page.get_by_role("button", name="展开侧栏（Ctrl/⌘ B）").click(); page.wait_for_timeout(500)
    check("unified sidebar/main background", page.evaluate("getComputedStyle(document.querySelector('aside[aria-label=侧栏]')).backgroundColor === getComputedStyle(document.getElementById('main')).backgroundColor"))
    # 8 folder icons
    page.get_by_role("tab").first.click(); page.wait_for_timeout(300)
    page.goto(BASE + "/#/files/示例"); page.wait_for_timeout(900)
    page.locator('[role=row][data-path="/示例/文档"]').hover(); page.wait_for_timeout(700)
    shot(page, "12-folder-list-hover")
    page.get_by_role("radio", name="网格").click(); page.wait_for_timeout(600)
    page.locator('[aria-label=文件网格] li').first.hover(); page.wait_for_timeout(800)
    shot(page, "13-folder-grid-hover")
    page.get_by_role("radio", name="列表").click(); page.wait_for_timeout(300)
    # delete → undo toast
    page.goto(BASE + "/#/files" + DOC); page.wait_for_timeout(900)
    r = row(page, "撤销测试"); b = r.bounding_box()
    page.mouse.click(b["x"] + 400, b["y"] + b["height"] / 2, button="right"); page.wait_for_timeout(300)
    page.get_by_role("menu", name="文件操作").get_by_role("menuitem", name="删除").click(); page.wait_for_timeout(400)
    shot(page, "14a-delete-confirm-dialog")
    page.get_by_role("dialog").get_by_role("button", name="删除").click(); page.wait_for_timeout(180)
    shot(page, "14b-dialog-to-toast-morph")
    page.wait_for_timeout(700)
    check("row hidden immediately after delete", row(page, "撤销测试").count() == 0)
    shot(page, "14c-undo-toast")
    page.get_by_role("button", name="撤销").click(); page.wait_for_timeout(600)
    check("undo restores the row", row(page, "撤销测试").count() == 1)
    page.wait_for_timeout(5500)
    check("undone item still exists on server", "撤销测试" in listing(DOC, tok))
    r = row(page, "提交测试"); b = r.bounding_box()
    page.mouse.click(b["x"] + 400, b["y"] + b["height"] / 2); page.keyboard.press("Delete"); page.wait_for_timeout(300)
    page.get_by_role("dialog").get_by_role("button", name="删除").click(); page.wait_for_timeout(6500)
    check("delete commits after the undo window", "提交测试" not in listing(DOC, tok))
    # confirm morph on admin users (not executed)
    page.goto(BASE + "/#/admin/users"); page.wait_for_timeout(900)
    btn = page.get_by_role("button", name="删除用户 alice")
    if btn.count():
        btn.click(); page.wait_for_timeout(600)
        check("users delete uses confirm-morph", page.get_by_role("button", name="删除用户").count() >= 1)
        shot(page, "15-confirm-morph-users")
        page.keyboard.press("Escape")
    # image card stack
    page.goto(BASE + "/#/files/示例/照片"); page.wait_for_timeout(900)
    row(page, "photo_1.jpg", "/示例/照片").dblclick(); page.wait_for_timeout(1500)
    check("image viewer opens as tab", page.get_by_text("1 / 8").count() == 1)
    shot(page, "16-image-stack")
    card = page.locator(".stack-card.cursor-grab"); cb = card.bounding_box()
    page.mouse.move(cb["x"] + cb["width"] / 2, cb["y"] + cb["height"] * 0.3); page.mouse.down()
    for i in range(1, 11): page.mouse.move(cb["x"] + cb["width"] / 2 - i * 18, cb["y"] + cb["height"] * 0.3 + i * 2); page.wait_for_timeout(16)
    page.wait_for_timeout(100)
    shot(page, "16b-image-stack-drag")
    page.mouse.up(); page.wait_for_timeout(900)
    check("swipe advances to next image", page.get_by_text("2 / 8").count() == 1)
    # dark
    page.locator("header").get_by_role("radio", name="深色").click(); page.wait_for_timeout(500)
    check("dark theme from top bar", page.evaluate("document.documentElement.dataset.theme") == "dark")
    shot(page, "17-dark-image-tab")
    page.get_by_role("tab").first.click(); page.wait_for_timeout(300)
    page.goto(BASE + "/#/files" + DOC); page.wait_for_timeout(800)
    shot(page, "18-dark-files")
    r = row(page, "报告.docx"); b = r.bounding_box()
    page.mouse.click(b["x"] + 300, b["y"] + b["height"] / 2, button="right"); page.wait_for_timeout(400)
    check("dark context menu opaque", opaque(page, "[role=menu]"))
    shot(page, "19-dark-context-menu")
    page.keyboard.press("Escape")
    row(page, "报告.txt").locator("a").click(); page.wait_for_timeout(500)
    shot(page, "20-dark-dock")
    page.keyboard.press("Escape")
    page.locator("header").get_by_role("radio", name="浅色").click()
    br.close()

def mobile(pw):
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, color_scheme="light")
    page = ctx.new_page()
    page.on("console", lambda m: m.type == "error" and errors.append(f"[mobile] {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"[mobile] pageerror {e}"))
    login(page)
    page.goto(BASE + "/#/files" + DOC); page.wait_for_timeout(900)
    shot(page, "21-mobile-files")
    row(page, "README.md").locator("label.check").click(force=True); page.wait_for_timeout(500)
    dock = page.get_by_role("toolbar", name="批量操作")
    check("mobile dock inside viewport", dock.count() == 1 and in_view(page, dock))
    shot(page, "22-mobile-dock")
    page.get_by_role("button", name="取消选择").click(); page.wait_for_timeout(300)
    row(page, "README.md").locator("a").click(); page.wait_for_timeout(1200)
    check("mobile opens tab", page.get_by_role("navigation", name="文件路径").count() == 1)
    shot(page, "23-mobile-tab")
    br.close()

with sync_playwright() as pw:
    desktop(pw)
    mobile(pw)
for n in ["撤销测试"]:
    try: api("POST", "/api/fs/delete", {"path": f"{DOC}/{n}"}, tok)
    except Exception: pass
print("console errors:", len(errors))
for e in errors: print("  ", e)
sys.exit(1 if fails or errors else 0)
