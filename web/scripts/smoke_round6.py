"""DEPTAI-485 round-6 checks + screenshots (Playwright, python).
Usage: BASE=http://localhost:8488 DH_USER=.. DH_PASS=.. SHOTS=dir python3 smoke_round6.py
Covers the 10 round-6 items:
 1 share delete → undo toast (undo keeps it, timeout deletes it)   2 unified control / title sizes
 3 stats page: fixed controls, only the detail area scrolls          4 IP stats + regions + offline map (API + UI)
 5 ACL redesign (sub-tabs, member cards, presets, fine-tune)         6 skeletons while loading
 7 no native select / checkbox / radio anywhere                      8 unified pager (numbers, jump, page size)
 9 tags single line with +N popover                                  10 sidebar 全部文件 collapse, indented favorites, limit"""
import json, os, time, urllib.request, urllib.parse, urllib.error
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:8488")
U, P = os.environ["DH_USER"], os.environ["DH_PASS"]
SHOTS = os.environ.get("SHOTS", "/tmp")
TMP = "/示例/r6-tmp"
errors, fails = [], []
os.makedirs(SHOTS, exist_ok=True)

def check(name, cond):
    (fails.append(name) if not cond else None)
    print(("PASS " if cond else "FAIL ") + name, flush=True)

def shot(page, name, **kw):
    page.screenshot(path=f"{SHOTS}/{name}.png", **kw)

