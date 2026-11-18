"""DEPTAI-485 round-3 part A checks + screenshots (Playwright, python).
Usage: BASE=http://localhost:8480 DH_USER=.. DH_PASS=.. SHOTS=dir python3 smoke_round3a.py
Covers: marquee/shift/ctrl selection, internal drag != upload, drag-to-bin delete (+undo), upload placeholders + absorb,
image zoom/pan, audio player, video player, code viewer, admin users/groups/roles/ACL pages."""
import json, os, sys, urllib.request, urllib.parse, urllib.error, time
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:8480")
U, P = os.environ["DH_USER"], os.environ["DH_PASS"]
SHOTS = os.environ.get("SHOTS", "/tmp")
TMP = "/示例/r3-tmp"
errors, fails = [], []

def check(name, cond):
    (fails.append(name) if not cond else None)
    print(("PASS " if cond else "FAIL ") + name, flush=True)

def shot(page, name, **kw):
    page.screenshot(path=f"{SHOTS}/{name}.png", **kw)

def api(tok, method, path, body=None, raw=None, ctype="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + urllib.parse.quote(path, safe="/?=&%:"), data=data, method=method,
                                 headers={"authorization": f"Bearer {tok}", "content-type": ctype})
    try:
        with urllib.request.urlopen(req) as r:
            b = r.read()
            return json.loads(b) if b else {}
    except urllib.error.HTTPError as e:
        return {"_err": e.code, "_body": e.read().decode()[:200]}

def login():
    req = urllib.request.Request(BASE + "/api/auth/login", data=json.dumps({"login": U, "password": P}).encode(), headers={"content-type": "application/json"})
    return json.load(urllib.request.urlopen(req))["access_token"]

def rows(page):
    return page.locator('[role=row][data-sel-path]')

def sel_count(page):
    return page.locator('[role=row][aria-selected=true], [aria-label=文件网格] li[aria-selected=true]').count()

def to_dir(page, path):
    page.goto(BASE + "/#/files"); page.wait_for_timeout(200); page.goto(BASE + "/#/files" + path)

def view(page, name):
    page.get_by_role("radio", name=name).click(); page.wait_for_timeout(400)

