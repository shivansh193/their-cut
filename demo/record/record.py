"""Records the Their Cut demo chapters against the live site with Playwright (real Chrome, for H.264 video).

Runs on Kaggle (CPU, internet on). Each chapter is its own browser context, so each is its own video file.
Key moments are logged to marks.json as seconds from the start of that chapter's recording.
No credentials are used: the app is public and the PayPal steps use the app's own buttons.
"""
import asyncio, json, os, subprocess, sys, time, urllib.request

BASE = os.environ.get("TC_BASE", "https://their-cut.onrender.com")
OUT = "/kaggle/working/rec" if os.path.isdir("/kaggle/working") else os.path.abspath("rec")
os.makedirs(OUT, exist_ok=True)
W, H = 1440, 900
marks: dict[str, dict[str, float]] = {}

CURSOR_JS = """
(() => {
  if (window.__tcCursor) return; window.__tcCursor = true;
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:-50px;top:-50px;width:18px;height:18px;border-radius:50%;background:rgba(45,42,38,.55);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.35);z-index:2147483647;pointer-events:none;transform:translate(-50%,-50%);transition:width .12s,height .12s,background .12s';
  const add = () => document.body && !d.isConnected && document.body.appendChild(d);
  add(); new MutationObserver(add).observe(document.documentElement, {childList:true, subtree:true});
  addEventListener('mousemove', e => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => { d.style.width = d.style.height = '28px'; d.style.background = 'rgba(224,122,95,.6)'; }, true);
  addEventListener('mouseup', () => { d.style.width = d.style.height = '18px'; d.style.background = 'rgba(45,42,38,.55)'; }, true);
})();
"""


def warm():
    for i in range(20):
        try:
            with urllib.request.urlopen(BASE + "/healthz", timeout=60) as r:
                if r.status == 200:
                    print("server warm"); return
        except Exception as e:
            print("warming…", e)
        time.sleep(5)
    sys.exit("server did not wake up")


class Chapter:
    def __init__(self, browser, name, storage=None):
        self.browser, self.name, self.storage = browser, name, storage
        self.m: dict[str, float] = {}

    async def __aenter__(self):
        self.ctx = await self.browser.new_context(
            viewport={"width": W, "height": H}, **({} if os.environ.get("TC_DRY") else {"record_video_dir": f"{OUT}/{self.name}", "record_video_size": {"width": W, "height": H}}), storage_state=self.storage, device_scale_factor=1)
        await self.ctx.add_init_script(CURSOR_JS)
        self.page = await self.ctx.new_page()
        self.t0 = time.monotonic()
        self.x, self.y = W / 2, H / 2
        return self

    def mark(self, key):
        self.m[key] = round(time.monotonic() - self.t0, 2)
        print(f"  [{self.name}] {key} @ {self.m[key]}s")

    async def glide(self, x, y, steps=28):
        await self.page.mouse.move(x, y, steps=steps)
        self.x, self.y = x, y

    async def to(self, locator, click=True, pause=0.6):
        await locator.scroll_into_view_if_needed()
        await asyncio.sleep(0.3)
        b = await locator.bounding_box()
        await self.glide(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)
        await asyncio.sleep(0.25)
        if click:
            await self.page.mouse.down(); await asyncio.sleep(0.08); await self.page.mouse.up()
        await asyncio.sleep(pause)

    async def scroll(self, dy, steps=12, pause=0.5):
        for _ in range(steps):
            await self.page.mouse.wheel(0, dy / steps)
            await asyncio.sleep(0.04)
        await asyncio.sleep(pause)

    async def __aexit__(self, *a):
        await asyncio.sleep(0.8)
        self.storage_out = await self.ctx.storage_state()
        video = self.page.video
        await self.ctx.close()
        if video:
            src = await video.path()
            dst = f"{OUT}/{self.name}.webm"
            os.replace(src, dst)
            print(f"saved {dst}")
        marks[self.name] = self.m