def api(tok, method, path, body=None, raw=None, ctype="application/json", auth=True, headers=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    h = {"content-type": ctype, **(headers or {})}
    if auth: h["authorization"] = f"Bearer {tok}"
    req = urllib.request.Request(BASE + urllib.parse.quote(path, safe="/?=&%:,"), data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req) as r:
            b = r.read()
            try: return json.loads(b) if b else {}
            except ValueError: return {"_raw": len(b)}
    except urllib.error.HTTPError as e:
        return {"_err": e.code, "_body": e.read().decode()[:200]}

def login():
    req = urllib.request.Request(BASE + "/api/auth/login", data=json.dumps({"login": U, "password": P}).encode(), headers={"content-type": "application/json"})
    return json.load(urllib.request.urlopen(req))["access_token"]

def combo_pick(page, cb, text):
    cb.click(); page.wait_for_timeout(250)
    page.get_by_role("listbox").get_by_role("option", name=text, exact=True).click(); page.wait_for_timeout(300)

def native_count(page):
    return page.evaluate("() => [...document.querySelectorAll('select, input[type=checkbox], input[type=radio]')].filter(e => !e.classList.contains('sr-only')).length")

def goto(page, hash_, sel, t=10000):
    page.goto(BASE + "/#" + hash_); page.wait_for_selector(sel, timeout=t); page.wait_for_timeout(500)

with sync_playwright() as pw:
    tok = login()
    # ---------- fixtures ----------
    api(tok, "POST", "/api/fs/mkdir", {"path": TMP})
    for i in range(1, 186):
        api(tok, "PUT", f"/api/fs/upload?path={TMP}/f{i:03d}.txt&overwrite=true", raw=f"file {i}\n".encode(), ctype="application/octet-stream")
    for t in api(tok, "GET", "/api/tags"):
        if str(t.get("name", "")).startswith("r6-"): api(tok, "DELETE", f"/api/tags/{t['id']}")
    api(tok, "POST", "/api/tags/assign", {"paths": [f"{TMP}/f001.txt"], "add_names": [f"r6-标签{i}" for i in range(1, 10)]})
    for s in api(tok, "GET", "/api/shares"):
        if str(s.get("name", "")).startswith("f0") or "r6" in str(s.get("name", "")): api(tok, "DELETE", f"/api/shares/{s['id']}")
    shares = [api(tok, "POST", "/api/shares", {"paths": [f"{TMP}/f{i:03d}.txt"], "perm": "download"}) for i in range(1, 26)]
    check(f"fixture 25 shares ({sum('code' in s for s in shares)})", all("code" in s for s in shares))
    t0 = int(time.time()) - 1
    IPS = {"8.8.8.8": 3, "1.1.1.1": 2, "114.114.114.114": 6, "223.5.5.5": 5, "202.96.128.86": 4, "61.135.169.121": 3, "192.168.1.20": 7, "10.0.0.8": 2, "81.2.69.142": 2, "133.242.0.1": 2, "203.0.113.9": 1}
    for ip, n in IPS.items():
        for k in range(n):
            api(tok, "GET", f"/api/s/{shares[k % 5]['code']}", auth=False, headers={"x-forwarded-for": ip})
    # ---------- #4 backend ----------
    st = api(tok, "GET", f"/api/stats/access?scope=shares&per_page=5&from={t0}")
    geo = st.get("summary", {}).get("geo", {})
    codes = [c["code"] for c in geo.get("by_country", [])]
    check(f"#4 api geo db loaded ({geo.get('db')})", geo.get("db") is True)
    check(f"#4 api by_country has LAN/CN/US ({codes})", all(c in codes for c in ("LAN", "CN", "US")))
    regs = [r["region"] for r in geo.get("by_region", []) if r["code"] == "CN"]
    check(f"#4 api CN provinces ({regs})", len(regs) >= 2)
    lan = next((c for c in geo.get("by_country", []) if c["code"] == "LAN"), {})
    check(f"#4 api LAN = 9 events / 2 IPs ({lan})", lan.get("count") == 9 and lan.get("ips") == 2)
    cn = api(tok, "GET", f"/api/stats/access?scope=shares&country=CN&per_page=200&from={t0}")
    check(f"#4 api country=CN filter ({cn.get('total')} rows)", cn.get("total") == 18 and all((r.get("geo") or "").startswith("中国") for r in cn["rows"]))
    if regs:
        rg = api(tok, "GET", f"/api/stats/access?scope=shares&country=CN&region={urllib.parse.quote(regs[0])}&from={t0}")
        check(f"#4 api region filter {regs[0]} ({rg.get('total')})", 0 < rg.get("total", 0) < 18)
    ips = api(tok, "GET", f"/api/stats/ips?scope=shares&per_page=4&sort=count&from={t0}")
    check(f"#4 api /stats/ips paged ({ips.get('total')} ips, {len(ips.get('rows', []))} rows)", ips.get("total") == len(IPS) and len(ips.get("rows", [])) == 4)
    check("#4 api /stats/ips sorted by count", ips["rows"][0]["ip"] == "192.168.1.20" and ips["rows"][0]["geo"]["label"] == "局域网")
    allips = {r["ip"]: r for r in api(tok, "GET", f"/api/stats/ips?scope=shares&per_page=50&from={t0}")["rows"]}
    check(f"#4 api 10.x is 局域网, 203.0.113.9 is 保留地址 ({allips['10.0.0.8']['geo']['label']}, {allips['203.0.113.9']['geo']['label']})", allips["10.0.0.8"]["geo"]["kind"] == "lan" and allips["203.0.113.9"]["geo"]["kind"] == "reserved")
    check(f"#4 api 8.8.8.8 → US ({allips['8.8.8.8']['geo']})", allips["8.8.8.8"]["geo"]["code"] == "US")
    check(f"#4 api visits/shares per ip ({allips['114.114.114.114']['visits']}, {allips['114.114.114.114']['shares']})", allips["114.114.114.114"]["visits"] == 6 and allips["114.114.114.114"]["shares"] == 5)

    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 1440, "height": 900}, color_scheme="light")
    page = ctx.new_page()
    page.on("console", lambda m: m.type == "error" and errors.append(f"console {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
    page.goto(BASE + "/"); page.wait_for_selector("form")
    page.get_by_label("用户名或邮箱").fill(U); page.get_by_label("密码").fill(P)
    page.get_by_role("button", name="登录").click(); page.wait_for_selector("#main", timeout=10000)
    favs = [{"path": f"{TMP}/f{i:03d}.txt", "name": f"f{i:03d}.txt", "is_dir": False} for i in range(1, 8)] + [{"path": "/示例/文档", "name": "文档", "is_dir": True}, {"path": "/示例/照片", "name": "照片", "is_dir": True}]
    page.evaluate("""(f) => { localStorage.setItem('dh_view', JSON.stringify('list')); localStorage.setItem('dh_favs', JSON.stringify(f));
      localStorage.setItem('dh_prefs', JSON.stringify({openInPlace:false,favsCollapsed:false,adminCollapsed:false,filesCollapsed:false,favsShowAll:false,hoverPreview:true}));
      localStorage.setItem('dh_pagesize_files', '30'); }""", favs)
    page.reload(); page.wait_for_selector("#main")

    # ---------- #6 skeletons (slow API) ----------
    def slow(route):
        time.sleep(1.5); route.continue_()
    page.route("**/api/fs/list**", slow)
    page.goto(BASE + "/#/files" + TMP); page.wait_for_timeout(500)
    check("#6 file list skeleton while loading", page.locator("[data-skeleton]").count() >= 1 and page.locator(".animate-spin").count() == 0)
    shot(page, "06-skeleton-files")
    page.unroute("**/api/fs/list**")
    page.route("**/api/stats/access**", slow)
    page.goto(BASE + "/#/stats"); page.wait_for_timeout(500)
    check("#6 stats skeleton (kpis + table)", page.locator("[data-skeleton]").count() >= 1 and page.locator(".animate-spin").count() == 0)
    shot(page, "06-skeleton-stats")
    page.unroute("**/api/stats/access**")
    page.route("**/api/acl/rules", slow)
    page.goto(BASE + "/#/admin/acl"); page.wait_for_timeout(500)
    check("#6 acl skeleton", page.locator("[data-skeleton]").count() >= 1)
    shot(page, "06-skeleton-acl")
    page.unroute("**/api/acl/rules")

    # ---------- #8 pager + #9 tags (files) ----------
    goto(page, "/files" + TMP, '[role=row][data-sel-path]')
    pager = page.locator("[data-pager]").last
    check("#8 file pager present", pager.count() == 1 and pager.get_attribute("data-pager") != "single")
    check(f"#8 page numbers ({pager.locator('[aria-label^=第]').count()})", pager.locator("[aria-label^='第 ']").count() >= 5)
    check("#8 jump input (7 pages)", pager.get_by_label("跳转页码").count() == 1)
    pager.get_by_label("跳转页码").fill("5"); pager.get_by_label("跳转页码").press("Enter"); page.wait_for_timeout(500)
    check("#8 jump to page 5", page.locator("[data-pager] [aria-current=page]").last.inner_text().strip() == "5")
    check(f"#8 range text ({page.locator('[data-pager-range]').last.inner_text()})", "121–150" in page.locator("[data-pager-range]").last.inner_text())
    shot(page, "08-pager-files-p5")
    combo_pick(page, page.locator("[data-pager]").last.get_by_role("combobox", name="每页条数"), "100 项/页" if page.locator("[data-pager-range]").last.inner_text().endswith("项") else "100 条/页") if False else None
    cb = page.locator("[data-pager]").last.get_by_role("combobox", name="每页条数")
    cb.click(); page.wait_for_timeout(250)
    opt = page.get_by_role("listbox").get_by_role("option").filter(has_text="100")
    opt.first.click(); page.wait_for_timeout(600)
    check(f"#8 page size 100 → 2 pages ({page.locator('[data-pager-range]').last.inner_text()})", "1–100" in page.locator("[data-pager-range]").last.inner_text())
    check("#8 page size persisted", page.evaluate("localStorage.getItem('dh_pagesize_files')") == "100")
    page.evaluate("localStorage.setItem('dh_pagesize_files', '30')")
    goto(page, "/files" + TMP, '[role=row][data-sel-path]')
    tr = page.locator(f'[role=row][data-sel-path="{TMP}/f001.txt"] [data-file-tags]').first
    tot, shown = int(tr.get_attribute("data-tags-total")), int(tr.get_attribute("data-tags-shown"))
    check(f"#9 tag row total 9, shown {shown} < 9", tot == 9 and 0 < shown < 9)
    box = tr.bounding_box()
    check(f"#9 tags single line (h={box['height']:.0f})", box["height"] <= 28)
    more = tr.locator("[data-tags-more]")
    check(f"#9 +N chip = {more.get_attribute('data-tags-more')}", more.count() == 1 and int(more.get_attribute("data-tags-more")) == 9 - shown)
    more.hover(); page.wait_for_timeout(500)
    popc = page.locator("[data-tags-popover] .ftag").count()
    check(f"#9 hover popover lists all 9 tags ({popc})", popc == 9)
    shot(page, "09-tags-plusN-hover")
    page.mouse.move(5, 890); page.wait_for_timeout(500)
    check("#9 popover closes", page.locator("[data-tags-popover]").count() == 0)
    more.click(); page.wait_for_timeout(400)
    check("#9 click opens popover", page.locator("[data-tags-popover]").count() == 1)
    page.keyboard.press("Escape"); page.mouse.click(700, 60); page.wait_for_timeout(300)
    page.set_viewport_size({"width": 1440, "height": 900})
    page.evaluate("localStorage.setItem('dh_view', JSON.stringify('grid'))"); page.reload(); page.wait_for_selector("[data-file-tags]"); page.wait_for_timeout(600)
    g = page.locator(f'[data-sel-path="{TMP}/f001.txt"] [data-file-tags]').first
    check(f"#9 grid card tags single line (+{g.get_attribute('data-tags-more') or g.locator('[data-tags-more]').get_attribute('data-tags-more')})", g.bounding_box()["height"] <= 28 and g.locator("[data-tags-more]").count() == 1)
    shot(page, "09-tags-grid")
    page.evaluate("localStorage.setItem('dh_view', JSON.stringify('list'))"); page.reload(); page.wait_for_selector("#main"); page.wait_for_timeout(400)

    # ---------- #10 sidebar ----------
    fl = page.locator("[data-favs-list]")
    check(f"#10 favorites limited to 6 of 9 ({fl.get_attribute('data-favs-shown')})", fl.get_attribute("data-favs-shown") == "6" and fl.locator("[data-fav-item]").count() == 6)
    sec_x = page.locator("[data-sec=favs]").bounding_box()["x"]; item_x = fl.locator("[data-fav-item]").first.bounding_box()["x"]
    check(f"#10 favorites indented under section ({item_x - sec_x:.0f}px)", item_x - sec_x >= 10)
    shot(page, "10-sidebar-favs-limited", clip={"x": 0, "y": 0, "width": 320, "height": 900})
    page.locator("[data-favs-more]").click(); page.wait_for_timeout(400)
    check("#10 show all favorites", page.locator("[data-favs-list] [data-fav-item]").count() == 9)
    page.locator("[data-favs-more]").click(); page.wait_for_timeout(300)
    t = page.locator("[data-files-toggle]")
    check("#10 全部文件 expanded", t.get_attribute("aria-expanded") == "true")
    t.click(); page.wait_for_timeout(500)
    check("#10 全部文件 collapsed", t.get_attribute("aria-expanded") == "false" and page.locator("#nav-files[data-closed]").count() == 1)
    shot(page, "10-sidebar-files-collapsed", clip={"x": 0, "y": 0, "width": 320, "height": 900})
    page.reload(); page.wait_for_selector("#main"); page.wait_for_timeout(400)
    check("#10 collapse persisted", page.locator("#nav-files[data-closed]").count() == 1)
    page.locator("[data-files-toggle]").click(); page.wait_for_timeout(300)

    # ---------- #1 share delete undo ----------
    goto(page, "/shares", "[data-pager]")
    check(f"#8 shares pager ({page.locator('[data-pager-range]').count()})", page.locator("[data-pager-range]").count() == 1)
    shot(page, "08-shares-pager")
    def del_first():
        row = page.locator("tbody tr").first
        name = row.locator("td").nth(0).inner_text().split("\n")[0]
        row.get_by_role("button", name="删除").click(); page.wait_for_timeout(300)
        page.get_by_role("dialog").get_by_role("button", name="删除").click(); page.wait_for_timeout(500)
        return name
    n0 = len(api(tok, "GET", "/api/shares"))
    del_first()
    check("#1 undo toast shown", page.locator(".toast-undo").count() == 1)
    shot(page, "01-share-delete-undo-toast")
    page.locator(".toast-undo").get_by_role("button", name="撤销").click(); page.wait_for_timeout(800)
    check(f"#1 undo keeps the share ({len(api(tok, 'GET', '/api/shares'))} == {n0})", len(api(tok, "GET", "/api/shares")) == n0)
    del_first(); page.mouse.move(700, 300); page.wait_for_timeout(7000)
    check(f"#1 share deleted after undo window ({len(api(tok, 'GET', '/api/shares'))} == {n0 - 1})", len(api(tok, "GET", "/api/shares")) == n0 - 1)

    # ---------- #3 stats layout ----------
    goto(page, "/stats", "[data-stats-rows]")
    ctl = page.locator("[data-stats-controls]"); scr = page.locator("[data-stats-scroll]")
    y0 = ctl.bounding_box()["y"]
    h = page.evaluate("() => { const s = document.querySelector('[data-stats-scroll]'); return [s.scrollHeight, s.clientHeight]; }")
    check(f"#3 detail area scrolls internally {h}", h[0] > h[1])
    page.evaluate("() => { const s = document.querySelector('[data-stats-scroll]'); s.scrollTop = s.scrollHeight; }"); page.wait_for_timeout(300)
    main_scroll = page.evaluate("() => document.getElementById('main').scrollTop + document.scrollingElement.scrollTop")
    check(f"#3 controls stay put (y {y0:.0f} → {ctl.bounding_box()['y']:.0f}, page scroll {main_scroll})", abs(ctl.bounding_box()["y"] - y0) < 1 and main_scroll == 0)
    th = page.locator("[data-stats-rows] thead").bounding_box(); sb = scr.bounding_box()
    check(f"#3 table header sticky ({th['y']:.0f} vs {sb['y']:.0f})", abs(th["y"] - sb["y"]) < 3)
    pb = page.locator("[data-stats-pager]").bounding_box()
    check(f"#3 pager pinned in viewport ({pb['y'] + pb['height']:.0f} <= 900)", pb["y"] + pb["height"] <= 900)
    shot(page, "03-stats-details-scrolled")
    hs = page.evaluate("() => [...document.querySelectorAll('[data-stats-filters] [role=combobox], [data-stats-filters] input')].map(e => Math.round(e.getBoundingClientRect().height))")
    check(f"#2 stats filter controls all 32px {set(hs)}", hs and set(hs) == {32})
    # filters
    page.get_by_role("combobox", name="按地区筛选").click(); page.wait_for_timeout(250)
    page.get_by_role("listbox").get_by_role("option").filter(has_text="中国（").first.click(); page.wait_for_timeout(300)
    page.wait_for_timeout(700)
    check("#4 region filter pill", page.locator("[data-active-filters]").inner_text().startswith("地区：中国"))
    check(f"#4 province select appears", page.get_by_role("combobox", name="按省份筛选").count() == 1)
    shot(page, "04-stats-filter-cn")
    page.locator("[data-active-filters] button").first.click(); page.wait_for_timeout(500)

    # ---------- #4 geo tab ----------
    page.get_by_role("tab", name="地区与 IP").click(); page.wait_for_selector("[data-world-map]"); page.wait_for_timeout(1200)
    bubbles = page.locator("[data-world-map] [data-bubble]").count()
    check(f"#4 map bubbles ({bubbles})", bubbles >= 4 and page.locator('[data-bubble=LAN]').count() == 1)
    check("#4 china province tiles", page.locator("[data-tile]:not([disabled])").count() >= 2)
    check(f"#4 ip table rows ({page.locator('[data-ip-row]').count()})", page.locator("[data-ip-row]").count() >= 10)
    check("#4 LAN ip labelled 局域网", "局域网" in page.locator('[data-ip-row="192.168.1.20"]').inner_text())
    page.locator('[data-bubble=US] circle').last.hover(); page.wait_for_timeout(300)
    check("#4 map tooltip", "美国" in (page.locator("[data-map-tip]").inner_text() if page.locator("[data-map-tip]").count() else ""))
    shot(page, "04-stats-geo-map")
    page.evaluate("() => { const s = document.querySelector('[data-stats-scroll]'); s.scrollTop = 600; }"); page.wait_for_timeout(300)
    shot(page, "04-stats-geo-tiles-ips")
    page.locator('[data-tile]:not([disabled])').first.click(); page.wait_for_timeout(900)
    check("#4 province tile click filters", "中国 ·" in page.locator("[data-active-filters]").inner_text())
    shot(page, "04-stats-geo-province")
    page.locator("[data-active-filters] button").first.click(); page.wait_for_timeout(400)
    page.get_by_role("tab", name="趋势与排行").click(); page.wait_for_timeout(600)
    shot(page, "03-stats-trend")
    page.set_viewport_size({"width": 390, "height": 844}); page.get_by_role("tab", name="地区与 IP").click(); page.wait_for_timeout(800)
    shot(page, "04-stats-geo-mobile", full_page=False)
    page.set_viewport_size({"width": 1440, "height": 900})

    # ---------- #5 ACL ----------
    for r in api(tok, "GET", "/api/acl/rules"):
        if r["path"].startswith(TMP): api(tok, "DELETE", f"/api/acl/rules/{r['id']}")
    page.goto(BASE + "/#/admin/acl?path=" + urllib.parse.quote(TMP)); page.wait_for_selector("[data-testid=acl-add]"); page.wait_for_timeout(600)
    check(f"#5 four sub-tabs", all(page.get_by_role("tab", name=n).count() == 1 for n in ("按目录", "按成员", "权限检查", "使用说明")))
    add = page.locator("[data-testid=acl-add]")
    combo_pick(page, add.get_by_role("combobox", name="对象类型"), "所有登录用户")
    add.locator("[data-acl-add-btn]").click(); page.wait_for_timeout(900)
    combo_pick(page, add.get_by_role("combobox", name="对象类型"), "匿名访客")
    combo_pick(page, add.get_by_role("combobox", name="新规则预设"), "禁止访问 — 看不到、也不能下载")
    add.locator("[data-acl-add-btn]").click(); page.wait_for_timeout(900)
    cards = page.locator("[data-testid=acl-matrix] [data-rule]")
    check(f"#5 two member cards ({cards.count()})", cards.count() == 2)
    shot(page, "05-acl-by-dir")
    c0 = cards.filter(has_text="所有登录用户").first
    combo_pick(page, c0.get_by_role("combobox", name="权限预设"), "读写 — 还可以上传、新建、编辑、整理")
    page.wait_for_timeout(600)
    rr = [r for r in api(tok, "GET", "/api/acl/rules") if r["path"] == TMP and r["subject"] == "logged_in"]
    check(f"#5 preset dropdown → 读写 ({rr[0]['allow'] if rr else None})", rr and "upload" in rr[0]["allow"])
    page.locator("[data-testid=acl-matrix] [data-rule]").filter(has_text="所有登录用户").first.locator("[data-acl-tune]").click(); page.wait_for_timeout(400)
    fine = page.locator("[data-acl-fine]")
    check("#5 fine-tune grouped by category", fine.count() == 1 and fine.locator("fieldset").count() >= 3)
    fine.get_by_role("radiogroup", name="删除").get_by_role("radio", name="拒绝").click(); page.wait_for_timeout(800)
    rr = [r for r in api(tok, "GET", "/api/acl/rules") if r["path"] == TMP and r["subject"] == "logged_in"]
    check(f"#5 fine-tune deny 删除 ({rr[0]['deny'] if rr else None})", rr and "delete" in rr[0]["deny"])
    check("#5 fine-tune panel stays open after a change", page.locator("[data-acl-fine]").count() == 1)
    ov = page.evaluate("() => { const m = document.getElementById('main'); return [m.scrollWidth, m.clientWidth]; }")
    check(f"#5 no horizontal scroll {ov}", ov[0] <= ov[1])
    page.locator("[data-testid=acl-matrix] [data-rule]").filter(has_text="所有登录用户").first.locator("[data-acl-tune]").click(); page.wait_for_timeout(300)
    page.locator("[data-testid=acl-matrix] [data-rule]").filter(has_text="所有登录用户").first.locator("[data-acl-tune]").click(); page.wait_for_timeout(300)
    shot(page, "05-acl-fine-tune", full_page=True)
    page.get_by_role("tab", name="按成员").click(); page.wait_for_timeout(500)
    combo_pick(page, page.get_by_role("combobox", name="成员类型"), "所有登录用户")
    check(f"#5 按成员 lists rules ({page.locator('[data-acl-member-rules] li').count()})", page.locator("[data-acl-member-rules] li").count() >= 1)
    shot(page, "05-acl-by-member")
    page.get_by_role("tab", name="权限检查").click(); page.wait_for_selector("[data-testid=acl-effective]"); page.wait_for_timeout(400)
    check("#5 权限检查 shows effective + trace", page.locator("[data-testid=acl-effective]").count() == 1)
    shot(page, "05-acl-check")
    page.get_by_role("tab", name="使用说明").click(); page.wait_for_timeout(300)
    check("#5 使用说明", page.locator("[data-acl-help]").count() == 1)
    shot(page, "05-acl-help")
    for r in api(tok, "GET", "/api/acl/rules"):
        if r["path"] == TMP: api(tok, "DELETE", f"/api/acl/rules/{r['id']}")

    # ---------- #2 titles + #7 native controls across pages ----------
    pages = [("/files" + TMP, "[role=row]"), ("/shares", "h1"), ("/stats", "h1"), ("/search", "#main"), ("/admin", "h1"), ("/admin/users", "h1"), ("/admin/groups", "h1"), ("/admin/roles", "h1"),
             ("/admin/acl", "h1"), ("/admin/audit", "h1"), ("/admin/mounts", "h1"), ("/admin/settings", "h1"), ("/account", "#main"), ("/tasks", "#main")]
    natives, sizes = {}, {}
    for h_, sel in pages:
        goto(page, h_, sel)
        natives[h_] = native_count(page)
        if page.locator("main h1").count(): sizes[h_] = page.evaluate("() => getComputedStyle(document.querySelector('main h1')).fontSize")
        btn_h = page.evaluate("() => [...document.querySelectorAll('main h1')].length ? [...document.querySelector('main h1').closest('div').parentElement.querySelectorAll(':scope > div:last-child button')].map(b => Math.round(b.getBoundingClientRect().height)) : []")
        if btn_h and h_ not in ("/files" + TMP,): sizes[h_ + " btn"] = sorted(set(btn_h))
    check(f"#7 no native select/checkbox/radio {natives}", all(v == 0 for v in natives.values()))
    ts = {k: v for k, v in sizes.items() if not k.endswith(" btn")}
    check(f"#2 page titles same size {set(ts.values())}", len(set(ts.values())) == 1)
    bs = {k: v for k, v in sizes.items() if k.endswith(" btn")}
    check(f"#2 header action buttons 32px {bs}", all(set(v) <= {32} for v in bs.values()))
    goto(page, "/admin/audit", "h1")
    check("#7 audit 只看拒绝 is a custom checkbox", page.get_by_role("checkbox", name="只看拒绝").count() == 1)
    shot(page, "07-audit-controls")

    page.goto(BASE + "/#/login"); page.wait_for_timeout(300)
    real = [e for e in errors if "401" not in e and "Failed to load resource" not in e]
    check(f"no page errors ({real[:3]})", not real)
    for s in api(tok, "GET", "/api/shares"):
        if str(s.get("name", "")).startswith("f0"): api(tok, "DELETE", f"/api/shares/{s['id']}")
    br.close()

print(f"\n{'ALL PASS' if not fails else 'FAILED: ' + str(len(fails))} ({len(fails)} fail)")
raise SystemExit(1 if fails else 0)
