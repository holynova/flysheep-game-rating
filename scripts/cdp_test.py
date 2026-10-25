# 用真实 Chrome（--load-extension）实测扩展：列表页 + 详情页注入与配色。
# 用法: python scripts/cdp_test.py [--keep]  （--keep 保留浏览器窗口便于人工复查）
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if sys.stderr and hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

import websocket

CHROME_CANDIDATES = [
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe"),
    os.path.join(os.path.expanduser("~"), ".cache", "puppeteer", "chrome", "win64-150.0.7871.24", "chrome-win64", "chrome.exe"),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
]
EXT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROFILE = os.path.join(tempfile.gettempdir(), "fgr-chrome-test-profile")
PORT = 9333

LIST_URL = "https://www.flysheep6.com/archives/category/pc%e5%8d%95%e6%9c%ba%e5%a4%a7%e4%bd%9c"
DETAIL_URL = "https://www.flysheep6.com/archives/96708"
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs")

_id = 0


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.console_errors = []

    def cmd(self, method, **params):
        global _id
        _id += 1
        mid = _id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        deadline = time.time() + 30
        while time.time() < deadline:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})
            self._collect_event(msg)
        raise RuntimeError(f"{method} timeout")

    def _collect_event(self, msg):
        method = msg.get("method", "")
        if method == "Runtime.consoleAPICalled" and msg["params"].get("type") == "error":
            text = " ".join(str(a.get("value", a.get("description", ""))) for a in msg["params"].get("args", []))
            self.console_errors.append(f"console.error: {text[:200]}")
        elif method == "Log.entryAdded" and msg["params"]["entry"].get("level") in ("error",):
            self.console_errors.append(f"log: {msg['params']['entry'].get('text', '')[:200]}")

    def wait_for_events(self, seconds):
        self.ws.settimeout(0.5)
        deadline = time.time() + seconds
        try:
            while time.time() < deadline:
                try:
                    self._collect_event(json.loads(self.ws.recv()))
                except websocket.WebSocketTimeoutException:
                    pass
        finally:
            self.ws.settimeout(30)

    def evaluate(self, expression, await_promise=False):
        result = self.cmd(
            "Runtime.evaluate",
            expression=expression,
            returnByValue=True,
            awaitPromise=await_promise,
        )
        desc = result.get("exceptionDetails")
        if desc:
            raise RuntimeError(f"evaluate failed: {json.dumps(desc)[:300]}")
        return result.get("result", {}).get("value")


def connect():
    # 本机代理（如 Clash）会劫持 urllib 的 localhost 请求，这里强制直连
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(30):
        try:
            targets = json.load(opener.open(f"http://127.0.0.1:{PORT}/json", timeout=5))
            pages = [t for t in targets if t["type"] == "page"]
            if pages:
                ws = websocket.create_connection(
                    pages[0]["webSocketDebuggerUrl"],
                    timeout=30,
                    suppress_origin=True,  # Chrome 拒绝带 Origin 的 CDP 握手
                )
                return CDP(ws)
        except Exception:
            time.sleep(1)
    raise RuntimeError("无法连接 Chrome CDP")


def wait_tags_ready(cdp, scope, timeout=120):
    """等待 scope 内所有 .fgr-tags 变为 ready，返回 (总数, ready数)。"""
    expr = f"""
    (() => {{
      const tags = document.querySelectorAll('{scope} .fgr-tags');
      const ready = document.querySelectorAll('{scope} .fgr-tags[data-state="ready"]');
      const articles = document.querySelectorAll('{scope} article');
      return {{tags: tags.length, ready: ready.length, articles: articles.length}};
    }})()
    """
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = cdp.evaluate(expr)
        if last["tags"] > 0 and last["ready"] == last["tags"]:
            return last
        cdp.wait_for_events(2)
        time.sleep(1)
    return last


def collect_results(cdp):
    return cdp.evaluate(
        """
    (() => {
      const out = [];
      for (const article of document.querySelectorAll('article')) {
        const title = article.querySelector('h4.entry-title')?.textContent.trim() || '';
        const bar = article.querySelector('.fgr-tags');
        const tags = bar ? [...bar.querySelectorAll('.fgr-tag')].map(t => ({cls: t.className, text: t.textContent, tip: t.title, href: t.href || null})) : [];
        out.push({title: title.slice(0, 60), tags});
      }
      const detailBar = document.querySelector('h3.blog-title')?.nextElementSibling;
      const detail = detailBar?.classList.contains('fgr-tags')
        ? [...detailBar.querySelectorAll('.fgr-tag')].map(t => ({cls: t.className, text: t.textContent}))
        : null;
      return {list: out, detail};
    })()
    """
    )


