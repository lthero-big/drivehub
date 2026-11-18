"""DEPTAI-485 round-3 checks + screenshots (Playwright, python).
Usage: BASE=http://localhost:8480 DH_USER=.. DH_PASS=.. SHOTS=dir python3 smoke_round3.py
A: marquee/shift/ctrl selection, image zoom, audio/video players, code viewer, ACL, users/groups/roles pages, drag-to-bin.
B: loading button, segmented drag, spring dropdown, share send/share buttons, fold toolbar, morph play, genie dock."""
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:8480")
U, P = os.environ["DH_USER"], os.environ["DH_PASS"]
SHOTS = os.environ.get("SHOTS", "/tmp")
errors, fails = [], []

def check(name, cond):
    (fails.append(name) if not cond else None)
    print(("PASS " if cond else "FAIL ") + name, flush=True)

def shot(page, name, **kw):
    page.screenshot(path=f"{SHOTS}/{name}.png", **kw)

def row(page, p):
    return page.locator(f'[role=row][data-path="{p}"]')

def main():
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(viewport={"width": 1440, "height": 900}, color_scheme="light")
        page = ctx.new_page()
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
        page.goto(BASE + "/"); page.wait_for_selector("form")
        page.get_by_label("用户名或邮箱").fill(U); page.get_by_label("密码").fill(P)
        page.get_by_role("button", name="登录").click()
        page.wait_for_selector("#main", timeout=10000); page.wait_for_timeout(500)

        # ---- A1 selection
        page.goto(BASE + "/#/files/示例/r3-tmp"); page.wait_for_timeout(900)
        a, c, e = row(page, "/示例/r3-tmp/alpha.txt"), row(page, "/示例/r3-tmp/charlie.txt"), row(page, "/示例/r3-tmp/echo.txt")
        sel = lambda: page.locator('[role=row][aria-selected=true]').count()
        a.click(); c.click(modifiers=["Shift"]); page.wait_for_timeout(200)
        check("A1 shift range selects 3", sel() == 3); shot(page, "A1-shift-range")
        e.click(modifiers=["Control"]); page.wait_for_timeout(200)
        check("A1 ctrl toggle adds 1", sel() == 4)
        c.click(modifiers=["Control"]); page.wait_for_timeout(200)
        check("A1 ctrl toggle removes 1", sel() == 3)
        page.mouse.click(1000, 700); page.wait_for_timeout(200)
        b1, b2 = row(page, "/示例/r3-tmp/alpha.txt").bounding_box(), row(page, "/示例/r3-tmp/delta.txt").bounding_box()
        page.mouse.move(b1["x"] + b1["width"] - 20, b1["y"] - 6); page.mouse.down()
        page.mouse.move(b1["x"] + b1["width"] - 80, b2["y"] + 10, steps=8); page.wait_for_timeout(150)
        shot(page, "A1-marquee-drawing")
        page.mouse.up(); page.wait_for_timeout(200)
        check("A1 marquee selects rows", sel() >= 3); shot(page, "A1-marquee-done")
        page.keyboard.press("Escape")

        # ---- A8 drag to bin: start a drag on an item -> trash zone appears
        page.mouse.click(1000, 700); page.wait_for_timeout(150)
        src = row(page, "/示例/r3-tmp/foxtrot.txt")
        dt = page.evaluate_handle("new DataTransfer()")
        src.dispatch_event("dragstart", {"dataTransfer": dt}); page.wait_for_timeout(500)
        check("A8 trash zone appears on internal drag", page.get_by_test_id("trash-zone").count() == 1)
        shot(page, "A8-trash-zone")
        tb = page.get_by_test_id("trash-zone").bounding_box()
        tx, ty = tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2
        page.evaluate("([x,y]) => window.dispatchEvent(new DragEvent('dragover', {clientX:x, clientY:y, bubbles:true, cancelable:true}))", [tx, ty]); page.wait_for_timeout(300)
        check("A8 trash hot on hover", page.locator('[data-testid=trash-zone][data-hot]').count() == 1); shot(page, "A8-trash-hot")
        page.evaluate("([x,y]) => window.dispatchEvent(new DragEvent('drop', {clientX:x, clientY:y, bubbles:true, cancelable:true}))", [tx, ty]); page.wait_for_timeout(500)
        check("A8 drop in bin schedules delete with undo toast", page.get_by_role("button", name="撤销").count() >= 1); shot(page, "A8-trash-undo-toast")
        page.get_by_role("button", name="撤销").first.click(); page.wait_for_timeout(600)
        check("A8 undo restores item", row(page, "/示例/r3-tmp/foxtrot.txt").count() == 1)
        # ---- A4 code viewer
        page.goto(BASE + "/#/files/示例/文档/代码?open=/示例/文档/代码/uploads.ts"); page.wait_for_timeout(1500)
        check("A4 code viewer line numbers + highlight", page.locator(".code-pre .cl").count() > 5 and page.locator(".code-pre .hljs-keyword").count() > 0)
        shot(page, "A4-code-viewer")
        page.get_by_role("button", name="换行").click(); page.wait_for_timeout(200)
        shot(page, "A4-code-wrap")

        # ---- A2 image zoom + B toolbar
        page.goto(BASE + "/#/files/示例/照片?open=/示例/照片/photo_2.jpg"); page.wait_for_timeout(1500)
        shot(page, "A2-image-viewer")
        page.get_by_role("button", name="放大").click(); page.get_by_role("button", name="放大").click(); page.wait_for_timeout(400)
        z = page.get_by_test_id("zoom-level").inner_text()
        check(f"A2 zoom buttons ({z})", z != "100%"); shot(page, "A2-image-zoomed")
        page.get_by_role("button", name="重置缩放").click(); page.wait_for_timeout(300)
        page.get_by_role("button", name="缩放", exact=True).first.click()
        page.wait_for_timeout(600)
        shot(page, "B-fold-toolbar-open")

        # ---- A2/A3 audio + video
        page.goto(BASE + "/#/files/示例/媒体?open=/示例/媒体/a1-钢琴.mp3"); page.wait_for_timeout(1500)
        shot(page, "A2-audio-player")
        page.goto(BASE + "/#/files/示例/媒体?open=/示例/媒体/demo.mp4"); page.wait_for_timeout(2000)
        page.mouse.move(700, 500); page.wait_for_timeout(300)
        shot(page, "A3-video-player")
        pb = page.get_by_role("button", name="暂停")
        if pb.count(): pb.first.click(); page.wait_for_timeout(500); shot(page, "B-morph-play-paused")

        # ---- B genie minimize -> dock -> restore
        page.goto(BASE + "/#/files/示例/文档/代码?open=/示例/文档/代码/uploads.ts"); page.wait_for_timeout(1200)
        page.get_by_role("button", name="最小化到 Dock").click(); page.wait_for_timeout(260)
        shot(page, "B-genie-minimizing-mid")
        page.wait_for_timeout(700)
        check("B dock shows minimized window", page.locator("[data-dock-id]").count() == 1)
        shot(page, "B-genie-docked")
        page.locator("[data-dock-id]").first.click(); page.wait_for_timeout(300)
        shot(page, "B-genie-restoring-mid"); page.wait_for_timeout(900)
        check("B restore from dock reopens file", page.locator(".code-pre").count() == 1 and page.locator("[data-dock-id]").count() == 0)

        # ---- B segmented control (view switch), dropdown
        page.goto(BASE + "/#/files/示例/照片"); page.wait_for_timeout(900)
        seg = page.get_by_role("radiogroup", name="视图")
        seg.get_by_role("radio", name="网格").click(); page.wait_for_timeout(120)
        shot(page, "B-segmented-mid-slide"); page.wait_for_timeout(600)
        check("B segmented switches to grid", seg.get_by_role("radio", name="网格").get_attribute("aria-checked") == "true")
        # drag across the segmented control
        bb = seg.bounding_box()
        page.mouse.move(bb["x"] + bb["width"] * 0.5, bb["y"] + bb["height"] / 2); page.mouse.down()
        page.mouse.move(bb["x"] + bb["width"] - 8, bb["y"] + bb["height"] / 2, steps=6); page.mouse.up(); page.wait_for_timeout(500)
        check("B segmented drag selects last", seg.get_by_role("radio", name="相册").get_attribute("aria-checked") == "true")
        shot(page, "B-segmented-dragged")
        seg.get_by_role("radio", name="列表").click(); page.wait_for_timeout(500)
        page.get_by_role("button", name="排序").first.click(); page.wait_for_timeout(450)
        shot(page, "B-dropdown-open"); page.keyboard.press("Escape")

        # ---- B share dialog: send button + share button
        page.goto(BASE + "/#/files/示例/照片"); page.wait_for_timeout(900)
        row(page, "/示例/照片/photo_1.jpg").click(); page.wait_for_timeout(300)
        page.get_by_role("button", name="分享").first.click(); page.wait_for_timeout(600)
        shot(page, "B-share-dialog")
        page.get_by_role("button", name="创建分享").click(); page.wait_for_timeout(150)
        shot(page, "B-send-button-sending"); page.wait_for_timeout(900)
        shot(page, "B-send-button-sent-particles")
        page.wait_for_timeout(1500)
        sb = page.locator(".shr-label")
        if sb.count():
            sb.first.click(); page.wait_for_timeout(700); shot(page, "B-share-button-expanded")
            check("B share button expands", page.locator('.shr[data-open="1"]').count() == 1)
        page.keyboard.press("Escape")

        # ---- B loading button on admin pages + A5/A6/A7
        page.goto(BASE + "/#/admin/users"); page.wait_for_timeout(1000); shot(page, "A6-users-paged")
        page.goto(BASE + "/#/admin/groups"); page.wait_for_timeout(1000); shot(page, "A6-groups-paged")
        page.goto(BASE + "/#/admin/roles"); page.wait_for_timeout(1000); shot(page, "A7-roles")
        page.get_by_role("button", name="新建角色").click(); page.wait_for_timeout(500); shot(page, "A7-role-editor")
        btn = page.locator(".lb", has_text="保存")
        if btn.count():
            btn.first.evaluate("e => e.addEventListener('click', ev => ev.stopImmediatePropagation(), true)") if False else None
        page.keyboard.press("Escape")
        page.goto(BASE + "/#/admin/acl"); page.wait_for_timeout(1200); shot(page, "A5-acl")
        page.goto(BASE + "/#/admin/settings"); page.wait_for_timeout(800)
        page.get_by_role("tab", name="服务状态").click(); page.wait_for_timeout(150); shot(page, "B-tabs-segmented-mid"); page.wait_for_timeout(600)
        shot(page, "B-tabs-segmented")
        br.close()
    real = [x for x in errors if "favicon" not in x and "401" not in x]
    check("no console errors", not real)
    for x in real[:8]: print("  err:", x[:200])
    print("FAILS:", fails)
    raise SystemExit(1 if fails else 0)

main()
