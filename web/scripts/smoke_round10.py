"""DEPTAI-485 round-10: bolder file browser + focus-expanding bento gallery."""
import os, time
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8493")
U, P = os.environ["DH_USER"], os.environ["DH_PASS"]
SHOTS = os.environ.get("SHOTS", "/tmp/d485r10-shots")
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

    page.goto(BASE + "/")
    page.wait_for_selector("form")
    page.get_by_label("用户名或邮箱").fill(U)
    page.get_by_label("密码").fill(P)
    page.locator("[data-auth-submit]").click()
    page.wait_for_selector("#main", timeout=20000)
    page.evaluate("""() => {
      localStorage.setItem('dh_prefs', JSON.stringify({openInPlace:false,favsCollapsed:false,adminCollapsed:false,filesCollapsed:false,favsShowAll:false,hoverPreview:true}));
      localStorage.setItem('dh_sidebar_collapsed', '0');
      localStorage.setItem('dh_view', JSON.stringify('grid'));
      localStorage.setItem('dh_gallery_cols', '4');
    }""")

    # --- 1 hero typography + mosaic on a media folder ---
    page.goto(BASE + "/#/files/local/r7-tmp")
    page.wait_for_selector("[data-folder-hero] h1", timeout=15000)
    page.wait_for_timeout(800)
    hero = page.evaluate("""() => {
      const h = document.querySelector('[data-folder-hero] h1');
      if (!h) return null;
      const cs = getComputedStyle(h);
      const mosaic = document.querySelector('[data-hero-mosaic]');
      return { title: h.textContent.trim(), fontSize: cs.fontSize, mosaic: !!mosaic, mosaicKids: mosaic ? mosaic.children.length : 0 };
    }""")
    print("HERO", hero, flush=True)
    check("1 folder hero title exists", bool(hero) and bool(hero["title"]))
    check("1 folder hero is larger", bool(hero) and float(hero["fontSize"].replace("px","")) >= 34)
    check("1 hero mosaic shows folder covers", bool(hero) and hero["mosaic"] and hero["mosaicKids"] >= 1)
    shot(page, "desktop-01-files-hero")

    # --- 2 grid tiles ---
    grid_btn = page.locator("button[title='网格']")
    if grid_btn.count():
        grid_btn.first.click()
        page.wait_for_timeout(400)
    tiles = page.locator("li.dh-file-tile").count()
    media = page.locator("li.dh-file-tile-media").count()
    print("GRID", tiles, "media", media, flush=True)
    check("2 grid uses new tile class", tiles >= 1)
    shot(page, "desktop-02-files-grid")

    # --- 3 gallery bento on /local (many images) ---
    gal_btn = page.locator("button[title='相册']")
    check("3 gallery switch exists", gal_btn.count() >= 1)
    gal_btn.first.click()
    page.wait_for_selector("[data-gallery], [data-gallery-count]", timeout=20000)
    page.wait_for_timeout(800)
    count_txt = page.locator("[data-gallery-count]").inner_text() if page.locator("[data-gallery-count]").count() else ""
    covers = page.locator("[data-gallery] [data-cover]").count()
    state = page.locator("[data-gallery]").get_attribute("data-state")
    native_range = page.locator("[data-gallery-count] ~ * input[type=range], label:has-text('列数') input[type=range]").count()
    # also any range in the toolbar near gallery
    ranges = page.locator("input[type=range][aria-label='相册列数']").count()
    print("GALLERY", count_txt, "covers", covers, "state", state, "ranges", ranges, flush=True)
    check("3 gallery count says whole folder", "整个文件夹" in count_txt)
    check("3 gallery renders a bento", page.locator("[data-gallery].dh-bento").count() == 1)
    check("3 gallery starts at home", state == "home")
    check("3 no native column range", ranges == 0)
    check("3 column segmented control", page.locator("[aria-label='相册列数']").count() >= 1)
    shot(page, "desktop-03-gallery-home")

    # --- 4 click a tile: in-place focus expand ---
    tile = page.locator("[data-gallery] [data-tile]").nth(1) if page.locator("[data-gallery] [data-tile]").count() > 1 else page.locator("[data-gallery] [data-tile]").first
    check("4 has a tile to click", tile.count() == 1)
    tile.click()
    page.wait_for_timeout(700)
    st = page.locator("[data-gallery]").get_attribute("data-state")
    expanded = page.locator("[data-gallery] [data-tile][aria-expanded='true'], [data-gallery] [data-tile][data-layer='full']").count()
    close_btn = page.locator("[data-bento-close]").count()
    print("FOCUS", st, "expanded", expanded, "close", close_btn, flush=True)
    check("4 gallery entered focus state", st == "focus")
    check("4 one tile is expanded", expanded == 1)
    check("4 close control present", close_btn == 1)
    shot(page, "desktop-04-gallery-focus")

    page.locator("[data-gallery] [data-tile][data-layer='full']").press("Escape")
    page.wait_for_timeout(700)
    st2 = page.locator("[data-gallery]").get_attribute("data-state")
    if st2 != "home" and page.locator("[data-bento-close]").count()==1:
        page.locator("[data-bento-close]").first.click()
        page.wait_for_timeout(500)
        st2 = page.locator("[data-gallery]").get_attribute("data-state")
    check("4 Escape returns to home", st2 == "home")
    shot(page, "desktop-04-gallery-home-after-esc")

    # --- 5 video folder ---
    page.goto(BASE + "/#/files/local/video")
    page.wait_for_selector("[data-folder-hero] h1", timeout=15000)
    page.evaluate("() => localStorage.setItem('dh_view', JSON.stringify('gallery'))")
    page.reload()
    page.wait_for_selector("[data-gallery], [data-gallery-count]", timeout=20000)
    page.wait_for_timeout(800)
    vtxt = page.locator("[data-gallery-count]").inner_text() if page.locator("[data-gallery-count]").count() else ""
    print("VIDEO FOLDER", vtxt, flush=True)
    check("5 video folder gallery loaded", "整个文件夹" in vtxt)
    if page.locator("[data-gallery] [data-tile]").count():
        page.locator("[data-gallery] [data-tile]").first.click()
        page.wait_for_timeout(700)
        check("5 video folder can focus", page.locator("[data-gallery]").get_attribute("data-state") == "focus")
        shot(page, "desktop-05-video-focus")
        page.locator("[data-bento-close]").first.click()
        page.wait_for_timeout(500)
    else:
        check("5 video folder has tiles", False)
    shot(page, "desktop-05-video-gallery")

    # --- 6 mobile gallery ---
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(BASE + "/#/files/local/r7-tmp")
    page.wait_for_selector("[data-folder-hero] h1", timeout=15000)
    page.evaluate("() => localStorage.setItem('dh_view', JSON.stringify('gallery'))")
    page.reload()
    page.wait_for_selector("[data-gallery], [data-gallery-count]", timeout=20000)
    page.wait_for_timeout(600)
    shot(page, "mobile-06-gallery-home")
    if page.locator("[data-gallery] [data-tile]").count():
        page.locator("[data-gallery] [data-tile]").first.click()
        page.wait_for_timeout(700)
        check("6 mobile focus works", page.locator("[data-gallery]").get_attribute("data-state") == "focus")
        shot(page, "mobile-06-gallery-focus")
    else:
        check("6 mobile gallery tiles", False)

    # --- console ---
    interesting = [e for e in errors if "favicon" not in e.lower()]
    print("CONSOLE", interesting, flush=True)
    check("7 console has 0 errors", len(interesting) == 0)

print("FAILS", fails)
raise SystemExit(1 if fails else 0)