def screenshot(cdp, name):
    os.makedirs(OUT_DIR, exist_ok=True)
    data = cdp.cmd("Page.captureScreenshot", format="png", captureBeyondViewport=True)
    path = os.path.join(OUT_DIR, name)
    with open(path, "wb") as f:
        f.write(base64.b64decode(data["data"]))
    print(f"  截图: {path}")
    return path


def goto(cdp, url):
    cdp.cmd("Page.navigate", url=url)
    deadline = time.time() + 45
    while time.time() < deadline:
        try:
            info = cdp.evaluate("({s: document.readyState, u: location.href})")
            if info["s"] == "complete" and info["u"].split("#")[0] == url.split("#")[0]:
                return
        except RuntimeError:
            pass
        time.sleep(0.5)
    raise RuntimeError(f"页面加载超时: {url}")


def find_chrome():
    for path in CHROME_CANDIDATES:
        if path and os.path.exists(path):
            return path
    raise RuntimeError("未找到可用的 Chrome/Chromium，且稳定版 Chrome 不支持 --load-extension")


def swdebug(chrome_path):
    """启动浏览器后在扩展 Service Worker 上下文里直接测 fetch，输出真实结果。"""
    chrome_proc = subprocess.Popen(
        [
            chrome_path,
            f"--remote-debugging-port={PORT}",
            f"--user-data-dir={PROFILE}",
            f"--load-extension={EXT}",
            f"--disable-extensions-except={EXT}",
            "--no-first-run",
            "--no-default-browser-check",
            "--window-size=1280,900",
            "about:blank",
        ]
    )
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        browser_ws_url = None
        for _ in range(30):
            try:
                info = json.load(opener.open(f"http://127.0.0.1:{PORT}/json/version", timeout=5))
                browser_ws_url = info["webSocketDebuggerUrl"]
                break
            except Exception:
                time.sleep(1)
        if not browser_ws_url:
            raise RuntimeError("无法连接浏览器 CDP")

        ws = websocket.create_connection(browser_ws_url, timeout=60, suppress_origin=True)
        _id = [0]

        def cmd(method, params=None, session=None):
            _id[0] += 1
            msg = {"id": _id[0], "method": method, "params": params or {}}
            if session:
                msg["sessionId"] = session
            ws.send(json.dumps(msg))
            while True:
                data = json.loads(ws.recv())
                if data.get("id") == _id[0]:
                    if "error" in data:
                        raise RuntimeError(f"{method}: {data['error']}")
                    return data.get("result", {})

        # 等 service worker 目标出现（必须是我们扩展的 background.js，不能抓到系统组件扩展）
        sw = None
        for _ in range(40):
            targets = cmd("Target.getTargets")["targetInfos"]
            sw = [
                t for t in targets
                if t["type"] == "service_worker" and t["url"].startswith("chrome-extension://")
                and ("background.js" in t["url"] or "src/" in t["url"])
            ]
            if sw:
                break
            time.sleep(1)
        if not sw:
            exts = [
                t for t in cmd("Target.getTargets")["targetInfos"]
                if "chrome-extension://" in t.get("url", "")
            ]
            raise RuntimeError(
                "扩展 service worker 未启动（扩展可能未加载）。现有扩展相关 targets: "
                + json.dumps([(t["type"], t["url"]) for t in exts], ensure_ascii=False)
            )
        print(f"SW target: {sw[0]['url']}")
        session = cmd("Target.attachToTarget", {"targetId": sw[0]["targetId"], "flatten": True})["sessionId"]

        expr = """
        (async () => {
          const out = {};
          const tests = {
            storesearch: "https://store.steampowered.com/api/storesearch/?term=hades&l=schinese&cc=cn",
            appreviews: "https://store.steampowered.com/appreviews/1145350?json=1&language=schinese&purchase_type=all&num_per_page=0",
            heybox: "https://api.xiaoheihe.cn/game/search/?os_type=web&version=999.0.0&q=hades"
          };
          for (const [name, url] of Object.entries(tests)) {
            try {
              const t0 = Date.now();
              const r = await fetch(url, {headers: {accept: "application/json,text/plain,*/*"}});
              const text = await r.text();
              out[name] = {status: r.status, redirected: r.redirected, finalUrl: r.url.slice(0, 90), ms: Date.now() - t0, head: text.slice(0, 150)};
            } catch (e) {
              out[name] = {error: String(e).slice(0, 200)};
            }
          }
          return out;
        })()
        """
        result = cmd("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True}, session)
        print(json.dumps(result.get("result", {}).get("value"), ensure_ascii=False, indent=2))
    finally:
        subprocess.run(["taskkill", "/F", "/PID", str(chrome_proc.pid), "/T"], capture_output=True)
        print("SW 调试浏览器已关闭")


def main():
    keep = "--keep" in sys.argv
    attach = "--attach" in sys.argv
    if "--swdebug" in sys.argv:
        swdebug(find_chrome())
        return 0
    chrome_path = find_chrome()
    chrome_proc = None
    if not attach:
        if os.path.exists(PROFILE):
            shutil.rmtree(PROFILE, ignore_errors=True)

        # 只杀本测试启动的 Chrome 进程树，绝不能按映像名杀用户的 Chrome
        chrome_proc = subprocess.Popen(
        [
            chrome_path,
            f"--remote-debugging-port={PORT}",
            f"--user-data-dir={PROFILE}",
            f"--load-extension={EXT}",
            f"--disable-extensions-except={EXT}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-features=ExtensionDisableUnsupportedDeveloper",
            "--window-size=1280,2400",
            "about:blank",
        ]
    )

    try:
        cdp = connect()
        cdp.cmd("Runtime.enable")
        cdp.cmd("Log.enable")
        cdp.cmd("Page.enable")

        sw = cdp.evaluate("navigator.userAgent.includes('Chrome')")
        print(f"Chrome 连接成功 (UA Chrome: {sw})")

        print("\n=== 1. 列表页测试 ===")
        goto(cdp, LIST_URL)
        state = wait_tags_ready(cdp, "body", timeout=150)
        print(f"  文章数: {state['articles']}, 标签条数: {state['tags']}, ready: {state['ready']}")
        time.sleep(2)
        results = collect_results(cdp)
        for item in results["list"]:
            tags = " | ".join(
                f"[{t['text']} ({t['cls'].split('fgr-grade-')[-1]}){'->' + t['href'] if t['href'] else ''}]"
                for t in item["tags"]
            ) or "无标签!"
            print(f"  {item['title']}\n      -> {tags}")
        screenshot(cdp, "test-list-page.png")

        # 校验跳转链接
        linked = [t for item in results["list"] for t in item["tags"] if t["href"]]
        print(f"  可点击跳转的标签数: {len(linked)}")

        print("\n=== 2. 详情页测试 ===")
        goto(cdp, DETAIL_URL)
        deadline = time.time() + 60
        detail = None
        while time.time() < deadline:
            results = collect_results(cdp)
            if results["detail"]:
                detail = results["detail"]
                break
            cdp.wait_for_events(2)
        print(f"  详情页标签: {detail}")
        screenshot(cdp, "test-detail-page.png")

        print("\n=== 3. 弹窗 (Popup) 功能测试 ===")
        targets = cdp.cmd("Target.getTargets")["targetInfos"]
        sw_targets = [t for t in targets if t["type"] == "service_worker" and "background.js" in t.get("url", "")]
        popup_passed = False
        if sw_targets:
            ext_id = sw_targets[0]["url"].split("//")[1].split("/")[0]
            popup_url = f"chrome-extension://{ext_id}/src/popup.html"
            goto(cdp, popup_url)
            time.sleep(1)
            cache_text = cdp.evaluate("document.getElementById('cache-count')?.textContent || ''")
            print(f"  Popup 读取到的缓存状态: {cache_text}")

            # 模拟在独立查分台中查询 Hades
            cdp.evaluate("document.getElementById('search-input').value = 'Hades'")
            cdp.evaluate("document.getElementById('search-btn').click()")

            deadline = time.time() + 20
            popup_tags = []
            while time.time() < deadline:
                tags = cdp.evaluate("[...document.querySelectorAll('#result-tags .fgr-tag')].map(t => t.textContent)")
                if tags and not any("正在" in t for t in tags):
                    popup_tags = tags
                    break
                cdp.wait_for_events(1)
                time.sleep(0.5)
            print(f"  Popup 查分结果: {popup_tags}")
            screenshot(cdp, "test-popup.png")
            popup_passed = bool(popup_tags)

        print("\n=== 4. 控制台错误 ===")
        cdp.wait_for_events(2)
        if cdp.console_errors:
            for e in cdp.console_errors[:20]:
                print(f"  {e}")
        else:
            print("  无错误")

        passed = (
            state["tags"] == state["articles"]
            and state["ready"] == state["tags"]
            and state["tags"] > 0
            and detail
            and popup_passed
        )
        print(f"\n结果: {'PASS' if passed else 'FAIL'}")

        if not keep:
            pass  # 进程在 main 结束后由 finally 清理
        return 0 if passed else 1
    finally:
        if chrome_proc and not keep:
            subprocess.run(["taskkill", "/F", "/PID", str(chrome_proc.pid), "/T"], capture_output=True)
            print("测试 Chrome 已关闭")
        elif chrome_proc:
            print(f"测试 Chrome 保留中 (PID {chrome_proc.pid}, 端口 {PORT})")


if __name__ == "__main__":
    sys.exit(main())
