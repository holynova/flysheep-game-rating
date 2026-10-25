# flysheep-game-rating

Chrome 扩展（MV3，原生 JS，无构建步骤）：为 flysheep6.com 游戏页面注入 Steam / 小黑盒评分标签，暗黑装备色阶。

## 关键事实

- 直接「加载已解压的扩展程序」指向本目录即可，无 npm 依赖、无构建。
- 包含独立工具栏弹窗 Popup (`src/popup.html`)，支持独立查分与缓存清除。
- 评分核心移植自 `G:\code\game-rating-lookup`（同一作者），支持 Steam storesearch/appreviews + 小黑盒 game/search 接口交叉索引。
- 小黑盒 API 无需 Referer（已实测），故未用 declarativeNetRequest。
- 页面结构：列表页 `article > h4.entry-title`，详情页 `h3.blog-title`；标题含【VBS】前缀、括号英文名、v1.x/全DLC/免安装等后缀，`src/content.js` 的 `extractCandidates` 负责清洗。

## 验证

```powershell
python scripts/cdp_test.py          # 启动独立 Chrome 实例（--load-extension）实测列表页+详情页，截图到 docs/
python scripts/cdp_test.py --keep   # 保留窗口人工复查
python scripts/make_icons.py        # 重新生成图标
```

cdp_test 需要本机 websocket-client（`pip install websocket-client`）与 `C:\Program Files\Google\Chrome\Application\chrome.exe`。
