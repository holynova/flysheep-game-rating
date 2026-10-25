// 后台 Service Worker：负责评分查询、缓存与并发控制。
// 内容脚本只做标题解析与标签注入，所有网络请求集中在这里。

import { getRatings, gradeFromScore } from "./ratings.js";

// v2：v1 缓存于 appreviews 被墙时期写入，缺少 Steam 数据，直接弃用
const CACHE_KEY = "fgr-cache-v2";
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 800;
const MAX_CONCURRENT = 3;

const inflight = new Map();
let active = 0;
const waiting = [];

async function withSlot(task) {
  if (active >= MAX_CONCURRENT) {
    await new Promise((resolve) => waiting.push(resolve));
  }
  active++;
  try {
    return await task();
  } finally {
    active--;
    const next = waiting.shift();
    if (next) next();
  }
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

async function readCache() {
  try {
    const data = await chrome.storage.local.get(CACHE_KEY);
    return data?.[CACHE_KEY] || {};
  } catch {
    return {};
  }
}

async function writeCache(cache) {
  const entries = Object.entries(cache);
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => (b[1].fetchedAt || 0) - (a[1].fetchedAt || 0));
    for (const [key] of entries.slice(MAX_ENTRIES)) delete cache[key];
  }
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  } catch {
    // 存储失败不影响本次返回
  }
}

async function lookup(candidates) {
  const payload = await withSlot(() => getRatings(candidates));
  const steam = payload.steam
    ? {
        ...payload.steam,
        grade: gradeFromScore(payload.steam.score, payload.steam.total || 0)
      }
    : null;
  // 小黑盒搜索接口不返回评分数，数量门槛放行，仅按分数分级
  const heybox = payload.heybox
    ? {
        ...payload.heybox,
        grade: gradeFromScore(Number(payload.heybox.score) * 10, Number.POSITIVE_INFINITY)
      }
    : null;
  const found = Boolean(steam || heybox);
  return { ...payload, steam, heybox, found };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "FGR_LOOKUP") return;

  const key = normalizeKey(message.candidates?.[0] || message.query);
  const request = (async () => {
    const cache = await readCache();
    const hit = cache[key];
    if (hit && Date.now() - hit.fetchedAt < TTL_MS) {
      return { ...hit.data, cached: true };
    }
    const pending = inflight.get(key);
    if (pending) return pending;

    const promise = lookup(message.candidates || [message.query])
      .then(async (data) => {
        const fresh = await readCache();
        fresh[key] = { fetchedAt: Date.now(), data };
        await writeCache(fresh);
        return { ...data, cached: false };
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  })();

  request
    .then(sendResponse)
    .catch((error) => sendResponse({ found: false, error: String(error?.message || error) }));
  return true; // 异步响应
});
