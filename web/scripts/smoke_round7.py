"""DEPTAI-485 round-7 checks + screenshots.
Usage: BASE=http://192.168.1.61:8492 DH_USER=.. DH_PASS=.. SHOTS=dir python3 smoke_round7.py
"""
import io, json, os, struct, time, urllib.request, urllib.parse, urllib.error, zlib
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8492")
U, P = os.environ["DH_USER"], os.environ["DH_PASS"]
SHOTS = os.environ.get("SHOTS", "/tmp/d485r7-shots")
os.makedirs(SHOTS, exist_ok=True)
TMP = "/示例/r7-tmp"
errors, fails = [], []

def check(name, cond):
    fails.append(name) if not cond else None
    print(("PASS " if cond else "FAIL ") + name, flush=True)

def shot(page, name, **kw):
    page.screenshot(path=f"{SHOTS}/{name}.png", **kw)

def api(tok, method, path, body=None, raw=None, ctype="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(
        BASE + urllib.parse.quote(path, safe="/?=&%:"),
        data=data, method=method,
        headers={"content-type": ctype, "authorization": f"Bearer {tok}"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            b = r.read()
            return json.loads(b) if b else {}
    except urllib.error.HTTPError as e:
        return {"_err": e.code, "_body": e.read().decode("utf-8", "replace")}

def png(w=8, h=8, rgb=(40, 120, 200)):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")

def login_api():
    req = urllib.request.Request(
        BASE + "/api/auth/login",
        data=json.dumps({"login": U, "password": P}).encode(),
        method="POST",
        headers={"content-type": "application/json"},
    )
    return json.load(urllib.request.urlopen(req))["access_token"]

with sync_playwright() as pw:
    tok = login_api()
    # pick a writable mount
    root = api(tok, "GET", "/api/fs/list?path=/&per_page=100")
    mounts = [i["path"] for i in root.get("items") or [] if i.get("is_dir")]
    base = None
    for m in mounts:
        r = api(tok, "POST", "/api/fs/mkdir", {"path": f"{m}/r7-tmp"})
        if "_err" not in r:
            base = f"{m}/r7-tmp"
            break
    if not base:
        raise SystemExit(f"no writable mount: {root}")
    print("TMP", base, flush=True)
    # 70 tiny images + names that sort together so page-1 of 60 would drop some
    blob = png()
    for i in range(70):
        r = api(tok, "PUT", f"/api/fs/upload?path={base}/img{i:03d}.png&overwrite=true", raw=blob, ctype="application/octet-stream")
        if r.get("_err"):
            raise SystemExit(f"upload failed {i}: {r}")
    # a few non-images so list page is mixed
    for n in ["note-a.txt", "note-b.txt", "note-c.txt"]:
        api(tok, "PUT", f"/api/fs/upload?path={base}/{n}&overwrite=true", raw=b"x\n", ctype="application/octet-stream")

    br = pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    ctx = br.new_context(viewport={"width": 1440, "height": 900}, color_scheme="light")
    page = ctx.new_page()
    page.on("console", lambda m: m.type == "error" and errors.append(f"console {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
    page.goto(BASE + "/")
    page.wait_for_selector("form")
    page.get_by_label("用户名或邮箱").fill(U)
    page.get_by_label("密码").fill(P)
    page.get_by_role("button", name="登录").click()
    page.wait_for_selector("#main", timeout=15000)
    page.evaluate("""() => {
      localStorage.setItem('dh_tabs', JSON.stringify({tabs: [], active: null}));
      localStorage.setItem('dh_pagesize_files', '60');
      localStorage.setItem('dh_view', JSON.stringify('list'));
      localStorage.setItem('dh_prefs', JSON.stringify({openInPlace:false,favsCollapsed:false,adminCollapsed:false,filesCollapsed:false,favsShowAll:false,hoverPreview:true}));
    }""")
    page.reload()
    page.wait_for_selector("#main")

    # --- 1 unified collapse ---
    for sec, title in (("files", "全部文件"), ("admin", "管理后台")):
        head = page.locator(f"[data-sec={sec}] .sec-head")
        check(f"1 {title} uses sec-head", head.count() == 1)
        chev = head.locator("svg").first
        check(f"1 {title} has leading chevron", chev.count() == 1)
    ft = page.locator("[data-files-toggle]")
    check("1 files toggle expanded", ft.get_attribute("aria-expanded") == "true")
    ft.click(); page.wait_for_timeout(400)
    check("1 files collapsed", ft.get_attribute("aria-expanded") == "false" and page.locator("#nav-files[data-closed]").count() == 1)
    shot(page, "desktop-01-files-collapsed", clip={"x": 0, "y": 0, "width": 320, "height": 900})
    ft.click(); page.wait_for_timeout(300)
    adm = page.locator("[data-sec=admin] button[aria-controls=nav-admin]")
    check("1 admin header is toggle", adm.count() == 1)
    adm.click(); page.wait_for_timeout(400)
    check("1 admin collapsed", page.locator("#nav-admin[data-closed]").count() == 1)
    shot(page, "desktop-01-admin-collapsed", clip={"x": 0, "y": 0, "width": 320, "height": 900})
    adm.click(); page.wait_for_timeout(200)
    # all three (if favs exist) share the same head class
    heads = page.locator("nav .sec-head").count()
    check(f"1 at least files+admin section heads ({heads})", heads >= 2)

    def open_gallery(path):
        page.goto(BASE + "/#/files" + path)
        page.wait_for_timeout(500)
        if page.locator("[role=tab]").count():
            page.locator("[role=tab]").first.click()
            page.wait_for_timeout(300)
        radio = page.get_by_role("radio", name="相册")
        radio.click()
        page.wait_for_selector("[data-gallery], [data-gallery-count]", timeout=15000)

    # --- 4 gallery shows all images in the folder (not just current list page) ---
    open_gallery(base)
    # wait for folder-wide load
    for _ in range(20):
        txt = page.locator("[data-gallery-count]").inner_text() if page.locator("[data-gallery-count]").count() else ""
        if "70 张图片" in txt:
            break
        page.wait_for_timeout(300)
    txt = page.locator("[data-gallery-count]").inner_text()
    n = page.locator("[data-gallery] [data-cover]").count()
    check(f"4 gallery count is whole folder >=70 ({txt})", "整个文件夹" in txt and n >= 70 and f"{n} 张图片" in txt)
    check(f"4 gallery renders all covers ({n})", n >= 70)
    check("4 no file-list pager in gallery", page.locator("[data-pager]").count() == 0)
    shot(page, "desktop-04-gallery-all")

    # real user folder: 7 images + 1 video should all appear
    open_gallery("/local/video")
    page.wait_for_timeout(800)
    vtxt = page.locator("[data-gallery-count]").inner_text() if page.locator("[data-gallery-count]").count() else ""
    vn = page.locator("[data-gallery] [data-cover]").count()
    check(f"4 video folder shows images+video ({vtxt}, covers={vn})", "7 张图片" in vtxt and "1 个视频" in vtxt and vn == 8)
    shot(page, "desktop-04-video-folder-gallery")

    # --- 2 grid video/image covers + blur tag ---
    page.evaluate("() => localStorage.setItem('dh_view', JSON.stringify('grid'))")
    page.reload()
    page.wait_for_selector("#main")
    page.goto(BASE + "/#/files" + base)
    page.wait_for_timeout(600)
    if page.locator("[role=tab]").count():
        page.locator("[role=tab]").first.click()
        page.wait_for_timeout(300)
    covers = page.locator("[data-cover=image]").count()
    check(f"2 grid shows image covers ({covers})", covers >= 1)
    shot(page, "desktop-02-grid-covers")
    # tag first visible image with blur via context or API then reload
    first = f"{base}/img000.png"
    tags = api(tok, "GET", "/api/tags") or []
    blur = next((t for t in tags if t.get("name") in ("模糊", "blur", "nsfw", "spoiler", "遮挡")), None)
    if not blur:
        blur = api(tok, "POST", "/api/tags", {"name": "模糊", "color": "gray"})
    api(tok, "POST", "/api/tags/assign", {"paths": [first], "add": [blur["id"]]})
    page.reload(); page.wait_for_selector("#main"); page.wait_for_timeout(800)
    blurred = page.locator("[data-cover=image][data-blur]").count()
    check(f"2 blur tag marks cover ({blurred})", blurred >= 1)
    shot(page, "desktop-02-blur-cover")

    # --- 3 upload complete auto-dismiss ---
    page.evaluate("() => localStorage.setItem('dh_view', JSON.stringify('list'))")
    page.goto(BASE + "/#/files" + base)
    page.wait_for_timeout(400)
    if page.locator("[role=tab]").count():
        page.locator("[role=tab]").first.click()
        page.wait_for_timeout(200)
    # upload two tiny files through the UI input
    inp = page.locator('input[type=file][multiple], input[type=file]').first
    # create temp files
    import tempfile, pathlib
    td = pathlib.Path(tempfile.mkdtemp())
    f1, f2 = td / "u1.png", td / "u2.png"
    f1.write_bytes(png(rgb=(200, 40, 40))); f2.write_bytes(png(rgb=(40, 200, 40)))
    inp.set_input_files([str(f1), str(f2)])
    page.wait_for_selector('section[aria-label="上传队列"]', timeout=10000)
    shot(page, "desktop-03-upload-queue")
    # wait until header says 上传完成
    q = page.locator('section[aria-label="上传队列"]')
    ok_done = False
    for _ in range(30):
        if q.count() and "上传完成" in q.inner_text():
            ok_done = True
            break
        page.wait_for_timeout(200)
    check("3 queue reaches 上传完成", ok_done)
    shot(page, "desktop-03-upload-done")
    # items have ttl bar
    ttl = q.locator(".up-ttl").count() if q.count() else 0
    check(f"3 each done item has ttl bar ({ttl})", ttl >= 1)
    # each should vanish after ~5s, panel too
    page.wait_for_timeout(6200)
    gone = page.locator('section[aria-label="上传队列"]').count() == 0 or page.locator("section.up-panel[data-leaving]").count() == 1
    # give leave animation a moment
    page.wait_for_timeout(500)
    gone = page.locator('section[aria-label="上传队列"]').count() == 0
    check("3 completed queue dismisses after 5s", gone)
    shot(page, "desktop-03-upload-gone")

    # mobile shot of gallery
    page.set_viewport_size({"width": 390, "height": 844})
    page.evaluate("() => localStorage.setItem('dh_view', JSON.stringify('gallery'))")
    page.goto(BASE + "/#/files" + base)
    page.wait_for_timeout(800)
    page.get_by_role("button", name="打开菜单").click()
    page.wait_for_timeout(400)
    shot(page, "mobile-01-sidebar")
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    shot(page, "mobile-04-gallery")

    print("FAILS", fails)
    print("ERRORS", errors[:20], "n=", len(errors))
    br.close()

if fails:
    raise SystemExit(1)
