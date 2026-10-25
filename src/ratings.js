// 评分查询核心逻辑，移植自 holynova/game-rating-lookup（MIT）。
// 数据源：Steam 商店搜索 / 评测摘要接口，小黑盒游戏搜索接口。

const STEAM_LABELS = {
  "Overwhelmingly Positive": "好评如潮",
  "Very Positive": "特别好评",
  Positive: "好评",
  "Mostly Positive": "多半好评",
  Mixed: "褒贬不一",
  "Mostly Negative": "多半差评",
  Negative: "差评",
  "Very Negative": "特别差评",
  "Overwhelmingly Negative": "差评如潮",
  "No user reviews": "暂无用户评测"
};

// matchScore 低于该值的搜索结果视为不相关，避免张冠李戴
const MIN_MATCH_SCORE = 55;

export function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2122\u00ae\u00a9:：'"`\u2018\u2019\u201c\u201d()[\]{}.,，。!！?？\-_\s]/g, "")
    .replace(/demo|试玩版|试用版|ost|soundtrack|原声带/g, "");
}

export function scoreName(query, candidate) {
  const q = normalizeTitle(query);
  const c = normalizeTitle(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (c.includes(q) || q.includes(c)) {
    const ratio = Math.min(q.length, c.length) / Math.max(q.length, c.length);
    return Math.round(50 + ratio * 30);
  }

  const qChars = new Set([...q]);
  let overlap = 0;
  for (const char of c) {
    if (qChars.has(char)) overlap += 1;
  }
  return Math.round((overlap / Math.max(q.length, c.length)) * 70);
}

function exactTitleBoost(query, candidate) {
  return normalizeTitle(query) === normalizeTitle(candidate) ? 45 : 0;
}

function secondaryTitlePenalty(name) {
  const value = String(name || "").toLowerCase();
  const secondaryTerms = ["redmod", "bonus content", "soundtrack", "demo", "dlc", "ost"];
  return secondaryTerms.some((term) => value.includes(term)) ? 55 : 0;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json,text/plain,*/*" }
    });
    if (!response.ok) throw new Error(`${response.status} from ${url.hostname}`);
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`查询超时: ${url.hostname}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "text/html,*/*" }
    });
    if (!response.ok) throw new Error(`${response.status} from ${url.hostname}`);
    return await response.text();
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`查询超时: ${url.hostname}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchSteam(query) {
  const url = new URL("https://store.steampowered.com/api/storesearch/");
  url.searchParams.set("term", query);
  url.searchParams.set("l", "schinese");
  url.searchParams.set("cc", "cn");

  const data = await fetchJson(url);
  const items = Array.isArray(data.items) ? data.items : [];
  const ranked = items
    .filter((item) => item?.id && item?.name)
    .map((item, index) => ({
      ...item,
      matchScore:
        scoreName(query, item.name) +
        exactTitleBoost(query, item.name) +
        Math.max(0, 90 - index * 20) -
        secondaryTitlePenalty(item.name)
    }))
    .sort((a, b) => b.matchScore - a.matchScore);

  return ranked[0] || null;
}

export async function getSteamReviews(appid) {
  try {
    return await getSteamReviewsApi(appid);
  } catch (error) {
    // appreviews 接口在某些网络环境下会被 302 到商店首页（评测数据墙），回退到商店页解析
    try {
      return await getSteamReviewsFromStorePage(appid);
    } catch (fallbackError) {
      throw new Error(`${error.message}; 商店页回退: ${fallbackError.message}`);
    }
  }
}

async function getSteamReviewsApi(appid) {
  const url = new URL(`https://store.steampowered.com/appreviews/${appid}`);
  url.searchParams.set("json", "1");
  url.searchParams.set("language", "schinese");
  url.searchParams.set("purchase_type", "all");
  url.searchParams.set("num_per_page", "0");

  const response = await fetch(url, {
    headers: { accept: "application/json,text/plain,*/*" },
    signal: AbortSignal.timeout(15000)
  });
  // 被重定向到商店首页时拿到的是 HTML 而非评测 JSON，视为失败
  if (!response.ok || response.redirected) {
    throw new Error(`appreviews ${response.status}${response.redirected ? "(被重定向)" : ""}`);
  }
  const data = await response.json();
  const summary = data.query_summary || {};
  const positive = Number(summary.total_positive || 0);
  const negative = Number(summary.total_negative || 0);
  const total = Number(summary.total_reviews || positive + negative || 0);
  const label = summary.review_score_desc || STEAM_LABELS[summary.review_score_desc] || "暂无用户评测";

  return {
    appid,
    label,
    positive,
    negative,
    total,
    score: total > 0 ? Math.round((positive / Math.max(total, 1)) * 100) : null
  };
}

// 从商店页侧栏解析总评：好评率%、评测数、评价标签（与界面语言无关的正则）。
// 行结构：<a class="user_reviews_summary_row" data-tooltip-html="96% of the ... positive">
//           <span class="game_review_summary ...">Overwhelmingly Positive</span>
//           <span class="responsive_hidden"> (66,162) </span> ...
const ROW_RE =
  /<a[^>]*user_reviews_summary_row[^>]*data-tooltip-html="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
const LABEL_RE = /game_review_summary[^>]*>([^<]+)</;
const COUNT_RE = /responsive_hidden">\s*\(([\d,\s]+)\)/;
const RECENT_RE = /last 30 days|最近 ?30 ?天|最近30日内/;

