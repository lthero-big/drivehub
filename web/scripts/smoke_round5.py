"""DEPTAI-485 round-5 checks + screenshots (Playwright, python).
Usage: BASE=http://localhost:8480 DH_USER=.. DH_PASS=.. SHOTS=dir python3 smoke_round5.py
Covers: A share copy rows / direct link / no overflow / upload only for folders (UI + API);
B audit timeline + categorized permissions (roles, ACL, backend catalog + enforcement);
C open-in-place pref, sidebar/favorites collapse, share on/off switch + full stats page filters, tags + tag filter,
OTP field, image hover reveal, music player, waveform list playback, command palette."""
import json, os, urllib.request, urllib.parse, urllib.error
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:8480")
U, P = os.environ["DH_USER"], os.environ["DH_PASS"]
SHOTS = os.environ.get("SHOTS", "/tmp")
TMP = "/示例/r5-tmp"
errors, fails = [], []

def check(name, cond):
    (fails.append(name) if not cond else None)
    print(("PASS " if cond else "FAIL ") + name, flush=True)

def shot(page, name, **kw):
    page.screenshot(path=f"{SHOTS}/{name}.png", **kw)

def api(tok, method, path, body=None, raw=None, ctype="application/json", auth=True):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    h = {"content-type": ctype}
    if auth: h["authorization"] = f"Bearer {tok}"
    req = urllib.request.Request(BASE + urllib.parse.quote(path, safe="/?=&%:"), data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req) as r:
            b = r.read()
            return json.loads(b) if b else {}
    except urllib.error.HTTPError as e:
        return {"_err": e.code, "_body": e.read().decode()[:200]}

def login():
    req = urllib.request.Request(BASE + "/api/auth/login", data=json.dumps({"login": U, "password": P}).encode(), headers={"content-type": "application/json"})
    return json.load(urllib.request.urlopen(req))["access_token"]

def to_dir(page, path):
    page.goto(BASE + "/#/stats"); page.wait_for_timeout(150); page.goto(BASE + "/#/files" + path); page.wait_for_timeout(300)
    if page.locator("[role=tab]").count(): page.locator("[role=tab]").first.click()
    page.wait_for_selector('[role=row][data-sel-path]'); page.wait_for_timeout(400)

def combo_opts(page, cb):
    cb.click(); page.wait_for_timeout(250)
    o = page.get_by_role("listbox").get_by_role("option").all_inner_texts()
    cb.click(); page.wait_for_timeout(200)
    return o

def combo_pick(page, cb, text):
    cb.click(); page.wait_for_timeout(250)
    page.get_by_role("listbox").get_by_role("option", name=text, exact=True).click(); page.wait_for_timeout(200)

def ctx_menu(page, path, item):
    page.locator(f'[role=row][data-sel-path="{path}"]').first.click(button="right"); page.wait_for_timeout(200)
    page.get_by_role("menuitem", name=item).click(); page.wait_for_timeout(300)