async def main():
    from playwright.async_api import async_playwright
    warm()
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel=None if os.environ.get("TC_DRY") else "chrome", args=["--autoplay-policy=no-user-gesture-required"])

        # ---- ch1: the family, start a deal ----
        async with Chapter(browser, "ch1_deal") as c:
            pg = c.page
            await pg.goto(BASE + "/", wait_until="networkidle")
            await pg.get_by_role("heading", name="The kids", exact=True).wait_for()
            await pg.wait_for_function("[...document.querySelectorAll('img.avatar')].every(i => i.complete && i.naturalWidth > 0)", timeout=30000)
            c.mark("home")
            await asyncio.sleep(2.5)
            await c.glide(700, 420)
            await c.scroll(430, pause=1.0)
            c.mark("kids")
            await c.to(pg.locator(".meter").first, click=False, pause=2.2)
            await c.scroll(520, pause=0.8)
            await c.to(pg.locator(".video-pick button").first, pause=0.8)
            c.mark("picked_video")
            brand = pg.locator(".field input").first
            await c.to(brand, pause=0.2)
            await brand.fill("")
            await pg.keyboard.type("Sunny Oats", delay=70)
            amt = pg.locator(".field input").nth(1)
            await c.to(amt, pause=0.2)
            await amt.fill("")
            await pg.keyboard.type("2500", delay=110)
            await asyncio.sleep(0.6)
            c.mark("filled")
            await c.to(pg.get_by_role("button", name="Start the deal"), pause=0.2)
            await pg.wait_for_url("**/#/deal/**", timeout=30000)
            c.mark("deal_opened")
            deal_url = pg.url
            await asyncio.sleep(1.5)
        storage = c.storage_out
        print("deal", deal_url)

        # ---- ch2: AI watches the video (fresh tab, so the live paint plays) ----
        async with Chapter(browser, "ch2_ai", storage) as c:
            pg = c.page
            await pg.goto(deal_url, wait_until="domcontentloaded")
            await pg.locator(".b-sch-event").first.wait_for(timeout=60000)
            c.mark("paint_start")
            await c.glide(560, 640)
            await asyncio.sleep(5.6)
            c.mark("paint_done")
            await c.scroll(330, pause=0.8)
            c.mark("timeline_full")
            # play the video a few seconds so the playhead moves
            await pg.evaluate("document.querySelector('video').currentTime = 6; document.querySelector('video').muted = true; document.querySelector('video').play()")
            await c.to(pg.locator(".video-wrap"), click=False, pause=0.2)
            await c.scroll(-330, pause=0.2)
            c.mark("video_play")
            await asyncio.sleep(4.5)
            await pg.evaluate("document.querySelector('video').pause()")
            await c.scroll(330, pause=0.6)
            voice = pg.locator(".b-sch-event.tc-voice").first
            await c.to(voice, click=False, pause=0.3)
            c.mark("hover_voice")
            await asyncio.sleep(2.8)
            await c.glide(560, 120)
            await c.scroll(520, pause=1.0)
            c.mark("evidence")
            await asyncio.sleep(2.0)
            await c.scroll(330, pause=0.6)
            q = pg.get_by_text("She always says that.")
            if await q.count():
                await c.to(q.first, click=False, pause=0.3)
            c.mark("quotes")
            await asyncio.sleep(3.0)

        # ---- ch3: the law, applied ----
        async with Chapter(browser, "ch3_law", storage) as c:
            pg = c.page
            await pg.goto(deal_url, wait_until="domcontentloaded")
            card = pg.get_by_role("heading", name="What the law says they're owed")
            await card.wait_for(timeout=60000)
            await pg.wait_for_function("!document.body.innerText.includes('Writing a plain-English explanation')", timeout=90000)
            await card.scroll_into_view_if_needed()
            await pg.evaluate("window.scrollBy(0, -90)")
            await asyncio.sleep(0.8)
            c.mark("law_card")
            await c.to(pg.locator(".child-rows").first, click=False, pause=2.6)
            c.mark("amounts")
            await c.scroll(260, pause=2.4)
            c.mark("explanation")
            await c.scroll(-260, pause=0.4)
            await c.to(pg.locator(".tabs button", has_text="California"), pause=2.6)
            c.mark("california")
            await c.to(pg.locator(".tabs button", has_text="Utah"), pause=2.4)
            c.mark("utah")
            await c.to(pg.locator(".tabs button", has_text="Illinois"), pause=0.8)
            ok = pg.get_by_role("heading", name="Needs your OK")
            await ok.scroll_into_view_if_needed()
            await pg.evaluate("window.scrollBy(0, -120)")
            await c.to(ok, click=False, pause=2.8)
            c.mark("needs_ok")

        # ---- ch4: PayPal moves the money ----
        async with Chapter(browser, "ch4_paypal", storage) as c:
            pg = c.page
            await pg.goto(deal_url, wait_until="domcontentloaded")
            await pg.get_by_text("Money").first.wait_for()
            await pg.locator(".id", has_text="Invoice").wait_for(timeout=60000)
            await pg.evaluate("window.scrollTo(0, 0)")
            await asyncio.sleep(0.8)
            await c.to(pg.locator(".id", has_text="Invoice"), click=False, pause=2.2)
            c.mark("invoice_id")
            payer = await pg.locator("a", has_text="Pay as the brand in PayPal sandbox").get_attribute("href")
            await c.to(pg.locator("a", has_text="Pay as the brand in PayPal sandbox"), click=False, pause=0.6)
            await pg.goto(payer, wait_until="domcontentloaded")
            c.mark("paypal_invoice_page")
            await asyncio.sleep(2.0)
            for label in ["Reject", "Decline", "Reject All"]:
                b = pg.get_by_role("button", name=label)
                if await b.count():
                    await b.first.click(); break
            await asyncio.sleep(4.5)
            await c.scroll(300, pause=1.6)
            c.mark("paypal_invoice_seen")
            await pg.goto(deal_url, wait_until="domcontentloaded")
            sim = pg.get_by_role("button", name="Simulate brand payment (sandbox API)")
            await sim.wait_for(timeout=60000)
            await pg.evaluate("window.scrollTo(0, 0)")
            await asyncio.sleep(0.8)
            c.mark("back_in_app")
            await c.to(sim, pause=0.2)
            c.mark("simulate_click")
            await pg.get_by_text("Paid · needs your OK").first.wait_for(timeout=60000)
            c.mark("paid")
            await asyncio.sleep(1.2)
            appr = pg.get_by_role("button", name="I've checked. Approve and continue")
            await c.to(appr, pause=0.2)
            c.mark("approve_click")
            await pg.evaluate("window.scrollTo({top: 0, behavior: 'smooth'})")
            await pg.locator(".id", has_text="Batch").wait_for(timeout=60000)
            c.mark("payout_batch")
            await c.to(pg.locator(".id", has_text="Batch"), click=False, pause=0.3)
            try:
                await pg.wait_for_function("(document.body.innerText.match(/txn /g) || []).length >= 3", timeout=150000)
            except Exception:
                t = await pg.evaluate("document.body.innerText")
                i = t.find("Batch")
                print("MONEY PANEL:", t[max(0, i - 900): i + 700])
                raise
            c.mark("payouts_success")
            await asyncio.sleep(1.0)
            await pg.wait_for_function("document.body.innerText.includes('Settled')", timeout=120000)
            c.mark("settled")
            await c.to(pg.locator(".id", has_text="txn").first, click=False, pause=3.0)
            # the agent log: wait for the verified webhook line
            log = pg.get_by_role("heading", name="What the agent did")
            await log.scroll_into_view_if_needed()
            await asyncio.sleep(0.5)
            try:
                await pg.wait_for_function("document.body.innerText.includes('Verified PayPal webhook')", timeout=90000)
            except Exception:
                print("  no webhook line yet; reloading once")
                await pg.reload(); await log.wait_for(); await log.scroll_into_view_if_needed()
            await c.to(pg.get_by_text("Verified PayPal webhook").first, click=False, pause=3.2)
            c.mark("webhook_line")

        # ---- ch5: what Mia will see at 18 ----
        async with Chapter(browser, "ch5_ledger", storage) as c:
            pg = c.page
            await pg.goto(BASE + "/#/child/mia", wait_until="domcontentloaded")
            await pg.locator(".ag-row").nth(2).wait_for(timeout=60000)
            await asyncio.sleep(1.0)
            c.mark("ledger")
            await c.to(pg.locator(".ag-row").nth(2), click=False, pause=2.0)
            await pg.evaluate("""(async () => { const v = document.querySelector('.ag-body-horizontal-scroll-viewport, .ag-center-cols-viewport');
              for (let i = 0; i < 40; i++) { v.scrollLeft += 18; await new Promise(r => setTimeout(r, 30)); } })()""")
            await asyncio.sleep(1.8)
            c.mark("ledger_txn")
            await c.to(pg.get_by_text("Record intact").first, click=False, pause=2.5)
            c.mark("record_intact")

        await browser.close()

    with open(f"{OUT}/marks.json", "w") as f:
        json.dump({"base": BASE, "deal_url": deal_url, "marks": marks}, f, indent=2)
    for n in ([] if os.environ.get("TC_DRY") else marks):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", f"{OUT}/{n}.webm", "-c:v", "libx264", "-crf", "21", "-g", "30",
                        "-pix_fmt", "yuv420p", "-r", "30", "-an", "-movflags", "+faststart", f"{OUT}/{n}.mp4"], check=True)
        dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f"{OUT}/{n}.mp4"]).decode())
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", f"{OUT}/{n}.mp4", "-vf", f"fps=16/{dur:.2f},scale=480:-1,tile=4x4",
                        "-frames:v", "1", f"{OUT}/{n}_sheet.jpg"], check=True)
        print(n, f"{dur:.1f}s")


if __name__ == "__main__":
    if os.path.isdir("/kaggle/working"):
        subprocess.run("pip install -q playwright==1.48.0 && python -m playwright install --with-deps chrome", shell=True, check=True)
        if subprocess.run("which ffmpeg", shell=True).returncode:
            subprocess.run("apt-get update -qq && apt-get install -y -qq ffmpeg", shell=True, check=True)
    asyncio.run(main())
