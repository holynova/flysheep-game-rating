// FlySheep 评分标签：扩展弹窗交互脚本

const CACHE_KEY = "fgr-cache-v2";

const cacheCountEl = document.getElementById("cache-count");
const clearCacheBtn = document.getElementById("clear-cache-btn");
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const searchBtn = document.getElementById("search-btn");
const searchResultEl = document.getElementById("search-result");
const resultNameEl = document.getElementById("result-name");
const resultTagsEl = document.getElementById("result-tags");

function formatCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return "";
  return count >= 10000 ? `${(count / 10000).toFixed(1)}万` : String(count);
}

function makeTag(tag) {
  const el = document.createElement(tag.href ? "a" : "span");
  el.className = `fgr-tag ${tag.cls}`;
  el.textContent = tag.text;
  el.title = tag.tip || "";
  if (tag.href) {
    el.href = tag.href;
    el.target = "_blank";
    el.rel = "noopener noreferrer";
  }
  return el;
}

function renderTags(container, data) {
  container.textContent = "";
  const tags = [];

  if (data?.steam?.score !== null && data?.steam?.score !== undefined) {
    const countText = formatCount(data.steam.total);
    tags.push({
      cls: `fgr-grade-${data.steam.grade}`,
      text: `Steam ${data.steam.score}%`,
      tip: `${data.steam.name || ""} · ${data.steam.label}${countText ? ` · ${countText}条评测` : ""}`,
      href: data.steam.appid ? `https://store.steampowered.com/app/${data.steam.appid}/` : null
    });
  }
  if (data?.heybox?.score) {
    const heyboxAppid = data.heybox.appid || data.heybox.steamAppid;
    tags.push({
      cls: `fgr-grade-${data.heybox.grade}`,
      text: `小黑盒 ${data.heybox.score}`,
      tip: `小黑盒：${data.heybox.name || ""}`,
      href: heyboxAppid ? `https://www.xiaoheihe.cn/app/topic/game/pc/${heyboxAppid}` : null
    });
  }
  if (!data?.steam && tags.length) {
    tags.push({
      cls: "fgr-grade-none",
      text: data?.errors ? "Steam 失败" : "Steam 未匹配",
      tip: data?.errors ? data.errors.join("；") : "Steam 搜索无结果"
    });
  }
  if (!tags.length) {
    tags.push({
      cls: data?.error ? "fgr-grade-err" : "fgr-grade-none",
      text: data?.error ? "查询失败" : "未收录",
      tip: data?.error || "未匹配到该游戏"
    });
  }

  for (const tag of tags) {
    container.appendChild(makeTag(tag));
  }
}

async function updateCacheCount() {
  try {
    const data = await chrome.storage.local.get(CACHE_KEY);
    const cache = data?.[CACHE_KEY] || {};
    const count = Object.keys(cache).length;
    cacheCountEl.textContent = `${count} 款游戏`;
  } catch {
    cacheCountEl.textContent = "0 款";
  }
}

clearCacheBtn.addEventListener("click", async () => {
  try {
    await chrome.storage.local.remove(CACHE_KEY);
    cacheCountEl.textContent = "已清空";
    clearCacheBtn.textContent = "已清除";
    setTimeout(() => {
      clearCacheBtn.textContent = "清空缓存";
      updateCacheCount();
    }, 1200);
  } catch (e) {
    console.error(e);
  }
});

searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = searchInput.value.trim();
  if (!query) return;

  searchBtn.disabled = true;
  searchBtn.textContent = "查询中…";
  searchResultEl.style.display = "block";
  resultNameEl.textContent = `查询「${query}」…`;
  resultTagsEl.textContent = "";

  const loadingTag = document.createElement("span");
  loadingTag.className = "fgr-tag fgr-grade-none";
  loadingTag.textContent = "正在连接评分接口…";
  resultTagsEl.appendChild(loadingTag);

  try {
    const data = await chrome.runtime.sendMessage({
      type: "FGR_LOOKUP",
      candidates: [query]
    });
    resultNameEl.textContent = data?.steam?.name || data?.heybox?.name || query;
    renderTags(resultTagsEl, data);
    updateCacheCount();
  } catch (err) {
    resultTagsEl.textContent = "";
    const errTag = document.createElement("span");
    errTag.className = "fgr-tag fgr-grade-err";
    errTag.textContent = "查询异常";
    errTag.title = String(err?.message || err);
    resultTagsEl.appendChild(errTag);
  } finally {
    searchBtn.disabled = false;
    searchBtn.textContent = "查询";
  }
});

updateCacheCount();