with sync_playwright() as pw:
    tok = login()
    for n in ["alpha.txt", "bravo.txt", "charlie.txt", "delta.txt", "echo.txt", "foxtrot.txt"]:
        pass
    api(tok, "POST", "/api/fs/mkdir", {"path": TMP})
    for n in ["alpha.txt", "bravo.txt", "charlie.txt", "delta.txt", "echo.txt", "foxtrot.txt"]:
        api(tok, "PUT", f"/api/fs/upload?path={TMP}/{n}&overwrite=true", raw=f"hello {n}\n".encode(), ctype="application/octet-stream")
    br = pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    ctx = br.new_context(viewport={"width": 1440, "height": 900}, color_scheme="light", permissions=["clipboard-read", "clipboard-write"])
    page = ctx.new_page()
    page.on("console", lambda m: m.type == "error" and errors.append(f"console {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
    uploads_seen = []
    page.on("request", lambda r: r.method == "PUT" and "/api/fs/upload" in r.url and uploads_seen.append(r.url))
    page.goto(BASE + "/")
    page.wait_for_selector("form")
    page.get_by_label("用户名或邮箱").fill(U); page.get_by_label("密码").fill(P)
    page.get_by_role("button", name="登录").click()
    page.wait_for_selector("#main", timeout=10000)
    page.evaluate("localStorage.setItem('dh_view', JSON.stringify('list'))")

    # ---------- 1. marquee + shift + ctrl ----------
    page.goto(BASE + f"/#/files{TMP}"); page.reload(); page.wait_for_selector('[role=row][data-sel-path]'); page.wait_for_timeout(500)
    rs = rows(page); n = rs.count()
    check("1 list has >=6 rows", n >= 6)
    b0 = rs.nth(1).bounding_box(); last = rs.nth(n - 1).bounding_box()
    sx, sy = b0["x"] + b0["width"] - 12, last["y"] + last["height"] + 40
    page.mouse.move(sx, sy); page.mouse.down()
    page.mouse.move(sx - 200, sy - 40, steps=4)
    page.mouse.move(b0["x"] + 300, b0["y"] + 4, steps=8)
    page.wait_for_timeout(150)
    check("1 marquee band visible", page.locator('[data-testid=band]').count() == 1)
    shot(page, "01-marquee-dragging")
    got = sel_count(page)
    page.mouse.up()
    check(f"1 marquee selected rows ({got})", got >= 4)
    page.wait_for_timeout(200)
    shot(page, "01-marquee-selected")
    page.mouse.click(sx, sy); page.wait_for_timeout(150)
    check("1 blank click clears", sel_count(page) == 0)
    rs.nth(0).click(position={"x": 200, "y": 10}); rs.nth(3).click(position={"x": 200, "y": 10}, modifiers=["Shift"])
    check("1 shift range = 4", sel_count(page) == 4)
    rs.nth(1).click(position={"x": 200, "y": 10}, modifiers=["Control"])
    check("1 ctrl toggles off one = 3", sel_count(page) == 3)
    rs.nth(5).click(position={"x": 200, "y": 10}, modifiers=["Control"])
    check("1 ctrl adds one = 4", sel_count(page) == 4)
    page.wait_for_timeout(200)
    shot(page, "01-shift-ctrl-selection")
    page.keyboard.press("Escape")
    # grid marquee
    page.goto(BASE + "/#/files/示例/照片"); page.wait_for_selector('[role=row][data-sel-path]')
    view(page, "网格"); page.wait_for_selector('[aria-label=文件网格] li'); page.wait_for_timeout(400)
    li = page.locator('[aria-label=文件网格] li'); lb = li.nth(0).bounding_box(); lb2 = li.nth(3).bounding_box(); l8 = li.nth(7).bounding_box()
    page.mouse.move(l8["x"] + l8["width"] + 150, l8["y"] + 60)
    page.mouse.down(); page.mouse.move(lb2["x"] + lb2["width"] - 20, lb["y"] + 40, steps=10); page.wait_for_timeout(100)
    shot(page, "01-marquee-grid-dragging"); page.mouse.up()
    check(f"1 grid marquee selected ({sel_count(page)})", sel_count(page) >= 3)
    shot(page, "01-marquee-grid-selected")
    page.keyboard.press("Escape")

    # ---------- 8a. internal drag of existing image must NOT upload ----------
    before = len(uploads_seen)
    ib = li.nth(1).bounding_box()
    page.mouse.move(ib["x"] + 40, ib["y"] + 40); page.mouse.down()
    page.mouse.move(ib["x"] + 140, ib["y"] + 120, steps=8); page.wait_for_timeout(250)
    check("8 bin appears on internal drag", page.locator('[data-testid=trash-zone]').count() == 1)
    check("8 no upload overlay on internal drag", page.get_by_text("松开即可上传").count() == 0)
    shot(page, "08-internal-drag-bin")
    page.mouse.move(ib["x"] + 300, ib["y"] + 300, steps=4)
    page.mouse.up(); page.wait_for_timeout(900)
    check("8 internal drop did not upload", len(uploads_seen) == before)
    check("8 grid still has 8 photos", page.locator('[aria-label=文件网格] li').count() == 8)

    # ---------- 8b. drag to bin deletes (+undo) ----------
    page.goto(BASE + f"/#/files{TMP}"); page.wait_for_selector('[aria-label=文件网格] li'); view(page, "列表"); page.wait_for_selector('[role=row][data-sel-path]'); page.wait_for_timeout(500)
    r2 = rows(page).nth(2); rb = r2.bounding_box(); cnt = rows(page).count()
    page.mouse.move(rb["x"] + 200, rb["y"] + 12); page.mouse.down(); page.mouse.move(rb["x"] + 260, rb["y"] + 60, steps=6); page.wait_for_timeout(200)
    tz = page.locator('[data-testid=trash-zone]'); tb = tz.bounding_box()
    page.mouse.move(tb["x"] + tb["width"] / 2 + 60, tb["y"] - 40, steps=6)
    page.mouse.move(tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2, steps=8); page.wait_for_timeout(250)
    check("8 bin turns hot when hovered", tz.get_attribute("data-hot") is not None)
    shot(page, "08-drag-to-bin-hot")
    page.mouse.up(); page.wait_for_timeout(600)
    check("8 row removed after drop on bin", rows(page).count() == cnt - 1)
    check("8 undo toast shown", page.get_by_text("已删除").count() > 0)
    shot(page, "08-drag-to-bin-deleted")
    undo = page.get_by_role("button", name="撤销")
    if undo.count(): undo.first.click(); page.wait_for_timeout(600)
    check("8 undo restores row", rows(page).count() == cnt)

    # ---------- 8c. upload placeholders + absorb ----------
    cdp = ctx.new_cdp_session(page)
    cdp.send("Network.enable"); cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 50, "downloadThroughput": -1, "uploadThroughput": 120000})
    page.evaluate("""() => {
      const dt = new DataTransfer();
      for (const n of ['up-one.png','up-two.txt']) dt.items.add(new File([new Uint8Array(500000)], n, {type: n.endsWith('png') ? 'image/png' : 'text/plain'}));
      const t = document.querySelector('[data-testid=file-area]');
      t.dispatchEvent(new DragEvent('dragover', {dataTransfer: dt, bubbles: true, cancelable: true, clientX: 700, clientY: 500}));
      t.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true, clientX: 700, clientY: 500}));
    }""")
    page.wait_for_selector('[data-up-placeholder]', timeout=5000)
    page.wait_for_timeout(120)
    shot(page, "08-upload-absorb-flying")
    page.wait_for_timeout(900)
    check("8 placeholder rows shown", page.locator('[data-up-placeholder]').count() == 2)
    check("8 placeholder has progress", page.locator('[data-up-placeholder] [role=progressbar]').count() >= 1)
    shot(page, "08-upload-placeholder-list")
    view(page, "网格"); shot(page, "08-upload-placeholder-grid"); view(page, "列表")
    page.wait_for_function("[...document.querySelectorAll('[role=row][data-sel-path]')].some(e => e.dataset.selPath.endsWith('up-two.txt'))", timeout=20000)
    check("8 real file replaces placeholder", rows(page).filter(has_text="up-two.txt").count() == 1)
    page.wait_for_timeout(500)
    shot(page, "08-upload-replaced")
    cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})

    # ---------- 2. image zoom ----------
    page.goto(BASE + "/#/files/示例/照片"); page.wait_for_selector('[role=row][data-sel-path]'); page.wait_for_timeout(400)
    page.locator('[data-sel-path$="photo_1.jpg"]').first.dblclick(); page.wait_for_selector('[data-top-card]'); page.wait_for_timeout(800)
    zl = lambda: page.locator('[data-testid=zoom-level]').inner_text()
    check("2 zoom starts 100%", zl() == "100%")
    shot(page, "02-image-viewer-100")
    zin = page.get_by_role("button", name="放大", exact=True)
    zin.click(); zin.click(); page.wait_for_timeout(300)
    check(f"2 zoom buttons ({zl()})", zl() == "156%")
    tc = page.locator('[data-top-card]').bounding_box()
    page.mouse.move(tc["x"] + tc["width"] / 2, tc["y"] + tc["height"] / 2)
    page.mouse.wheel(0, -400); page.wait_for_timeout(300)
    z2 = int(zl().rstrip("%")); check(f"2 wheel zooms in ({z2}%)", z2 > 156)
    t1 = page.locator('[data-top-card] img').evaluate("e => e.style.transform")
    page.mouse.down(); page.mouse.move(tc["x"] + tc["width"] / 2 + 90, tc["y"] + tc["height"] / 2 + 50, steps=6); page.mouse.up(); page.wait_for_timeout(300)
    t2 = page.locator('[data-top-card] img').evaluate("e => e.style.transform")
    check("2 drag pans when zoomed", t1 != t2)
    shot(page, "02-image-zoomed-panned")
    page.get_by_role("button", name="重置缩放").click(); page.wait_for_timeout(300)
    check("2 reset -> 100%", zl() == "100%")
    page.locator('[data-top-card]').dblclick(position={"x": 200, "y": 150}); page.wait_for_timeout(400)
    check(f"2 dblclick zooms ({zl()})", zl() == "250%")
    shot(page, "02-image-dblclick-zoom")
    page.keyboard.press("0"); page.wait_for_timeout(200)

    # ---------- 2. audio ----------
    to_dir(page, "/示例/媒体"); page.wait_for_selector('[role=row][data-sel-path]'); page.wait_for_timeout(400)
    page.locator('[data-sel-path$="a3-带封面.mp3"]').first.dblclick(); page.wait_for_selector('[data-testid=audio-player]'); page.wait_for_timeout(1800)
    check("2 audio cover from ID3", page.locator('[data-testid=audio-cover]').count() == 1)
    check("2 audio title from ID3", "封面测试曲" in page.locator('[data-testid=audio-title]').inner_text())
    check("2 audio waveform + playlist", page.locator('[data-testid=waveform]').count() == 1 and page.locator('[data-testid=playlist] li').count() >= 3)
    shot(page, "02-audio-player-cover")
    page.locator('[data-testid=playlist] li').first.click(); page.wait_for_timeout(1500)
    shot(page, "02-audio-player-generated-cover")
    page.get_by_role("button", name="倍速").click(); page.wait_for_timeout(250)
    shot(page, "02-audio-speed-menu")
    page.get_by_role("button", name="1.5×").click()
    check("2 audio speed 1.5x", page.evaluate("document.querySelector('audio').playbackRate") == 1.5)

    # ---------- 3. video ----------
    page.reload(); page.wait_for_timeout(500)
    to_dir(page, "/示例/媒体"); page.wait_for_selector('[role=row][data-sel-path]'); page.wait_for_timeout(400)
    page.locator('[data-sel-path$="demo30.webm"]').first.dblclick(); page.wait_for_selector('[data-testid=video-player] video'); page.wait_for_timeout(2500)
    page.locator('[data-testid=video-player] .mp').hover(); page.wait_for_timeout(300)
    shot(page, "03-video-player")
    check("3 video playing", page.evaluate("!document.querySelector('video').paused"))
    page.keyboard.press("l"); page.wait_for_timeout(300)
    check("3 key L seeks +10s", page.evaluate("document.querySelector('video').currentTime") > 10)
    page.keyboard.press(">"); page.wait_for_timeout(200)
    check("3 key > speeds up", page.evaluate("document.querySelector('video').playbackRate") == 1.25)
    page.keyboard.press("Space"); page.wait_for_timeout(200)
    check("3 space pauses", page.evaluate("document.querySelector('video').paused"))
    sb = page.locator('[data-testid=seekbar]').bounding_box()
    page.mouse.move(sb["x"] + sb["width"] * 0.7, sb["y"] + 8); page.wait_for_timeout(700)
    shot(page, "03-video-seek-preview")
    page.get_by_role("button", name="倍速").click(); page.wait_for_timeout(250)
    shot(page, "03-video-speed-menu"); page.get_by_role("button", name="倍速").click()
    page.get_by_role("button", name="字幕").click(); page.wait_for_timeout(250)
    check("3 sibling subtitle detected", page.get_by_role("menuitemradio").count() >= 2)
    shot(page, "03-video-subtitle-menu"); page.get_by_role("button", name="字幕").click()
    page.keyboard.press("0"); page.keyboard.press("Space"); page.wait_for_timeout(1800)
    shot(page, "03-video-subtitles-showing")
    page.keyboard.press("Space")
    check("3 external player icons", page.locator('[data-testid=external-players] a svg').count() == 6)
    page.locator('[data-testid=external-players]').scroll_into_view_if_needed()
    shot(page, "03-video-external-player-icons")
    page.evaluate("localStorage.setItem('dh_pos:/示例/媒体/demo30.webm','12')")
    page.goto(BASE + "/#/files/示例/文档"); page.wait_for_timeout(300)
    to_dir(page, "/示例/媒体"); page.wait_for_selector('[role=row][data-sel-path]')
    page.locator('[data-sel-path$="demo30.webm"]').first.dblclick(); page.wait_for_selector('[data-testid=video-player] video'); page.wait_for_timeout(1500)
    check("3 resumes saved position", page.evaluate("document.querySelector('video').currentTime") >= 11)
    shot(page, "03-video-resume")

    # ---------- 4. code viewer ----------
    for f, lang, tag in [("transfer_api.rs", "Rust", "rust"), ("uploads.ts", "TypeScript", "ts")]:
        to_dir(page, "/示例/文档/代码"); page.wait_for_selector('[role=row][data-sel-path]'); page.wait_for_timeout(300)
        page.locator(f'[data-sel-path$="{f}"]').first.dblclick(); page.wait_for_selector('[data-code-viewer]'); page.wait_for_timeout(500)
        check(f"4 {f} language auto = {lang}", page.locator('[data-testid=code-lang]').inner_text() == lang)
        check(f"4 {f} syntax highlighted", page.locator('[data-code-viewer] .hljs-keyword').count() > 5)
        shot(page, f"04-code-{tag}")
    page.get_by_role("button", name="换行").click(); page.wait_for_timeout(200)
    shot(page, "04-code-wrap")
    page.get_by_role("button", name="复制").click(); page.wait_for_timeout(300)
    clip = page.evaluate("navigator.clipboard.readText()")
    check("4 copy puts code in clipboard", len(clip) > 1000)
    shot(page, "04-code-copied")

    # ---------- 5/6/7 admin ----------
    page.goto(BASE + "/#/admin/users"); page.wait_for_selector("table"); page.wait_for_timeout(500)
    check("6 users page has no group card", page.get_by_text("新建用户组").count() == 0 and page.get_by_text("新建用户").count() >= 1)
    shot(page, "06-admin-users")
    page.goto(BASE + "/#/admin/groups"); page.wait_for_selector('[data-testid=group-table]'); page.wait_for_timeout(400)
    shot(page, "06-admin-groups")
    page.goto(BASE + "/#/admin/roles"); page.wait_for_selector('[data-testid=role-list]'); page.wait_for_timeout(400)
    check("7 builtin roles listed", page.locator('[data-testid=role-list] li').count() >= 3)
    shot(page, "07-admin-roles")
    page.get_by_role("button", name="新建角色").click(); page.wait_for_selector('[data-testid=perm-matrix]')
    page.locator('[role=dialog] input').first.fill("r3测试角色")
    page.get_by_role("checkbox", name="上传").click(); page.wait_for_timeout(200)
    shot(page, "07-role-editor")
    page.locator('[role=dialog]').get_by_role("button", name="保存").click(); page.wait_for_timeout(800)
    check("7 role created", page.locator('[data-role="r3测试角色"]').count() == 1)
    page.get_by_role("button", name="编辑角色 r3测试角色").click(); page.wait_for_timeout(300)
    page.get_by_role("checkbox", name="删除").click(); page.locator('[role=dialog]').get_by_role("button", name="保存").click(); page.wait_for_timeout(800)
    check("7 role updated (delete perm)", "✓ 删除" in page.locator('[data-role="r3测试角色"]').inner_text())
    page.goto(BASE + "/#/admin/groups"); page.wait_for_selector('[data-testid=group-table]')
    page.get_by_role("button", name="新建用户组").click(); page.wait_for_timeout(300)
    page.locator('[role=dialog] input').first.fill("r3测试组")
    page.locator('[role=dialog] label', has_text="r3测试角色").first.click()
    page.locator('[role=dialog] label', has_text="alice").first.click()
    shot(page, "06-group-editor")
    page.locator('[role=dialog]').get_by_role("button", name="保存").click(); page.wait_for_timeout(900)
    g = [x for x in api(tok, "GET", "/api/admin/groups") if x["name"] == "r3测试组"]
    check("7 group created with member+role", len(g) == 1 and g[0]["members"] == 1 and len(g[0]["roles"]) == 1)
    shot(page, "06-admin-groups-after")
    page.goto(BASE + "/#/admin/users"); page.wait_for_selector("table"); page.wait_for_timeout(300)
    page.get_by_role("button", name="编辑").nth(1).click(); page.wait_for_timeout(500)
    shot(page, "07-user-editor-roles")
    page.keyboard.press("Escape")
    api(tok, "DELETE", f"/api/admin/groups/{g[0]['id']}")
    roles = [r for r in api(tok, "GET", "/api/admin/roles") if r["name"] == "r3测试角色"]
    api(tok, "DELETE", f"/api/admin/roles/{roles[0]['id']}")
    page.goto(BASE + "/#/admin/roles"); page.wait_for_timeout(600)
    check("7 role deleted", page.locator('[data-role="r3测试角色"]').count() == 0)
    page.goto(BASE + "/#/admin/acl?path=/示例/文档"); page.wait_for_selector('[data-testid=acl-crumbs]'); page.wait_for_timeout(500)
    shot(page, "05-acl-empty-dir")
    page.locator('[data-testid=acl-add]').get_by_role("button", name="读写").click(); page.wait_for_timeout(700)
    page.locator('[data-testid=acl-add]').get_by_role("button", name="禁止访问").click(); page.wait_for_timeout(700)
    check("5 rules appear in matrix", page.locator('[data-testid=acl-matrix] tbody tr').count() == 2)
    cell = page.locator('[data-testid=acl-matrix] tbody tr').first.locator('button[data-state]').nth(5)
    s0 = cell.get_attribute("data-state"); cell.click(); page.wait_for_timeout(800)
    s1 = page.locator('[data-testid=acl-matrix] tbody tr').first.locator('button[data-state]').nth(5).get_attribute("data-state")
    check(f"5 matrix cell cycles ({s0}->{s1})", s0 != s1)
    shot(page, "05-acl-matrix")
    page.goto(BASE + "/#/admin/acl?path=/示例/文档/代码"); page.wait_for_timeout(800)
    check("5 inheritance shown", page.locator('[data-testid=acl-inherited]').count() == 1)
    shot(page, "05-acl-inherited")
    for r in api(tok, "GET", "/api/acl/rules"):
        if r["path"] == "/示例/文档": api(tok, "DELETE", f"/api/acl/rules/{r['id']}")

    page.evaluate("localStorage.setItem('dh_theme','dark')"); to_dir(page, "/示例/文档/代码"); page.reload(); page.wait_for_selector('[role=row][data-sel-path]')
    page.locator('[data-sel-path$="uploads.ts"]').first.dblclick(); page.wait_for_selector('[data-code-viewer]'); page.wait_for_timeout(500)
    shot(page, "04-code-dark")
    page.goto(BASE + "/#/admin/roles"); page.wait_for_timeout(600); shot(page, "07-admin-roles-dark")
    page.evaluate("localStorage.setItem('dh_theme','light')")
    br.close()

print("console errors:", len(errors))
for e in errors: print("  ", e)
print("FAILS:", fails)
sys.exit(1 if fails else 0)
