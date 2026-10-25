// 内容脚本：解析 flysheep6.com 页面上的游戏标题，注入评分标签。
// 列表页标题形如：【VBS】无主之地4（Borderlands 4）v1.11全DLC豪华中文版
// 详情页标题为 h3.blog-title，列表页为 article > h4.entry-title。

(() => {
  const processed = new WeakSet();

  const LEADING_TAG_RE = /(?:【[^】]*】|\[[^\]]*\])/g;
  const EMOJI_RE = /\p{Extended_Pictographic}/gu;
  const PAREN_RE = /[（(]\s*([^（()）]+?)\s*[）)]/g;
  // 结尾的版本号 / 汉化组 / DLC / 发布组等修饰词，循环剥离直到不再变化
  const TAIL_RE =
    /(?:\s*(?:v\d+(?:\.\d+)*[a-z]?|免安装|全DLC|学习版|免DVD|RUNE|TENOKE|FLT|CODEX|DOGE|SKIDROW|集成|豪华|中文版|中文|解锁|完整版?|官方|正版|PC|绿色版|单机版|汉化版|最终版|典藏版))+\s*$/i;

  function extractCandidates(rawTitle) {
    let text = String(rawTitle || "").replace(/\s+/g, " ").trim();
    text = text.replace(LEADING_TAG_RE, " ").replace(EMOJI_RE, " ").replace(/\s+/g, " ").trim();
    if (!text) return [];

    const parenMatches = [...text.matchAll(PAREN_RE)];
    const english = parenMatches
      .map((match) => match[1].trim())
      .filter((value) => /^[a-z0-9]/i.test(value) && /[a-z]/i.test(value));

    let zh = text.replace(PAREN_RE, " ").trim();
    let previous;
    do {
      previous = zh;
      zh = zh.replace(TAIL_RE, "").replace(/\s+/g, " ").trim();
    } while (zh !== previous && zh);

    const candidates = [];
    if (zh && zh.length >= 2) candidates.push(zh);
    for (const name of english) {
      if (name.length >= 2 && !candidates.some((item) => item.toLowerCase() === name.toLowerCase())) {
        candidates.push(name);
      }
    }
    return candidates;
  }

  function getTitleTargets() {
    const targets = [];

    const detailTitle = document.querySelector("h3.blog-title");
    if (detailTitle && !processed.has(detailTitle)) {
      targets.push({ mountAfter: detailTitle, title: detailTitle.textContent, isDetail: true });
    }

    for (const article of document.querySelectorAll("article")) {
      if (article.dataset.fgr) continue;
      const titleEl = article.querySelector("h4.entry-title");
      if (!titleEl || processed.has(titleEl)) continue;
      targets.push({ mountAfter: titleEl, title: titleEl.textContent, article });
    }
    return targets;
  }

  function createLoadingBar() {
    const bar = document.createElement("div");
    bar.className = "fgr-tags";
    bar.dataset.state = "loading";
    const placeholder = document.createElement("span");
    placeholder.className = "fgr-tag fgr-grade-none";
    placeholder.textContent = "评分加载中…";
    bar.appendChild(placeholder);
    return bar;
  }

  function formatCount(value) {
    const count = Number(value);
    if (!Number.isFinite(count) || count <= 0) return "";
    return count >= 10000 ? `${(count / 10000).toFixed(1)}万` : String(count);
  }

  function makeTag(tag) {
    const el = document.createElement(tag.href ? "a" : "span");
    el.className = `fgr-tag ${tag.cls}`;
    el.textContent = tag.text;
    el.title = tag.tip;
    if (tag.href) {
      el.href = tag.href;
      el.target = "_blank";
      el.rel = "noopener noreferrer";
    }
    return el;
  }

  function render(bar, data) {
    bar.textContent = "";
    bar.dataset.state = "ready";
    const tags = [];

    if (data?.steam?.score !== null && data?.steam?.score !== undefined) {
      const countText = formatCount(data.steam.total);
      tags.push({
        cls: `fgr-grade-${data.steam.grade}`,
        text: `Steam ${data.steam.score}%`,
        tip: `${data.steam.name || ""} · ${data.steam.label}${countText ? ` · ${countText}条评测` : ""} · 点击打开 Steam 商店页`,
        href: data.steam.appid ? `https://store.steampowered.com/app/${data.steam.appid}/` : null
      });
    }
    if (data?.heybox?.score) {
      const heyboxAppid = data.heybox.appid || data.heybox.steamAppid;
      tags.push({
        cls: `fgr-grade-${data.heybox.grade}`,
        text: `小黑盒 ${data.heybox.score}`,
        tip: `小黑盒匹配：${data.heybox.name || ""} · 点击打开小黑盒页面`,
        href: heyboxAppid ? `https://www.xiaoheihe.cn/app/topic/game/pc/${heyboxAppid}` : null
      });
    }
    // 有小黑盒但 Steam 缺失时给出可见的提示，而不是静默不显示
    if (!data?.steam && tags.length) {
      tags.push({
        cls: "fgr-grade-none",
        text: data?.errors ? "Steam 失败" : "Steam 未匹配",
        tip: data?.errors ? data.errors.join("；") : "Steam 搜索无匹配结果"
      });
    }
    if (!tags.length) {
      tags.push({
        cls: data?.error ? "fgr-grade-err" : "fgr-grade-none",
        text: data?.error ? "查询失败" : "未收录",
        tip: data?.error || "Steam 与小黑盒均未匹配到该游戏"
      });
    }

    for (const tag of tags) {
      bar.appendChild(makeTag(tag));
    }
  }

  async function process(target) {
    const candidates = extractCandidates(target.title);
    if (!candidates.length) return;

    const bar = createLoadingBar();
    target.mountAfter.insertAdjacentElement("afterend", bar);

    try {
      const data = await chrome.runtime.sendMessage({ type: "FGR_LOOKUP", candidates });
      render(bar, data);
    } catch (error) {
      render(bar, { error: String(error?.message || error) });
    }
  }

  function scan() {
    for (const target of getTitleTargets()) {
      processed.add(target.mountAfter);
      if (target.article) target.article.dataset.fgr = "1";
      process(target);
    }
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 400);
  }

  scan();
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