with sync_playwright() as pw:
    tok = login()
    api(tok, "POST", "/api/fs/mkdir", {"path": TMP})
    for n in ["alpha.txt", "bravo.txt", "charlie.txt"]:
        api(tok, "PUT", f"/api/fs/upload?path={TMP}/{n}&overwrite=true", raw=f"hello {n}\n".encode(), ctype="application/octet-stream")
    api(tok, "POST", "/api/fs/mkdir", {"path": f"{TMP}/inbox"})
    # clean old r5 tags / shares from previous runs
    for t in api(tok, "GET", "/api/tags"):
        if str(t.get("name", "")).startswith("r5-"): api(tok, "DELETE", f"/api/tags/{t['id']}")

    # ---------- backend checks (API) ----------
    cat = api(tok, "GET", "/api/acl/catalog")
    names = [p["name"] for p in cat.get("permissions", [])]
    check(f"B2 api catalog has {len(names)} perms in {len(cat.get('categories', []))} categories", len(names) >= 20 and len(cat.get("categories", [])) >= 4)
    bad = api(tok, "POST", "/api/shares", {"paths": [f"{TMP}/alpha.txt"], "perm": "upload"})
    check(f"A3 api rejects upload share of a file ({bad.get('_err')})", bad.get("_err") in (400, 403, 422))
    good = api(tok, "POST", "/api/shares", {"paths": [f"{TMP}/inbox"], "perm": "upload"})
    check("A3 api allows upload share of a folder", "code" in good)
    fsh = api(tok, "POST", "/api/shares", {"paths": [f"{TMP}/alpha.txt"], "perm": "download"})
    bad2 = api(tok, "PATCH", f"/api/shares/{fsh['id']}", {"perm": "upload"})
    check(f"A3 api rejects patching file share to upload ({bad2.get('_err')})", bad2.get("_err") in (400, 403, 422))
    for _ in range(3): api(tok, "GET", f"/api/s/{fsh['code']}", auth=False)
    me = api(tok, "GET", "/api/auth/me")
    check("B2 /me exposes caps", "admin_audit" in me.get("caps", []))

    br = pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    ctx = br.new_context(viewport={"width": 1440, "height": 900}, color_scheme="light", permissions=["clipboard-read", "clipboard-write"])
    page = ctx.new_page()
    page.on("console", lambda m: m.type == "error" and errors.append(f"console {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
    page.goto(BASE + "/")
    page.wait_for_selector("form")
    page.get_by_label("用户名或邮箱").fill(U); page.get_by_label("密码").fill(P)
    page.get_by_role("button", name="登录").click()
    page.wait_for_selector("#main", timeout=10000)
    page.evaluate("""() => { localStorage.setItem('dh_view', JSON.stringify('list'));
      localStorage.setItem('dh_favs', JSON.stringify([{path:'/示例/文档',name:'文档',is_dir:true},{path:'/示例/照片',name:'照片',is_dir:true}]));
      localStorage.setItem('dh_prefs', JSON.stringify({openInPlace:false,favsCollapsed:false,adminCollapsed:false,hoverPreview:true})); }""")
    page.reload(); page.wait_for_selector("#main")

    # ---------- A1/A2/A3 share dialog ----------
    to_dir(page, TMP)
    ctx_menu(page, f"{TMP}/alpha.txt", "分享…")
    dlg = page.get_by_role("dialog")
    opts = combo_opts(page, dlg.get_by_role("combobox").first)
    check(f"A3 upload option hidden for a file ({opts})", len(opts) >= 2 and not any("上传" in o for o in opts))
    check("A3 hint shown for file share", dlg.locator("[data-upload-hint]").count() == 1)
    shot(page, "A3-file-share-no-upload")
    dlg.get_by_role("button", name="创建分享").click(); page.wait_for_selector("[data-copy]", timeout=8000); page.wait_for_timeout(900)
    check("A1 share link copy row", dlg.locator('[data-copy="分享链接"]').count() == 1)
    check("A1 direct link copy row", dlg.locator('[data-copy="直链"]').count() == 1)
    dlg.locator('[data-copy="直链"]').click(); page.wait_for_timeout(300)
    clip = page.evaluate("navigator.clipboard.readText()")
    check(f"A1 one-click copies direct link ({clip[:60]})", "/direct" in clip or "/d/" in clip or clip.startswith("http"))
    direct_val = dlg.get_by_role("textbox", name="直链").input_value()
    check("A1 clipboard == direct link value", clip == direct_val)
    dlg.locator(".shr-label").click(); page.wait_for_timeout(700)
    def overflow(page):
        return page.evaluate("""() => { const s = document.querySelector('.shr'); const d = s.closest('[role=dialog]');
          const a = s.getBoundingClientRect(), b = d.getBoundingClientRect();
          return {s: [a.left, a.right], d: [b.left, b.right], ok: a.left >= b.left - 1 && a.right <= b.right + 1 && a.right <= innerWidth}; }""")
    o = overflow(page)
    check(f"A2 share actions inside dialog at 1440px {o}", o["ok"])
    shot(page, "A2-share-expanded-desktop")
    page.set_viewport_size({"width": 375, "height": 760}); page.wait_for_timeout(600)
    o = overflow(page)
    check(f"A2 share actions inside dialog at 375px {o}", o["ok"])
    shot(page, "A2-share-expanded-375")
    page.set_viewport_size({"width": 1440, "height": 900}); page.wait_for_timeout(300)
    dlg.get_by_role("button", name="完成").click(); page.wait_for_timeout(300)
    ctx_menu(page, f"{TMP}/inbox", "分享…")
    opts = combo_opts(page, page.get_by_role("dialog").get_by_role("combobox").first)
    check(f"A3 upload option shown for a folder ({opts})", any("上传" in o for o in opts))
    shot(page, "A3-folder-share-upload")
    page.get_by_role("dialog").get_by_role("button", name="取消").click(); page.wait_for_timeout(300)

    # ---------- C3 share switch + full stats ----------
    page.goto(BASE + "/#/shares"); page.wait_for_selector("[data-share-row]"); page.wait_for_timeout(500)
    row = page.locator(f'[data-share-row="{fsh["id"]}"]')
    sw = row.get_by_role("switch")
    check("C3 share row has on/off switch (on)", sw.get_attribute("aria-checked") == "true")
    sw.click(); page.wait_for_timeout(700)
    s1 = [s for s in api(tok, "GET", "/api/shares") if s["id"] == fsh["id"]]
    check("C3 switch off -> revoked in backend", bool(s1) and s1[0]["revoked"])
    r = api(tok, "GET", f"/api/s/{fsh['code']}", auth=False)
    check(f"C3 revoked share not accessible ({r.get('_err')})", "_err" in r)
    shot(page, "C3-share-switch-off")
    row.get_by_role("switch").click(); page.wait_for_timeout(700)
    check("C3 switch on again", row.get_by_role("switch").get_attribute("aria-checked") == "true")
    r = api(tok, "GET", f"/api/s/{fsh['code']}", auth=False)
    check("C3 re-enabled share accessible", "_err" not in r)
    page.goto(BASE + f"/#/stats?share_id={fsh['id']}"); page.wait_for_selector("[data-stats-page]"); page.wait_for_timeout(1200)
    check("C3 full stats page", page.locator("[data-stats-page]").count() == 1)
    sel_txt = page.get_by_role("combobox", name="按分享筛选").inner_text()
    check(f"C3 share filter preselected from link ({sel_txt})", sel_txt.strip() not in ("全部分享", "请选择"))
    nrows = page.locator("[data-stats-rows] tbody tr").count()
    check(f"C3 rows for this share ({nrows})", nrows >= 3)
    shot(page, "C3-stats-by-share", full_page=True)
    page.get_by_label("按 IP 筛选").fill("203.0.113.99"); page.wait_for_timeout(1200)
    n2 = page.locator("[data-stats-rows] tbody tr:has(td:nth-child(2))").count()
    check(f"C3 IP filter narrows ({n2})", n2 == 0)
    page.get_by_label("按 IP 筛选").fill(""); combo_pick(page, page.get_by_role("combobox", name="按分享筛选"), "全部分享")
    combo_pick(page, page.get_by_role("combobox", name="时间范围"), "最近 7 天"); page.wait_for_timeout(1200)
    n3 = page.locator("[data-stats-rows] tbody tr").count()
    check(f"C3 all-shares 7d rows ({n3}) >= by-share rows ({nrows})", n3 >= nrows)
    check("C3 by-day chart", page.locator("[data-by-day]").count() >= 1)
    shot(page, "C3-stats-all", full_page=True)

    # ---------- B1 audit timeline ----------
    page.goto(BASE + "/#/admin/audit"); page.wait_for_selector("[data-audit-timeline] .tl-item", timeout=10000); page.wait_for_timeout(800)
    items = page.locator("[data-audit-timeline] .tl-item")
    cnt = items.count()
    qs = lambda: page.evaluate("[...document.querySelectorAll('[data-audit-timeline] .tl-item')].map(e => parseFloat(e.style.getPropertyValue('--q') || '0'))")
    q0 = qs(); lit0 = sum(1 for q in q0 if q > 0.99)
    check(f"B1 timeline items ({cnt}), first screen lit ({lit0}), later ones dark", cnt >= 5 and q0[0] > 0.99 and (cnt < 15 or q0[-1] < 0.01))
    shot(page, "B1-audit-timeline-top")
    page.mouse.move(900, 600)
    for _ in range(4): page.mouse.wheel(0, 500); page.wait_for_timeout(150)
    page.wait_for_timeout(500)
    q1 = qs(); lit1 = sum(1 for q in q1 if q > 0.99)
    check(f"B1 scrolling lights more events ({lit0} -> {lit1})", lit1 > lit0 or cnt < 15)
    mid = page.evaluate("document.querySelector('[data-audit-timeline] .tl').style.getPropertyValue('--tl-len')")
    check(f"B1 line length tracks scroll ({mid})", mid.endswith("px") and float(mid[:-2]) > 0)
    shot(page, "B1-audit-timeline-scrolled")

    # ---------- B2 roles + ACL categories ----------
    page.goto(BASE + "/#/admin/roles"); page.wait_for_selector('[data-testid=role-list]'); page.wait_for_timeout(500)
    page.get_by_role("button", name="新建角色").click(); page.wait_for_timeout(500)
    cats = page.locator("[data-perm-cat]").count()
    perms = page.locator("[data-perm]").count()
    check(f"B2 role editor grouped ({cats} cats, {perms} perms)", cats >= 4 and perms >= 20)
    shot(page, "B2-role-editor-categories")
    page.get_by_role("dialog").get_by_role("button", name="取消").click(); page.wait_for_timeout(300)
    check(f"B2 role cards show per-category counts ({page.locator('[data-role-cat]').count()})", page.locator("[data-role-cat]").count() >= 2)
    page.goto(BASE + "/#/admin/acl"); page.wait_for_selector('[data-testid=acl-matrix]', timeout=10000); page.wait_for_timeout(600)
    check(f"B2 ACL matrix grouped header ({page.locator('[data-acl-cat]').count()})", page.locator("[data-acl-cat]").count() >= 3)
    shot(page, "B2-acl-matrix-categories", full_page=True)

    # ---------- C2 sidebar / favorites collapse ----------
    page.goto(BASE + "/#/files/"); page.wait_for_timeout(600)
    fav_btn = page.locator('[data-sec=favs] button[aria-controls=nav-favs]')
    check("C2 favorites section expanded", fav_btn.get_attribute("aria-expanded") == "true")
    fav_btn.click(); page.wait_for_timeout(500)
    check("C2 favorites collapsed", fav_btn.get_attribute("aria-expanded") == "false" and page.locator("#nav-favs[data-closed]").count() == 1)
    adm_btn = page.locator('[data-sec=admin] button[aria-controls=nav-admin]')
    adm_btn.click(); page.wait_for_timeout(500)
    check("C2 admin section collapsed", page.locator("#nav-admin[data-closed]").count() == 1)
    shot(page, "C2-sections-collapsed")
    page.reload(); page.wait_for_timeout(800)
    check("C2 collapse persisted after reload", page.locator("#nav-favs[data-closed]").count() == 1)
    fav_btn.click(); adm_btn.click(); page.wait_for_timeout(400)
    w0 = page.locator("aside").first.bounding_box()["width"]
    page.locator("[data-sidebar-toggle]").click(); page.wait_for_timeout(600)
    w1 = page.locator("aside").first.bounding_box()["width"]
    check(f"C2 sidebar collapses ({w0:.0f} -> {w1:.0f})", w1 < w0 - 80)
    shot(page, "C2-sidebar-mini")
    page.locator("[data-sidebar-toggle]").click(); page.wait_for_timeout(500)

    # ---------- C1 open in place ----------
    page.goto(BASE + "/#/account/prefs"); page.wait_for_selector("[data-prefs]"); page.wait_for_timeout(300)
    page.get_by_role("switch", name="原地打开文件").click(); page.wait_for_timeout(200)
    check("C1 pref persisted", page.evaluate("JSON.parse(localStorage.dh_prefs).openInPlace") is True)
    shot(page, "C1-prefs")
    to_dir(page, TMP)
    tabs = lambda: page.locator('[role=tab]').count()
    t0 = tabs()
    page.locator(f'[data-sel-path="{TMP}/alpha.txt"]').first.dblclick(); page.wait_for_timeout(900)
    t1 = tabs()
    page.get_by_role("tab").first.click(); page.wait_for_timeout(300)
    page.locator(f'[data-sel-path="{TMP}/bravo.txt"]').first.dblclick(); page.wait_for_timeout(900)
    t2 = tabs()
    check(f"C1 open-in-place keeps one file tab ({t0}->{t1}->{t2})", t1 == max(t0, 1) + 1 and t2 == t1)
    shot(page, "C1-open-in-place")
    page.evaluate("() => { const p = JSON.parse(localStorage.dh_prefs); p.openInPlace = false; localStorage.dh_prefs = JSON.stringify(p); }")
    page.reload(); page.wait_for_timeout(600)
    to_dir(page, TMP)
    page.locator(f'[data-sel-path="{TMP}/charlie.txt"]').first.dblclick(); page.wait_for_timeout(900)
    check(f"C1 off -> new tab ({tabs()})", tabs() >= t2 + 1)
    page.get_by_role("tab").first.click(); page.wait_for_timeout(300)

    # ---------- C4 tags ----------
    to_dir(page, TMP)
    ctx_menu(page, f"{TMP}/alpha.txt", "标签…")
    td = page.locator("[data-tag-dialog]")
    td.get_by_label("新标签名").fill("r5-重要"); td.get_by_role("radio").nth(1).click(); td.get_by_role("button", name="新建并添加").click(); page.wait_for_timeout(700)
    td.get_by_label("新标签名").fill("r5-草稿"); td.get_by_role("button", name="新建并添加").click(); page.wait_for_timeout(700)
    check(f"C4 two tags selected ({td.locator('[data-tags-selected] .atag').count()})", td.locator("[data-tags-selected] .atag").count() == 2)
    shot(page, "C4-tag-dialog")
    td.locator("[data-tags-selected] .atag", has_text="r5-草稿").click(); page.wait_for_timeout(600)
    check("C4 animated move to available", td.locator("[data-tags-available] .atag", has_text="r5-草稿").count() == 1)
    page.get_by_role("dialog").get_by_role("button", name="完成").click(); page.wait_for_timeout(500)
    ctx_menu(page, f"{TMP}/bravo.txt", "标签…")
    page.locator("[data-tags-available] .atag", has_text="r5-草稿").click(); page.wait_for_timeout(600)
    page.get_by_role("dialog").get_by_role("button", name="完成").click(); page.wait_for_timeout(600)
    check("C4 tag pills on rows", page.locator(f'[data-sel-path="{TMP}/alpha.txt"] [data-file-tags]').count() == 1)
    page.get_by_role("button", name="按标签筛选").click(); page.wait_for_timeout(400)
    bar = page.locator("[data-tag-filter]")
    bar.locator(".chip", has_text="r5-重要").click(); page.wait_for_timeout(600)
    vis = page.locator(f'[role=row][data-sel-path^="{TMP}/"]').count()
    check(f"C4 tag filter shows only tagged ({vis})", vis == 1)
    shot(page, "C4-tag-filter")
    bar.locator(".chip", has_text="r5-重要").click(); page.wait_for_timeout(400)
    page.get_by_role("button", name="按标签筛选").click(); page.wait_for_timeout(300)

    # ---------- C6 hover reveal ----------
    to_dir(page, "/示例/照片")
    r0 = page.locator('[role=row][data-sel-path$=".jpg"]').first
    b = r0.bounding_box(); page.mouse.move(b["x"] + 200, b["y"] + b["height"] / 2); page.wait_for_timeout(150)
    page.mouse.move(b["x"] + 240, b["y"] + b["height"] / 2, steps=4); page.wait_for_timeout(600)
    hv = page.locator("[data-hover-reveal]")
    op = float(hv.evaluate("e => e.style.opacity") or 0) if hv.count() else 0
    check(f"C6 hover reveal visible (opacity {op})", op > 0.9)
    shot(page, "C6-hover-reveal")
    page.mouse.move(5, 450); page.wait_for_timeout(600)
    check("C6 hover reveal hides on leave", page.locator("[data-hover-reveal]").count() == 0 or float(page.locator("[data-hover-reveal]").evaluate("e => e.style.opacity") or 0) < 0.1)

    # ---------- C8 waveform list ----------
    to_dir(page, "/示例/媒体")
    wr = page.locator("[data-wave-row]")
    check(f"C8 audio rows have waveform ({wr.count()})", wr.count() >= 2 and page.locator("canvas[data-wave]").count() >= 2)
    wr.first.get_by_role("button").click(); page.wait_for_timeout(1800)
    check("C8 player bar appears", page.locator("[data-wave-bar]").count() == 1)
    bar_btn = page.locator("[data-wave-bar]").get_by_role("button").first
    playing = bar_btn.get_attribute("aria-label") == "暂停" and wr.first.get_by_role("button").get_attribute("aria-label", timeout=2000).startswith("暂停")
    check("C8 inline audio playing", playing)
    shot(page, "C8-waveform-list-playing")
    page.locator("[data-wave-bar]").get_by_role("button", name="关闭播放").click(); page.wait_for_timeout(300)

    # ---------- C7 music player ----------
    page.locator('[data-sel-path$="a3-带封面.mp3"]').first.dblclick(); page.wait_for_selector('[data-testid=music-player]', timeout=10000); page.wait_for_timeout(1800)
    check("C7 music player widget + vinyl", page.locator("[data-testid=vinyl]").count() == 1)
    check("C7 21-dot visualizer", page.locator("[data-testid=dot-viz] span").count() == 21)
    hs = page.evaluate("() => { const a=[...document.querySelectorAll('[data-testid=dot-viz] span')].map(s=>s.style.height); return new Set(a).size }")
    check(f"C7 visualizer animating while playing ({hs} distinct heights)", hs > 3)
    check("C7 title from ID3 kept", "封面测试曲" in page.locator('[data-testid=audio-title]').inner_text())
    shot(page, "C7-music-player")
    page.keyboard.press("Escape"); page.wait_for_timeout(300)

    # ---------- C9 command palette ----------
    page.goto(BASE + "/#/files/"); page.wait_for_timeout(500)
    page.keyboard.press("Control+k"); page.wait_for_selector("[data-palette]"); page.wait_for_timeout(600)
    pal = page.locator("[data-palette]")
    page.keyboard.press("ArrowDown"); page.keyboard.press("ArrowDown"); page.wait_for_timeout(700)
    hl = page.evaluate("""() => { const h = document.querySelector('[data-cp-hl]'); const a = document.querySelector('[data-palette] [aria-selected=true]');
      return h && a ? Math.abs(h.getBoundingClientRect().top - a.getBoundingClientRect().top) : 999 }""")
    check(f"C9 spring highlight follows active row (Δ{hl:.1f}px)", hl < 3)
    shot(page, "C9-palette-highlight")
    page.keyboard.type("统计"); page.wait_for_timeout(400)
    first = pal.locator("[aria-selected=true]").inner_text()
    check(f"C9 fuzzy '统计' ranks 访问统计 first ({first[:20]!r})", "访问统计" in first)
    page.get_by_label("命令或搜索").fill(""); page.keyboard.type("audt"); page.wait_for_timeout(400)
    first = pal.locator("[aria-selected=true]").inner_text() if pal.locator("[aria-selected=true]").count() else ""
    check(f"C9 subsequence 'audt' ranks 审计日志 (audit log) first ({first[:20]!r})", "审计日志" in first)
    page.get_by_label("命令或搜索").fill(""); page.keyboard.type("fwtj"); page.wait_for_timeout(400)
    first = pal.locator("[aria-selected=true]").inner_text() if pal.locator("[aria-selected=true]").count() else ""
    check(f"C9 pinyin initials 'fwtj' -> 访问统计 ({first[:20]!r})", "访问统计" in first)
    shot(page, "C9-palette-fuzzy")
    page.keyboard.press("Enter"); page.wait_for_timeout(800)
    check("C9 enter navigates", "#/stats" in page.url)

    # ---------- C5 OTP field ----------
    page.goto(BASE + "/#/account/security"); page.wait_for_timeout(800)
    page.get_by_role("button", name="开启两步验证").click(); page.wait_for_selector("[data-otp]"); page.wait_for_timeout(400)
    cells = page.locator("[data-otp] input")
    check(f"C5 otp field 6 cells ({cells.count()})", cells.count() == 6)
    cells.first.click(); page.keyboard.type("123"); page.wait_for_timeout(200)
    shot(page, "C5-otp-typing")
    page.keyboard.type("456"); page.wait_for_timeout(1200)
    check("C5 wrong code -> error state", page.locator("[data-otp].bad").count() == 1)
    shot(page, "C5-otp-wrong")
    check("C5 totp still disabled", api(tok, "GET", "/api/auth/me").get("totp_enabled") is False)

    page.goto(BASE + "/#/login"); page.wait_for_timeout(300)
    real = [e for e in errors if "401" not in e and "Failed to load resource" not in e]
    check(f"no page errors ({real[:3]})", not real)
    # cleanup
    for s in (good, fsh):
        if "id" in s: api(tok, "DELETE", f"/api/shares/{s['id']}")
    br.close()

print(f"\n{'ALL PASS' if not fails else 'FAILED: ' + str(len(fails))} ({len(fails)} fail)")
raise SystemExit(1 if fails else 0)
