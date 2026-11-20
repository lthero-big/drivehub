"""DEPTAI-485 round-8 checks + screenshots.
Usage: BASE=http://192.168.1.61:8493 DH_USER=.. DH_PASS=.. SHOTS=dir python3 smoke_round8.py
"""
import os, time
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8493")
U, P = os.environ["DH_USER"], os.environ["DH_PASS"]
SHOTS = os.environ.get("SHOTS", "/tmp/d485r8-shots")
os.makedirs(SHOTS, exist_ok=True)
errors, fails = [], []

def check(name, cond):
    fails.append(name) if not cond else None
    print(("PASS " if cond else "FAIL ") + name, flush=True)

def shot(page, name, **kw):
    page.screenshot(path=f"{SHOTS}/{name}.png", **kw)

with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 1440, "height": 900}, color_scheme="light")
    page = ctx.new_page()
    page.on("console", lambda m: m.type == "error" and errors.append(f"console {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"pageerror {e}"))

    # --- 1 login loading button ---
    page.goto(BASE + "/")
    page.wait_for_selector("form")
    page.get_by_label("用户名或邮箱").fill(U)
    page.get_by_label("密码").fill(P)
    btn = page.locator("[data-auth-submit]")
    check("1 login button is morph button", btn.count() == 1)
    t0 = time.time()
    btn.click()
    page.wait_for_function("() => document.querySelector('[data-auth-submit]')?.dataset.state === 'run'", timeout=4000)
    run_at = time.time() - t0
    main_during_run = page.locator("#main").count()
    check(f"1 entered run before main ({run_at:.2f}s, main={main_during_run})", main_during_run == 0)
    shot(page, "desktop-01-login-run")
    page.wait_for_function("() => document.querySelector('[data-auth-submit]')?.dataset.state === 'done'", timeout=5000)
    done_at = time.time() - t0
    done_visible = page.locator("[data-auth-submit][data-state=done] .lb-done").count() == 1
    still_form = page.locator("#main").count() == 0
    check(f"1 shows 完成 before navigating ({done_at:.2f}s, done={done_visible}, main_gone={still_form})", done_visible and still_form and done_at >= 0.8)
    shot(page, "desktop-01-login-done")
    page.wait_for_selector("#main", timeout=15000)
    total = time.time() - t0
    check(f"1 reached main after done hold ({total:.2f}s)", total >= 1.5)

    # --- 2 sidebar typography + chevron on the right ---
    page.evaluate("""() => {
      localStorage.setItem('dh_prefs', JSON.stringify({openInPlace:false,favsCollapsed:false,adminCollapsed:false,filesCollapsed:false,favsShowAll:false,hoverPreview:true}));
      localStorage.setItem('dh_sidebar_collapsed', '0');
    }""")
    page.reload()
    page.wait_for_selector("#main")

    def metrics(sel):
        return page.evaluate("""(sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const cs = getComputedStyle(el);
          const title = el.querySelector('span.truncate, a span.truncate');
          const chev = el.querySelector('[data-sec-chevron]');
          const icon = el.querySelector('svg:not([data-sec-chevron])');
          const tr = title ? title.getBoundingClientRect() : null;
          const cr = chev ? chev.getBoundingClientRect() : null;
          const ir = icon ? icon.getBoundingClientRect() : null;
          return {
            fontSize: cs.fontSize,
            fontWeight: cs.fontWeight,
            title: title ? title.textContent.trim() : '',
            titleSize: title ? getComputedStyle(title).fontSize : null,
            chevRight: !!(cr && tr && cr.left >= tr.right - 1),
            iconW: ir ? Math.round(ir.width) : 0,
            chevAt: cr ? Math.round(cr.left) : null,
            titleAt: tr ? Math.round(tr.left) : null,
            titleRight: tr ? Math.round(tr.right) : null,
          };
        }""", sel)

    link = page.evaluate("""() => {
      const el = [...document.querySelectorAll('nav a.nav-item')].find(a => (a.textContent||'').trim() === '任务中心');
      if (!el) return null;
      const cs = getComputedStyle(el);
      const icon = el.querySelector('svg');
      return { fontSize: cs.fontSize, iconW: icon ? Math.round(icon.getBoundingClientRect().width) : 0, text: (el.textContent||'').trim() };
    }""")
    print("NAVLINK", link, flush=True)
    for sec, title in (("files", "全部文件"), ("admin", "管理后台")):
        head = page.locator(f"[data-sec={sec}] .sec-head")
        check(f"2 {title} uses sec-head", head.count() == 1)
        m = metrics(f"[data-sec={sec}] .sec-head")
        print(f"HEAD {sec}", m, flush=True)
        check(f"2 {title} title matches nav item size", bool(m) and link and m["titleSize"] == link["fontSize"] == "14px")
        check(f"2 {title} icon ~18px ({m and m['iconW']})", bool(m) and m["iconW"] >= 17 and m["iconW"] <= 20)
        check(f"2 {title} chevron is on the right", bool(m) and m["chevRight"])
        check(f"2 {title} has trailing chevron", page.locator(f"[data-sec={sec}] [data-sec-chevron]").count() == 1)

    ft = page.locator("[data-files-toggle]")
    check("2 files toggle expanded", ft.get_attribute("aria-expanded") == "true")
    # title click keeps / goes to root; chevron collapses
    page.locator("[data-sec=files] .sec-head a").click()
    page.wait_for_timeout(200)
    check("2 files title still expanded (title is not the toggle)", ft.get_attribute("aria-expanded") == "true")
    ft.click(); page.wait_for_timeout(400)
    check("2 files collapsed via right chevron", ft.get_attribute("aria-expanded") == "false" and page.locator("#nav-files[data-closed]").count() == 1)
    shot(page, "desktop-02-files-collapsed", clip={"x": 0, "y": 0, "width": 320, "height": 900})
    ft.click(); page.wait_for_timeout(300)
    shot(page, "desktop-02-files-expanded", clip={"x": 0, "y": 0, "width": 320, "height": 900})
    adm = page.locator("[data-sec=admin] button[aria-controls=nav-admin]")
    check("2 admin header is toggle", adm.count() == 1)
    adm.click(); page.wait_for_timeout(400)
    check("2 admin collapsed", page.locator("#nav-admin[data-closed]").count() == 1)
    shot(page, "desktop-02-admin-collapsed", clip={"x": 0, "y": 0, "width": 320, "height": 900})
    adm.click(); page.wait_for_timeout(200)
    shot(page, "desktop-02-sidebar", clip={"x": 0, "y": 0, "width": 360, "height": 900})

    # mobile sidebar typography
    page.set_viewport_size({"width": 390, "height": 844})
    page.reload()
    page.wait_for_selector("#main")
    # open drawer if needed
    if page.locator("[data-sec=files] .sec-head").count() == 0:
        page.locator("button[aria-label='打开菜单'], button[aria-label='打开侧栏']").first.click()
        page.wait_for_timeout(400)
    # try common mobile menu button
    if page.locator("[data-sec=files] .sec-head").count() == 0:
        for lab in ("打开菜单", "菜单", "Menu"):
            b = page.get_by_role("button", name=lab)
            if b.count():
                b.first.click()
                page.wait_for_timeout(400)
                break
    if page.locator("[data-sec=files] .sec-head").count():
        m = metrics("[data-sec=files] .sec-head")
        check("2 mobile files chevron on the right", bool(m) and m["chevRight"])
        shot(page, "mobile-02-sidebar")
    else:
        # still take a shot of the top bar
        shot(page, "mobile-02-top")
        check("2 mobile files head visible", False)

    br.close()

print("ERRORS", errors)
print("FAILS", fails)
if errors or fails:
    raise SystemExit(1)
print("ALL OK", flush=True)
