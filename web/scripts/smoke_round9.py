"""DEPTAI-485 round-9 checks + screenshots.
Usage: BASE=http://192.168.1.61:8493 DH_USER=.. DH_PASS=.. SHOTS=dir python3 smoke_round8.py
"""
import os, time
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8493")
U, P = os.environ["DH_USER"], os.environ["DH_PASS"]
SHOTS = os.environ.get("SHOTS", "/tmp/d485r9-shots")
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

    
    # --- 3 login button stays centered while shrinking ---
    page.context.clear_cookies() if False else None
    # already logged in; do logout then re-login for center check
    # Center was captured conceptually: after going back to login is heavy.
    # We already have desktop-01-login-run from check 1; compute from a fresh login in a new context.

    ctx2 = br.new_context(viewport={"width": 1440, "height": 900}, color_scheme="light")
    p2 = ctx2.new_page()
    p2.goto(BASE + "/")
    p2.wait_for_selector("form")
    p2.get_by_label("用户名或邮箱").fill(U)
    p2.get_by_label("密码").fill(P)
    p2.locator("[data-auth-submit]").click()
    p2.wait_for_function("() => document.querySelector('[data-auth-submit]')?.dataset.state === 'run'", timeout=4000)
    box = p2.evaluate("""() => {
      const btn = document.querySelector('[data-auth-submit]');
      const form = btn && btn.closest('form');
      if (!btn || !form) return null;
      const br = btn.getBoundingClientRect();
      const fr = form.getBoundingClientRect();
      return {
        btnMid: br.left + br.width/2,
        formMid: fr.left + fr.width/2,
        btnW: br.width,
        formW: fr.width,
        dx: (br.left + br.width/2) - (fr.left + fr.width/2)
      };
    }""")
    print("LOGIN_CENTER", box, flush=True)
    check("3 login button centered in run state", bool(box) and abs(box["dx"]) <= 16 and box["btnW"] < box["formW"] * 0.6)
    shot(p2, "desktop-03-login-run-centered")
    ctx2.close()

    # --- 4 sidebar titles left-aligned + consistent hover class ---
    def align(sel):
        return page.evaluate("""(sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const title = el.querySelector('span.truncate, a span.truncate');
          const chev = el.querySelector('[data-sec-chevron]');
          const icon = el.querySelector('svg:not([data-sec-chevron])');
          if (!title || !chev || !icon) return { missing: true };
          const tr = title.getBoundingClientRect();
          const cr = chev.getBoundingClientRect();
          const ir = icon.getBoundingClientRect();
          const cs = getComputedStyle(title);
          const range = document.createRange();
          range.selectNodeContents(title);
          const tx = range.getBoundingClientRect();
          const mid = (ir.right + cr.left) / 2;
          const gap = tx.left - ir.right;
          const textCenter = (tx.left + tx.right) / 2;
          return {
            title: title.textContent.trim(),
            textAlign: cs.textAlign,
            gapIcon: Math.round(gap),
            textLeft: Math.round(tx.left),
            textCenter: Math.round(textCenter),
            mid: Math.round(mid),
            leftAligned: cs.textAlign === "left" && gap >= 4 && gap <= 16 && textCenter < mid - 8,
          };
        }""", sel)

    page.set_viewport_size({"width": 1440, "height": 900})
    page.goto(BASE + "/")
    page.wait_for_selector("#main")
    for sec, title in (("files", "全部文件"), ("favs", "收藏"), ("admin", "管理后台")):
        a = align(f"[data-sec={sec}] .sec-head")
        print(f"ALIGN {sec}", a, flush=True)
        if a is None:
            print(f"SKIP 4 {title} (section not in DOM)", flush=True)
        else:
            check(f"4 {title} title is left-aligned next to icon", bool(a.get("leftAligned")))

    # hover: files and admin heads should both apply hover:bg-hover (computed on hover)
    def hover_bg(sel):
        return page.evaluate("""(sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const idle = getComputedStyle(el).backgroundColor;
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          // force hover via :hover isn't possible; inspect class list instead
          return { idle, cls: el.className };
        }""", sel)
    hf = hover_bg("[data-sec=files] .sec-head")
    ha = hover_bg("[data-sec=admin] .sec-head")
    print("HOVER files", hf, "admin", ha, flush=True)
    check("4 files head has hover:bg-hover", bool(hf) and "hover:bg-hover" in (hf["cls"] or ""))
    check("4 admin head has hover:bg-hover", bool(ha) and "hover:bg-hover" in (ha["cls"] or ""))

    # --- 5 file hero + stage ---
    page.goto(BASE + "/#/files")
    page.wait_for_selector("[data-folder-hero] h1")
    hero = page.evaluate("""() => {
      const h = document.querySelector('[data-folder-hero] h1');
      const stage = document.querySelector('#main') && document.querySelector('#main').parentElement;
      const shell = document.querySelector('body > #root > div, #root > div');
      const hs = h ? getComputedStyle(h) : null;
      const ss = stage ? getComputedStyle(stage) : null;
      return {
        title: h ? h.textContent.trim() : null,
        fontSize: hs ? hs.fontSize : null,
        stageRadius: ss ? ss.borderRadius : null,
        shellBg: shell ? getComputedStyle(shell).backgroundColor : null,
      };
    }""")
    print("HERO", hero, flush=True)
    check("5 folder hero title exists", bool(hero) and hero["title"])
    check("5 folder hero is large", bool(hero) and hero["fontSize"] and float(hero["fontSize"].replace("px","")) >= 28)
    shot(page, "desktop-05-files-hero")
    # grid view
    grid_btn = page.locator("button[title='网格'], [aria-label='视图'] button[title='网格']")
    if grid_btn.count():
        grid_btn.first.click()
        page.wait_for_timeout(400)
        shot(page, "desktop-05-files-grid")
    # settings
    page.goto(BASE + "/#/account")
    page.wait_for_timeout(500)
    if page.locator("h1").count():
        shot(page, "desktop-05-account")
    page.goto(BASE + "/#/admin/settings/access")
    page.wait_for_timeout(600)
    shot(page, "desktop-05-settings")

    br.close()

print("ERRORS", errors)
print("FAILS", fails)
if errors or fails:
    raise SystemExit(1)
print("ALL OK", flush=True)
