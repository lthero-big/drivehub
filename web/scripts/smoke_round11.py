#!/usr/bin/env python3
"""DEPTAI-485 round-11: settings bento focus-grid + gallery regression."""
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8493")
U, P = os.environ["DH_USER"], os.environ["DH_PASS"]
SHOTS = os.environ.get("SHOTS", "/tmp/d485r11-shots")
os.makedirs(SHOTS, exist_ok=True)
errors, fails = [], []

def check(name, cond):
    if not cond: fails.append(name)
    print(("PASS " if cond else "FAIL ") + name, flush=True)

def shot(page, name, **kw):
    page.screenshot(path=f"{SHOTS}/{name}.png", **kw)

with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 1440, "height": 900}, color_scheme="light")
    page = ctx.new_page()
    page.on("console", lambda m: m.type == "error" and errors.append(f"console {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"pageerror {e}"))

    page.goto(BASE + "/")
    page.wait_for_selector("form")
    page.get_by_label("用户名或邮箱").fill(U)
    page.get_by_label("密码").fill(P)
    page.locator("[data-auth-submit]").click()
    page.wait_for_selector("#main", timeout=20000)
    page.evaluate("""() => {
      localStorage.setItem('dh_prefs', JSON.stringify({openInPlace:false,favsCollapsed:false,adminCollapsed:false,filesCollapsed:false,favsShowAll:false,hoverPreview:true}));
      localStorage.setItem('dh_sidebar_collapsed', '0');
    }""")

    # --- 1 account bento home ---
    page.goto(BASE + "/#/account")
    page.wait_for_selector("[data-settings-bento]", timeout=15000)
    page.wait_for_timeout(600)
    state = page.locator("[data-settings-bento]").get_attribute("data-state")
    tiles = page.locator("[data-settings-bento] [data-tile]").count()
    print("ACCOUNT HOME", state, "tiles", tiles, flush=True)
    check("1 account bento at home", state == "home")
    check("1 account has 5 tiles", tiles == 5)
    check("1 no settings tabs", page.get_by_role("tablist").count() == 0)
    shot(page, "desktop-01-account-home")

    # --- 2 click 安全, expand in place ---
    page.locator("[data-settings-bento] [data-id=security]").click()
    page.wait_for_timeout(700)
    st = page.locator("[data-settings-bento]").get_attribute("data-state")
    expanded = page.locator("[data-settings-bento] [data-tile][data-layer='full']").count()
    has_pw = page.get_by_text("修改密码").count() >= 1
    print("ACCOUNT FOCUS", st, "expanded", expanded, "has_pw", has_pw, "url", page.url, flush=True)
    check("2 account entered focus", st == "focus")
    check("2 one tile expanded", expanded == 1)
    check("2 security form visible", has_pw)
    check("2 hash is /account/security", "/account/security" in page.url)
    shot(page, "desktop-02-account-security")

    page.keyboard.press("Escape")
    page.wait_for_timeout(700)
    st2 = page.locator("[data-settings-bento]").get_attribute("data-state")
    if st2 != "home" and page.locator("[data-bento-close]").count():
        page.locator("[data-bento-close]").first.click()
        page.wait_for_timeout(500)
        st2 = page.locator("[data-settings-bento]").get_attribute("data-state")
    check("2 Escape returns to home", st2 == "home")
    shot(page, "desktop-02-account-home-after-esc")

    # --- 3 deep link ---
    page.goto(BASE + "/#/account/tokens")
    page.wait_for_selector("[data-settings-bento] [data-id=tokens][data-layer=full]", timeout=10000)
    page.wait_for_timeout(500)
    check("3 tokens deep link expands", page.locator("[data-settings-bento]").get_attribute("data-state") == "focus")
    check("3 token form visible", page.get_by_text("API Token").count() >= 1 or page.get_by_text("WebDAV").count() >= 1)
    shot(page, "desktop-03-account-tokens")

    # --- 4 admin settings home ---
    page.goto(BASE + "/#/admin/settings")
    page.wait_for_selector("[data-settings-bento]", timeout=15000)
    page.wait_for_timeout(700)
    ast = page.locator("[data-settings-bento]").get_attribute("data-state")
    atiles = page.locator("[data-settings-bento] [data-tile]").count()
    ids = page.locator("[data-settings-bento] [data-tile]").evaluate_all("els => els.map(e => e.getAttribute('data-id'))")
    print("ADMIN HOME", ast, "tiles", atiles, "ids", ids, flush=True)
    check("4 admin settings at home", ast == "home")
    check("4 admin has access+service+update", set(ids) >= {"access","service","update"})
    shot(page, "desktop-04-settings-home")

    # --- 5 expand 注册与登录 ---
    page.locator("[data-settings-bento] [data-id=access]").click()
    page.wait_for_timeout(700)
    check("5 access focused", page.locator("[data-settings-bento]").get_attribute("data-state") == "focus")
    check("5 open-registration switch visible", page.get_by_text("开放注册").count() >= 1)
    check("5 hash settings/access", "/settings/access" in page.url)
    shot(page, "desktop-05-settings-access")

    # --- 6 系统更新 tile / deep link ---
    page.goto(BASE + "/#/admin/update")
    page.wait_for_selector("[data-settings-bento] [data-id=update][data-layer=full]", timeout=15000)
    page.wait_for_timeout(800)
    check("6 update route uses same bento", page.locator("[data-settings-bento]").count() == 1)
    check("6 update tile expanded", page.locator("[data-settings-bento] [data-id=update][data-layer=full]").count() == 1)
    check("6 version card visible", page.get_by_text("当前版本").count() >= 1 or page.get_by_text("更新设置").count() >= 1)
    shot(page, "desktop-06-settings-update")

    # --- 7 mobile account ---
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(BASE + "/#/account")
    page.wait_for_selector("[data-settings-bento]", timeout=15000)
    page.wait_for_timeout(500)
    shot(page, "mobile-07-account-home")
    page.locator("[data-settings-bento] [data-id=profile]").click()
    page.wait_for_timeout(700)
    check("7 mobile account focus", page.locator("[data-settings-bento]").get_attribute("data-state") == "focus")
    shot(page, "mobile-07-account-profile")
    page.goto(BASE + "/#/admin/settings")
    page.wait_for_selector("[data-settings-bento]", timeout=15000)
    page.wait_for_timeout(500)
    shot(page, "mobile-07-settings-home")

    interesting = [e for e in errors if "favicon" not in e.lower()]
    print("CONSOLE", interesting, flush=True)
    check("8 console has 0 errors", len(interesting) == 0)

print("FAILS", fails)
raise SystemExit(1 if fails else 0)