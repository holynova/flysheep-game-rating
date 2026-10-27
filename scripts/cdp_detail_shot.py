# 对详情页 h3.blog-title 及其评分标签条做定位截图（避免整页截图过高无法目检）。
# 用法: python scripts/cdp_detail_shot.py
import base64
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp_test import EXT, PROFILE, PORT, CDP, connect, find_chrome, goto

DETAIL_URL = "https://www.flysheep6.com/archives/96708"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "test-detail-title.png")


def main():
    chrome_path = find_chrome()
    shutil.rmtree(PROFILE, ignore_errors=True)
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
        cdp = connect()
        cdp.cmd("Runtime.enable")
        cdp.cmd("Page.enable")
        goto(cdp, DETAIL_URL)

        deadline = time.time() + 90
        box = None
        while time.time() < deadline:
            box = cdp.evaluate(
                """
                (() => {
                  const t = document.querySelector('h3.blog-title');
                  const bar = t && t.nextElementSibling;
                  if (!bar || !bar.classList.contains('fgr-tags') || bar.dataset.state !== 'ready') return null;
                  const rt = t.getBoundingClientRect();
                  const rb = bar.getBoundingClientRect();
                  const top = Math.min(rt.top, rb.top) - 24;
                  const bottom = Math.max(rt.bottom, rb.bottom) + 24;
                  return {
                    x: Math.max(0, Math.min(rt.left, rb.left) - 40),
                    y: top + window.scrollY,
                    w: Math.ceil(Math.max(rt.right, rb.right) - Math.min(rt.left, rb.left)) + 80,
                    h: Math.ceil(bottom - top),
                    tags: [...bar.querySelectorAll('.fgr-tag')].map(e => e.textContent)
                  };
                })()
                """
            )
            if box:
                break
            time.sleep(2)
        if not box:
            raise RuntimeError("详情页标签条未就绪")

        # 站点内容懒渲染，先滚到标题处让真实内容绘制，再截视口
        cdp.evaluate(
            f"window.scrollTo(0, {int(box['y'])}); document.body.scrollHeight"
        )
        time.sleep(3)
        data = cdp.cmd("Page.captureScreenshot", format="png")
        with open(OUT, "wb") as f:
            f.write(base64.b64decode(data["data"]))
        print(f"标签: {box['tags']}")
        print(f"截图(全视口): {OUT}")
        return 0
    finally:
        subprocess.run(["taskkill", "/F", "/PID", str(chrome_proc.pid), "/T"], capture_output=True)
        print("测试 Chrome 已关闭")


if __name__ == "__main__":
    sys.exit(main())
