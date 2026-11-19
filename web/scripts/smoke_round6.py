"""DEPTAI-485 round-6 regression checks + screenshots (Playwright, python).
Usage: BASE=http://localhost:8480 DH_USER=.. DH_PASS=.. SHOTS=dir python3 smoke_round6.py
1 drag-to-trash (Dropit): whole card/row lifts and follows the pointer, bin spawns once next to the
  dragged item and stays frozen, cursor hit test, delete vanishes in place, Esc flies back.
2 audio track switch: panel + player stay mounted (no fade-in / blank frame), tab replaced in place.
3 video player back to the full-width r3 look (no 342px phone-like card).
4 code/text viewer: format select + wrap + copy are one 32px key row in the toolbar."""
import json, os, urllib.request, urllib.parse, urllib.error
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:8480")
U, P = os.environ["DH_USER"], os.environ["DH_PASS"]
SHOTS = os.environ.get("SHOTS", "/tmp")
TMP = "/示例/r6-tmp"
errors, fails = [], []

def check(name, cond):
    (fails.append(name) if not cond else None)
    print(("PASS " if cond else "FAIL ") + name, flush=True)

def shot(page, name, **kw):
    page.screenshot(path=f"{SHOTS}/{name}.png", **kw)

def api(tok, method, path, body=None, raw=None, ctype="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + urllib.parse.quote(path, safe="/?=&%:"), data=data, method=method, headers={"content-type": ctype, "authorization": f"Bearer {tok}"})
    try:
        with urllib.request.urlopen(req) as r:
            b = r.read()
            return json.loads(b) if b else {}
    except urllib.error.HTTPError as e:
        return {"_err": e.code}

def login():
    req = urllib.request.Request(BASE + "/api/auth/login", data=json.dumps({"login": U, "password": P}).encode(), headers={"content-type": "application/json"})
    return json.load(urllib.request.urlopen(req))["access_token"]

def bin_info(page):
    return page.evaluate("""() => { const b = document.querySelector('[data-testid=trash-zone]'); if (!b) return null;
      const d = b.querySelector('.disc').getBoundingClientRect();
      return {x: +b.dataset.x, y: +b.dataset.y, hot: b.hasAttribute('data-hot'), cx: d.left + d.width / 2, cy: d.top + d.height / 2, label: b.innerText}; }""")

def lift_box(page):
    return page.evaluate("""() => { const g = document.querySelector('[data-drag-lift]'); if (!g) return null;
      const r = g.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2, w: g.offsetWidth, h: g.offsetHeight, text: g.innerText, out: g.dataset.out || '', tf: g.style.transform}; }""")

def open_dir(page, path, view):
    page.evaluate(f"() => localStorage.setItem('dh_view', JSON.stringify('{view}'))")
    page.goto(BASE + "/#/stats"); page.wait_for_timeout(150)
    page.goto(BASE + "/#/files" + path); page.wait_for_timeout(300)
    if page.locator("[role=tab]").count(): page.locator("[role=tab]").first.click()
    page.wait_for_selector("[data-sel-path]"); page.wait_for_timeout(500)

def glide(page, x0, y0, x1, y1, n=12):
    for k in range(1, n + 1):
        page.mouse.move(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n); page.wait_for_timeout(16)

def open_file(page, path):
    d = path.rsplit("/", 1)[0]
    page.goto(BASE + "/#/files" + d); page.wait_for_timeout(500)
    if page.locator("[role=tab]").count(): page.locator("[role=tab]").first.click(); page.wait_for_timeout(300)
    page.locator(f'[data-sel-path="{path}"]').first.dblclick(); page.wait_for_timeout(1200)

with sync_playwright() as pw:
    tok = login()
    api(tok, "POST", "/api/fs/mkdir", {"path": TMP})
    for n in ["alpha.txt", "bravo.txt", "charlie.txt", "delta.txt", "echo.txt"]:
        api(tok, "PUT", f"/api/fs/upload?path={TMP}/{n}&overwrite=true", raw=f"hello {n}\n".encode(), ctype="application/octet-stream")
    br = pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    ctx = br.new_context(viewport={"width": 1440, "height": 900}, color_scheme="light")
    page = ctx.new_page()
    page.on("console", lambda m: m.type == "error" and errors.append(f"console {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
    page.goto(BASE + "/"); page.wait_for_selector("form")
    page.get_by_label("用户名或邮箱").fill(U); page.get_by_label("密码").fill(P)
    page.get_by_role("button", name="登录").click(); page.wait_for_selector("#main", timeout=10000)
    page.evaluate("""() => { localStorage.setItem('dh_tabs', JSON.stringify({tabs: [], active: null}));
      localStorage.setItem('dh_prefs', JSON.stringify({openInPlace:false,favsCollapsed:false,adminCollapsed:false,hoverPreview:false})); }""")
    page.reload(); page.wait_for_selector("#main")

    # ---------- 1 drag to trash: list rows ----------
    open_dir(page, TMP, "list")
    row = page.locator(f'[role=row][data-sel-path="{TMP}/bravo.txt"]').first
    rb = row.bounding_box()
    sx, sy = rb["x"] + 120, rb["y"] + rb["height"] / 2
    page.mouse.move(sx, sy); page.mouse.down()
    glide(page, sx, sy, sx + 30, sy + 40, 6); page.wait_for_timeout(150)
    g = lift_box(page); b0 = bin_info(page)
    check(f"1 whole row lifts (ghost {g and round(g['w'])}x{g and round(g['h'])} vs row {round(rb['width'])}x{round(rb['height'])})", bool(g) and g["w"] >= min(rb["width"], 720) - 2 and abs(g["h"] - rb["height"]) < 2 and "bravo" in g["text"])
    check("1 no name-only chip used", page.locator(".fly-chip").count() == 0)
    check("1 source row becomes dashed slot", page.locator(f'[data-sel-path="{TMP}/bravo.txt"].drag-slot').count() == 1)
    exp_x = min(max(rb["x"] + min(rb["width"], 720) + 56, 46), 1440 - 46)
    check(f"1 bin spawns beside the dragged row ({b0}) expected x≈{round(exp_x)} y≈{round(rb['y'] + rb['height'] / 2)}", bool(b0) and abs(b0["x"] - exp_x) <= 2 and abs(b0["y"] - (rb["y"] + rb["height"] / 2)) <= 2)
    shot(page, "1a-row-lifted-bin-beside")
    glide(page, sx + 30, sy + 40, sx + 380, sy + 300, 14); page.wait_for_timeout(200)
    g2 = lift_box(page); b1 = bin_info(page)
    check(f"1 ghost follows pointer (Δx {g2 and round(g2['x'] - g['x'])}, Δy {g2 and round(g2['y'] - g['y'])})", bool(g2) and abs((g2["x"] - g["x"]) - 350) < 40 and abs((g2["y"] - g["y"]) - 260) < 40)
    check(f"1 bin stays frozen while dragging ({b1})", bool(b1) and b1["x"] == b0["x"] and b1["y"] == b0["y"] and abs(b1["cx"] - b0["cx"]) < 1.5)
    shot(page, "1b-dragged-far-bin-frozen")
    glide(page, sx + 380, sy + 300, b0["x"] + 10, b0["y"] + 8, 12); page.wait_for_timeout(300)
    b2 = bin_info(page)
    check(f"1 cursor within 34.5px of bin -> hot ({b2})", bool(b2) and b2["hot"] and "松手删除" in b2["label"])
    shot(page, "1c-bin-hot")
    page.mouse.up(); page.wait_for_timeout(120)
    g3 = lift_box(page); b3 = bin_info(page)
    check(f"1 delete: ghost vanishes in place ({g3 and g3['out']})", (g3 is None) or g3["out"] == "delete")
    check(f"1 red bin lingers after delete ({b3 and b3['label']})", bool(b3) and b3["hot"] and b3["x"] == b0["x"])
    check("1 undo toast", page.get_by_role("button", name="撤销").count() >= 1)
    shot(page, "1d-deleted-bin-lingers")
    page.wait_for_timeout(1000)
    check("1 bin gone ~0.8s later, ghost removed", bin_info(page) is None and lift_box(page) is None)
    if page.get_by_role("button", name="撤销").count(): page.get_by_role("button", name="撤销").first.click(); page.wait_for_timeout(800)

    # ---------- 1 grid cards + Esc cancel flies back ----------
    open_dir(page, TMP, "grid")
    card = page.locator(f'li[data-sel-path="{TMP}/charlie.txt"]').first
    cb = card.bounding_box()
    sx, sy = cb["x"] + cb["width"] / 2, cb["y"] + cb["height"] / 2
    page.mouse.move(sx, sy); page.mouse.down()
    glide(page, sx, sy, sx - 60, sy + 70, 10); page.wait_for_timeout(150)
    g = lift_box(page); b0 = bin_info(page)
    check(f"1 whole grid card lifts ({g and round(g['w'])} vs {round(cb['width'])})", bool(g) and abs(g["w"] - cb["width"]) < 2 and abs(g["h"] - cb["height"]) < 2)
    exp_x = min(max(cb["x"] + cb["width"] + 56, 46), 1440 - 46)
    check(f"1 bin spawns ~56px right of the card ({b0 and b0['x']} vs {round(exp_x)})", bool(b0) and abs(b0["x"] - exp_x) <= 2 and abs(b0["y"] - sy) <= 2)
    check("1 card tilts with horizontal velocity", bool(g) and "rotate(" in g["tf"] and "rotate(0.00deg)" not in g["tf"])
    shot(page, "1e-card-lifted-tilt")
    page.keyboard.press("Escape"); page.mouse.up(); page.wait_for_timeout(80)
    g4 = lift_box(page)
    check(f"1 cancel: card flies back to its slot ({g4 and g4['out']})", (g4 is None) or g4["out"] in ("back", "drop"))
    page.wait_for_timeout(500)
    check("1 cancel leaves the file in place", page.locator(f'li[data-sel-path="{TMP}/charlie.txt"]').count() == 1 and bin_info(page) is None)
    page.evaluate("() => localStorage.setItem('dh_view', JSON.stringify('list'))")

    # ---------- 2 audio track switch without flash ----------
    open_file(page, "/示例/媒体/a1-钢琴.mp3")
    page.wait_for_selector("[data-testid=audio-player]"); page.wait_for_timeout(800)
    ntabs = page.locator("[role=tab]").count()
    page.evaluate("""() => { const p = document.querySelector('[data-testid=audio-player]'); p.__r6 = 1; const panel = p.closest('.anim-in'); panel.__r6 = 1;
      window.__r6s = []; const t0 = performance.now();
      const tick = () => { const pp = document.querySelector('[data-testid=audio-player]'); const pn = pp && pp.closest('.anim-in');
        window.__r6s.push({op: pn ? +getComputedStyle(pn).opacity : -1, same: !!(pp && pp.__r6), panel: !!(pn && pn.__r6), vinyl: !!document.querySelector('[data-testid=vinyl]')});
        if (performance.now() - t0 < 1500) requestAnimationFrame(tick); };
      window.__r6go = () => requestAnimationFrame(tick); }""")
    page.evaluate("() => window.__r6go()")
    page.get_by_test_id("playlist").get_by_role("button").nth(1).click()
    page.wait_for_timeout(1600)
    s = page.evaluate("() => window.__r6s")
    check(f"2 player stays mounted across track switch ({len(s)} frames)", len(s) > 20 and all(f["same"] and f["panel"] for f in s))
    check(f"2 no fade/blank frame (min panel opacity {min(f['op'] for f in s)})", min(f["op"] for f in s) >= 0.99 and all(f["vinyl"] for f in s))
    check("2 now playing a2", "a2" in page.locator("[data-testid=audio-title]").inner_text() and page.locator("[data-testid=audio-player]").get_attribute("data-track").endswith("a2-小提琴.mp3"))
    check(f"2 track switch replaces the tab ({ntabs} -> {page.locator('[role=tab]').count()})", page.locator("[role=tab]").count() == ntabs)
    shot(page, "2-audio-switched")

    # ---------- 3 video player ----------
    open_file(page, "/示例/媒体/demo.mp4")
    page.wait_for_selector("[data-testid=video-player] .mp"); page.wait_for_timeout(1000)
    v = page.evaluate("""() => { const m = document.querySelector('[data-testid=video-player] .mp'); const p = m.closest('.anim-in');
      const a = m.getBoundingClientRect(), b = p.getBoundingClientRect(), cs = getComputedStyle(m);
      return {w: a.width, pw: b.width, h: a.height, bg: cs.backgroundColor, radius: cs.borderTopLeftRadius, pad: cs.paddingTop}; }""")
    check(f"3 video fills the panel width, not a phone card ({v})", v["w"] >= v["pw"] * 0.85 and v["bg"] in ("rgb(0, 0, 0)",) and v["pad"] == "0px" and v["radius"] == "14px")
    check("3 controls overlay present (seekbar + play)", page.get_by_test_id("seekbar").count() == 1)
    page.locator("[data-testid=video-player] .mp").hover(); page.wait_for_timeout(300)
    shot(page, "3-video-player")

    # ---------- 4 code / text toolbar ----------
    for f, nm in [("/示例/文档/代码/uploads.ts", "4a-code-toolbar"), ("/示例/文档/报告.txt", "4b-text-toolbar")]:
        open_file(page, f)
        page.wait_for_selector("[data-testid=code-toolbar]")
        m = page.evaluate("""() => { const t = document.querySelector('[data-testid=code-toolbar]'); const tb = t.getBoundingClientRect();
          const els = [t.querySelector('[role=combobox]'), ...[...t.querySelectorAll('button')].filter(b => /换行|复制/.test(b.innerText))];
          return {tb: [tb.top, tb.bottom], ctl: els.map(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return {h: r.height, cy: r.top + r.height / 2, top: r.top, bottom: r.bottom, rad: cs.borderTopLeftRadius, key: e.classList.contains('btn-key')}; })}; }""")
        c = m["ctl"]
        check(f"4 {f.rsplit('/',1)[1]}: select + 换行 + 复制 present ({len(c)})", len(c) == 3)
        check(f"4 same height {[round(x['h']) for x in c]} / radius {[x['rad'] for x in c]} / key style", len({round(x["h"]) for x in c}) == 1 and round(c[0]["h"]) == 32 and len({x["rad"] for x in c}) == 1 and all(x["key"] for x in c))
        check(f"4 same row: centers {[round(x['cy'],1) for x in c]} inside toolbar {[round(v) for v in m['tb']]}", max(x["cy"] for x in c) - min(x["cy"] for x in c) < 1 and all(x["top"] >= m["tb"][0] and x["bottom"] <= m["tb"][1] for x in c))
        shot(page, nm)
    tb = page.get_by_test_id("code-toolbar")
    tb.get_by_role("combobox").click(); page.wait_for_timeout(250)
    shot(page, "4c-format-select-open")
    page.get_by_role("listbox").get_by_role("option", name="JavaScript", exact=True).click(); page.wait_for_timeout(300)
    check("4 switching txt -> JavaScript works", page.locator("[data-code-viewer]").get_attribute("data-lang") == "javascript")
    tb.get_by_role("button", name="换行").click(); page.wait_for_timeout(200)
    check("4 wrap toggle pressed state", tb.get_by_role("button", name="换行").get_attribute("aria-pressed") == "true")
    shot(page, "4d-text-as-js-wrap-on")

    bad = [e for e in errors if "favicon" not in e and "net::ERR_ABORTED" not in e and "status of 401" not in e]
    check(f"no console/page errors ({bad[:3]})", not bad)
    br.close()
    api(tok, "DELETE", f"/api/fs?path={TMP}")
print(f"\n{len(fails)} failed" if fails else "\nALL PASS", flush=True)
raise SystemExit(1 if fails else 0)