function parseStoreReviewRows(html) {
  const rows = [];
  for (const match of String(html || "").matchAll(ROW_RE)) {
    const [, tooltip, body] = match;
    const labelMatch = body.match(LABEL_RE);
    const countMatch = body.match(COUNT_RE);
    const percentMatch = tooltip.match(/(\d+)%/);
    if (!labelMatch || !percentMatch) continue;
    const count = countMatch ? Number(countMatch[1].replace(/[,\s]/g, "")) : 0;
    rows.push({
      label: labelMatch[1].trim(),
      count,
      percent: Number(percentMatch[1]),
      recent: RECENT_RE.test(tooltip)
    });
  }
  return rows;
}

async function getSteamReviewsFromStorePage(appid) {
  const url = `https://store.steampowered.com/app/${appid}/?l=schinese`;
  const html = await fetchText(url);
  const rows = parseStoreReviewRows(html);
  // 过滤掉“最近 30 天”行后取评测数最多的一行（即总评）
  const all = rows
    .filter((row) => !row.recent && row.count > 0)
    .sort((a, b) => b.count - a.count)[0];
  if (!all) throw new Error("商店页未找到总评数据");

  return {
    appid,
    label: STEAM_LABELS[all.label] || all.label,
    positive: 0,
    negative: 0,
    total: all.count,
    score: all.percent
  };
}

export async function searchHeybox(query, steamAppid = null) {
  const url = new URL("https://api.xiaoheihe.cn/game/search/");
  url.searchParams.set("os_type", "web");
  url.searchParams.set("version", "999.0.0");
  url.searchParams.set("q", query);

  const data = await fetchJson(url);
  const games = Array.isArray(data.result?.games) ? data.result.games : [];
  const ranked = games
    .filter((game) => game?.name && (game.score || game.score_desc))
    .map((game, index) => {
      const appid = Number(game.steam_appid || game.appid || 0);
      const exactAppidMatch = steamAppid && appid === Number(steamAppid);
      const typeBoost = game.type === "game" ? 12 : 0;
      const platformBoost =
        Array.isArray(game.platforms) && game.platforms.includes("steam") ? 8 : 0;
      return {
        ...game,
        matchScore:
          (exactAppidMatch ? 120 : 0) +
          scoreName(query, game.name) +
          exactTitleBoost(query, game.name) +
          Math.max(0, 50 - index * 10) -
          secondaryTitlePenalty(game.name) +
          typeBoost +
          platformBoost
      };
    })
    .sort((a, b) => b.matchScore - a.matchScore)
    .filter((game) => game.matchScore >= MIN_MATCH_SCORE);

  const match = ranked[0];
  if (!match) return null;

  // 小黑盒对 Steam 游戏维护着准确的 steam_appid 映射，比 Steam 中文搜索可靠
  const steamCandidate = ranked.find(
    (game) => Array.isArray(game.platforms) && game.platforms.includes("steam")
  );

  return {
    appid: match.appid || null,
    steamAppid: match.steam_appid || null,
    platforms: Array.isArray(match.platforms) ? match.platforms : null,
    name: match.name,
    score: match.score || null,
    scoreText: match.score || match.score_desc || null,
    steamAppidSuggestion: steamCandidate
      ? {
          appid: Number(steamCandidate.steam_appid || steamCandidate.appid || 0) || null,
          matchScore: steamCandidate.matchScore
        }
      : null
  };
}

// 暗黑装备色阶：金(传奇) / 紫(史诗) / 蓝(稀有) / 绿(优秀) / 白(普通)
// 评分换算为百分制；count 为评测数，未知时传 Infinity 放行数量门槛。
export function gradeFromScore(score100, count = 0) {
  if (score100 === null || score100 === undefined || Number.isNaN(score100)) return "white";
  if (score100 >= 95 && count >= 500) return "gold";
  if (score100 >= 85 && count >= 50) return "purple";
  if (score100 >= 75) return "blue";
  if (score100 >= 60) return "green";
  return "white";
}

// candidates：按优先级排列的游戏名候选（中文主名优先，英文括号名兜底）。
export async function getRatings(candidates) {
  const queries = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean);
  let usedQuery = null;
  let steam = null;
  let heybox = null;
  let matched = null;
  const errors = [];

  for (const query of queries) {
    let steamApp = null;
    try {
      steamApp = await searchSteam(query);
    } catch (error) {
      errors.push(`Steam搜索: ${error.message}`);
    }

    try {
      heybox = await searchHeybox(query, steamApp?.id);
    } catch (error) {
      errors.push(`小黑盒: ${error.message}`);
      heybox = null;
    }

    let targetAppid = null;
    let targetName = null;
    let via = null;

    if (steamApp && (exactTitleBoost(query, steamApp.name) || scoreName(query, steamApp.name) >= 60)) {
      targetAppid = steamApp.id;
      targetName = steamApp.name;
      via = "steam";
    } else {
      const suggestion = heybox?.steamAppidSuggestion;
      const heyboxSteamAppid =
        suggestion && suggestion.appid && suggestion.matchScore >= 60
          ? Number(suggestion.appid)
          : 0;
      if (heyboxSteamAppid) {
        targetAppid = heyboxSteamAppid;
        targetName = heybox.name;
        via = "heybox";
      }
    }

    if (targetAppid) {
      try {
        steam = await getSteamReviews(targetAppid);
        matched = { appid: targetAppid, name: targetName, via };
      } catch (error) {
        errors.push(`Steam评测: ${error.message}`);
        steam = null;
      }
    }

    if (steam || heybox) {
      usedQuery = query;
      break;
    }
  }

  return {
    query: usedQuery || queries[0] || "",
    matched,
    steam,
    heybox: heybox && heybox.score ? heybox : null,
    errors: errors.length ? errors : null
  };
}
