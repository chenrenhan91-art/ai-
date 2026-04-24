import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";

// 自动加载 .env 文件（优先使用系统环境变量）
const ENV_FILE = new URL("../.env", import.meta.url);
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const ROOT = new URL("../", import.meta.url);
const SOURCES_URL = new URL("sources.json", ROOT);
const OUTPUT_URL = new URL("news-feed.json", ROOT);
const MAX_ITEMS_PER_SOURCE = 12;
const MAX_OUTPUT_ITEMS = 60;
const FEED_TIMEOUT_MS = 18000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_TIMEOUT_MS = 30000;

const AI_KEYWORDS = [
  "ai", "artificial intelligence", "llm", "large language model", "language model",
  "openai", "chatgpt", "gpt", "claude", "anthropic", "gemini", "deepmind",
  "hugging face", "transformer", "diffusion", "agent", "agentic", "mcp",
  "prompt", "inference", "training", "fine-tuning", "eval", "benchmark",
  "model", "reasoning", "robotics", "copilot", "cursor", "devin", "sora",
  "llama", "mistral", "qwen", "deepseek", "gemma", "multimodal", "rag",
  "人工智能", "大模型", "模型", "智能体", "生成式", "机器学习"
];

const CATEGORY_RULES = [
  ["security", ["safety", "security", "cyber", "policy", "governance", "alignment", "risk", "安全", "治理"]],
  ["open", ["open source", "open-source", "hugging face", "llama", "mistral", "qwen", "deepseek", "gemma", "开源"]],
  ["research", ["research", "paper", "benchmark", "eval", "science", "robotics", "deepmind", "研究", "论文", "机器人"]],
  ["product", ["release", "launch", "introducing", "product", "app", "api", "feature", "chatgpt", "claude", "gemini", "发布"]],
  ["model", ["model", "llm", "gpt", "reasoning", "multimodal", "inference", "模型", "推理"]]
];

const CREATOR_TITLE_KEYWORDS = [
  "ai", "ainews", "llm", "gpt", "chatgpt", "claude", "openai", "anthropic",
  "gemini", "deepmind", "model", "agent", "agentic", "mcp", "prompt",
  "inference", "training", "eval", "benchmark", "transformer", "diffusion",
  "qwen", "deepseek", "mistral", "llama", "gemma", "codex", "copilot",
  "sora", "multimodal", "robot", "人工智能", "大模型", "智能体"
];

const TRAFFIC_KEYWORDS = [
  "launch", "released", "introducing", "new", "free", "agent", "chatgpt", "claude",
  "gemini", "gpt", "image", "video", "coding", "copilot", "workflow", "startup",
  "tool", "app", "guide", "how to", "发布", "推出", "免费", "工具", "效率", "教程"
];

const SLOT_LABELS = {
  morning: "早报",
  noon: "午报",
  evening: "晚报"
};

function nowInBeijing() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
}

function getRunSlot(date = nowInBeijing()) {
  const hour = date.getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "noon";
  return "evening";
}

function xmlDecode(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function stripHtml(value = "") {
  return xmlDecode(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickTag(block, tagNames) {
  for (const tag of tagNames) {
    const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
    if (match) return stripHtml(match[1]);
  }
  return "";
}

function pickLink(block) {
  const atom = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  if (atom) return xmlDecode(atom[1]).trim();

  const rss = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (rss) return stripHtml(rss[1]);

  const guid = block.match(/<guid(?:\s[^>]*)?>([\s\S]*?)<\/guid>/i);
  if (guid && /^https?:\/\//.test(stripHtml(guid[1]))) return stripHtml(guid[1]);

  return "";
}

function parseFeed(xml, source) {
  const blocks = [
    ...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)
  ].map((match) => match[0]);

  return blocks.map((block) => ({
    source,
    title: pickTag(block, ["title"]),
    url: pickLink(block),
    publishedAt: pickTag(block, ["pubDate", "published", "updated", "dc:date"]),
    summary: pickTag(block, ["description", "summary", "content:encoded", "content"]),
    tags: [...block.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)]
      .map((match) => stripHtml(match[1]))
      .filter(Boolean)
  })).filter((item) => item.title && item.url);
}

function absolutize(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return "";
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasKeywordSignal(haystack, keyword) {
  if (/^[a-z0-9.+-]+$/i.test(keyword)) {
    return new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i").test(haystack);
  }
  return haystack.includes(keyword.toLowerCase());
}

function parseAnthropicHtml(html, source) {
    const candidates = [];
    const seen = new Set();
    const anchorPattern = /<a\b[^>]*href=["']([^"']*\/news\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    const datePattern = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/i;
    const cardLabels = /\b(Product|Announcements|Research|Company|Policy|Engineering|Stories|News)\b/gi;

    for (const match of html.matchAll(anchorPattern)) {
        const url = absolutize(match[1], source.url);
        const rawText = stripHtml(match[2]);
        const dateMatch = rawText.match(datePattern);
        let title = rawText.replace(/\s+/g, " ").trim();
        let publishedAt = new Date().toISOString();

        if (dateMatch) {
            publishedAt = dateMatch[0];
            const beforeDate = rawText.slice(0, dateMatch.index).replace(cardLabels, " ").replace(/\s+/g, " ").trim();
            const afterDate = rawText.slice(dateMatch.index + dateMatch[0].length).replace(/\s+/g, " ").trim();
            title = beforeDate.length > 12 ? beforeDate : afterDate;
        }

        title = title
            .replace(/\b(Today|We|Our|In this post|This post)\b[\s\S]*$/i, "")
            .replace(/\s+/g, " ")
            .trim();

        if (title.length > 110) title = `${title.slice(0, 106)}...`;
        if (!url || !title || title.length < 8 || seen.has(url)) continue;
        seen.add(url);
        candidates.push({
            source,
            title,
            url,
            publishedAt,
            summary: rawText,
            tags: source.tags
        });
    }

  return candidates;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "AI-Koubotai/1.0 (+https://github.com/chenrenhan91-art/ai-)",
        "accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function includesAiSignal(item, source) {
    if (source.type === "official" && source.id !== "anthropic") return true;
    const haystack = `${item.title} ${item.summary} ${(item.tags || []).join(" ")}`.toLowerCase();
    if (source.type === "creator" && source.id !== "importai") {
        const titleHaystack = `${item.title}`.toLowerCase();
        return CREATOR_TITLE_KEYWORDS.some((keyword) => hasKeywordSignal(titleHaystack, keyword));
    }
    return AI_KEYWORDS.some((keyword) => hasKeywordSignal(haystack, keyword));
}

function normalizeDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function daysOld(dateString) {
  const today = nowInBeijing();
  const target = new Date(`${dateString}T08:00:00+08:00`);
  return Math.max(0, Math.floor((today - target) / 86400000));
}

function classifyCategory(item, source) {
  const haystack = `${item.title} ${item.summary} ${(item.tags || []).join(" ")} ${(source.tags || []).join(" ")}`.toLowerCase();
  for (const [category, keywords] of CATEGORY_RULES) {
    if (keywords.some((keyword) => haystack.includes(keyword))) return category;
  }
  return source.type === "creator" ? "digest" : "product";
}

function scoreItem(item, source, category, dateString) {
  const haystack = `${item.title} ${item.summary}`.toLowerCase();
  let score = Number(source.weight) || 1;

  if (daysOld(dateString) <= 1) score += 1;
  if (/(release|launch|introducing|new|gpt|claude|gemini|open source|benchmark|agent|发布|推出)/i.test(haystack)) score += 1;
  if (TRAFFIC_KEYWORDS.some((keyword) => hasKeywordSignal(haystack, keyword))) score += 0.75;
  if (category === "product" || category === "model") score += 0.5;
  if (source.type === "official") score += 0.25;

  if (score >= 4) return 3;
  if (score >= 2.5) return 2;
  return 1;
}

function assignSlots(priority, category, sourceType, dateString) {
  const slots = new Set(["evening"]);
  if (priority >= 3 || daysOld(dateString) <= 1 || category === "product" || category === "model") slots.add("morning");
  if (sourceType === "creator" || category === "research" || category === "open" || priority >= 2) slots.add("noon");
  return ["morning", "noon", "evening"].filter((slot) => slots.has(slot));
}

function compactText(text, fallback) {
  const clean = stripHtml(text || fallback || "").replace(/\s+/g, " ").trim();
  if (!clean) return fallback;
  return clean.length > 180 ? `${clean.slice(0, 176)}...` : clean;
}

function titleForDisplay(title, source) {
  const clean = stripHtml(title).replace(/\s+/g, " ").trim();
  return clean.startsWith(source.label) ? clean : `${source.label}: ${clean}`;
}

function sourceEvidence(source) {
  return source.type === "creator" ? "个人解读" : "官方一手";
}

function formatKind(source, category) {
  if (source.type === "creator") return category === "digest" ? "博主观察" : "个人解读";
  if (category === "open") return "开源生态";
  if (category === "research") return "研究发布";
  if (category === "security") return "安全治理";
  if (category === "model") return "模型更新";
  return "产品发布";
}

function makeCreator(item, source, category) {
  const cleanTitle = stripHtml(item.title).replace(/\s+/g, " ").trim().replace(/^[^:]+:\s*/, "");
  const rawSummary = compactText(item.summary, item.title).replace(/^[^:]+:\s*/, "").trim();

  // 前5秒钩子：面向观众的注意力抓取，而非告诉创作者"这条适合讲"
  const shortTitle = cleanTitle.slice(0, 18).trim();
  const hook = shortTitle.length >= 5
    ? `${shortTitle}——今天这条 AI 消息，和你有关。`
    : `今天有条 AI 消息，可能改变你用工具的方式。`;

  // 一句话：面向观众的内容摘要，而非告诉创作者"适合做60秒"
  const oneLiner = rawSummary.length > 15
    ? rawSummary.slice(0, 60) + (rawSummary.length > 60 ? "……" : "")
    : `${source.label} 发布了关于「${cleanTitle.slice(0, 20)}」的最新动态。`;

  // 为什么和观众有关：面向观众，而非告诉创作者"适合做哪类选题"
  const angle = source.type === "creator"
    ? `这位博主长期追踪 AI 工具动态，这条判断对你评估相关工具是否值得关注有直接参考价值。`
    : `这是来自 ${source.label} 的官方更新，直接影响你正在使用的 AI 产品或工具。`;

  return {
    duration: "60 秒",
    oneLiner,
    hook,
    angle,
    coverTitle: cleanTitle.slice(0, 32),
    coverSubtitle: source.type === "creator" ? "博主深度分析" : "官方最新动态",
    commentPrompt: "这条更新你觉得对你的工作或生活有影响吗？",
    cta: "关注我，每天帮你筛出真正值得关注的 AI 动态。"
  };
}

function makeTakeaways(item, source, category) {
  const cleanTitle = stripHtml(item.title).replace(/\s+/g, " ").trim().replace(/^[^:]+:\s*/, "");
  const rawText = compactText(item.summary, item.title).replace(/^[^:]+:\s*/, "").trim();
  const dateStr = normalizeDate(item.publishedAt);
  const platform = source.platform || (source.type === "official" ? "官方渠道" : "个人博主");
  return [
    `发布于 ${dateStr}，来自 ${source.label}（${platform}）。`,
    rawText.length > 15 ? rawText.slice(0, 120) : cleanTitle,
    `点击原文可查看完整内容，结合自身需求做判断。`
  ];
}

function hashId(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 10);
}

function normalizeItem(item, source) {
  const sourceUrl = absolutize(item.url, source.url);
  if (!sourceUrl) return null;

  const publishedAt = normalizeDate(item.publishedAt);
  const category = classifyCategory(item, source);
  const priority = scoreItem(item, source, category, publishedAt);

  return {
    id: `${source.id}-${hashId(sourceUrl)}`,
    source: source.id,
    category,
    format: formatKind(source, category),
    evidence: sourceEvidence(source),
    priority,
    featured: priority >= 3,
    publishedAt,
    slots: assignSlots(priority, category, source.type, publishedAt),
    titleZh: titleForDisplay(item.title, source),
    titleEn: stripHtml(item.title),
    summary: `${source.label} 更新：${compactText(item.summary, item.title)}`,
    whyMatters: source.type === "creator"
      ? `${source.label} 基于实测或研究分享了这条判断，对普通用户了解 AI 工具现状有直接参考价值。`
      : `${source.label} 官方发布，直接反映当前 AI 产品方向，影响日常工具使用体验。`,
    takeaways: makeTakeaways(item, source, category),
    tags: [...new Set([...(source.tags || []), ...(item.tags || [])])].slice(0, 8),
    sourceUrl,
    creator: makeCreator(item, source, category)
  };
}

// ── Gemini AI 批量翻译与内容优化 ──────────────────────────────────────────────
// 需要在运行脚本时设置 GEMINI_API_KEY 环境变量
// 用法: GEMINI_API_KEY=xxx node scripts/build-news-feed.mjs

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 8192 }
      })
    });
    if (!response.ok) {
      console.warn(`Gemini API error: HTTP ${response.status}`);
      return null;
    }
    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (err) {
    console.warn("Gemini call failed:", err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function enrichWithAI(items) {
  if (!GEMINI_API_KEY || !items.length) return items;

  // 只处理需要翻译/优化的条目（标题或摘要含英文的）
  const needsEnrich = items.filter((item) =>
    /[a-zA-Z]{4,}/.test(item.titleEn) || /[a-zA-Z]{6,}/.test(item.summary)
  );
  if (!needsEnrich.length) return items;

  const inputs = needsEnrich.map((item) => ({
    id: item.id,
    titleEn: item.titleEn,
    category: item.category,
    sourceType: item.evidence,
    raw: item.summary.replace(/^.{0,30}更新[：:]/, "").slice(0, 300)
  }));

  const prompt = `你是一位在抖音/B站有百万粉丝的 AI 资讯博主。你的内容风格：口语化、有态度、能让普通人产生共鸣，不说废话，每句话都有信息量。

把以下英文 AI 新闻条目处理成中文口播素材，返回 JSON 数组。

每个对象的字段：
- id（原样返回）
- titleZh（中文标题，≤25字，直接说发生了什么，口语化，禁止"来源:"前缀）
- summary（中文摘要，≤80字，口语化，说的是"发生了什么、有什么影响"，不是对英文的机械翻译）
- hook（前3秒钩子，≤22字，必须制造张力——用以下一种类型：①数字冲击"X天/X亿/X倍" ②反转"大家以为X，其实Y" ③场景直击"你如果在做X，注意了" ④冲突"一个决定，可能让X消失" ⑤悬念"这件事 AI 圈都没敢说清楚"。禁止出现"这条值得讲""这条适合"等创作者视角的表达）
- oneLiner（一句话说清核心，≤30字，像朋友聊天推荐，有具体信息，禁止抽象表达如"值得关注"）
- angle（为什么和你有关，≤40字，必须聚焦到"你的工作/工具/效率/钱"的具体变化，禁止"适合做内容"）
- commentPrompt（互动问题，≤25字，必须是二选一的判断题或具体场景问题，禁止"你怎么看"这种开放题）

只返回 JSON 数组，不加代码块标记，不加任何解释文字。

输入：${JSON.stringify(inputs)}`;

  console.log(`Calling Gemini to enrich ${needsEnrich.length} items...`);
  const result = await callGemini(prompt);
  if (!result) {
    console.warn("Gemini enrichment skipped (no result)");
    return items;
  }

  let enriched;
  try {
    const cleaned = result.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    enriched = JSON.parse(cleaned);
    if (!Array.isArray(enriched)) throw new Error("Not an array");
  } catch (err) {
    console.warn("Gemini result parse failed:", err.message);
    return items;
  }

  const map = Object.fromEntries(
    enriched.filter((t) => t && t.id).map((t) => [t.id, t])
  );

  return items.map((item) => {
    const t = map[item.id];
    if (!t) return item;
    const sourceName = item.source.charAt(0).toUpperCase() + item.source.slice(1);
    return {
      ...item,
      titleZh: t.titleZh || item.titleZh,
      summary: t.summary ? `${sourceName} 更新：${t.summary}` : item.summary,
      creator: {
        ...item.creator,
        hook: t.hook || item.creator.hook,
        oneLiner: t.oneLiner || item.creator.oneLiner,
        angle: t.angle || item.creator.angle,
        commentPrompt: t.commentPrompt || item.creator.commentPrompt
      }
    };
  });
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return new Date(`${b.publishedAt}T08:00:00+08:00`) - new Date(`${a.publishedAt}T08:00:00+08:00`);
  });
}

async function collectSource(source) {
  const text = await fetchText(source.feedUrl || source.url);
  const rawItems = source.parser === "anthropic-html"
    ? parseAnthropicHtml(text, source)
    : parseFeed(text, source);

  return rawItems
    .filter((item) => includesAiSignal(item, source))
    .slice(0, MAX_ITEMS_PER_SOURCE)
    .map((item) => normalizeItem(item, source))
    .filter(Boolean);
}

async function main() {
  const sources = JSON.parse(await readFile(SOURCES_URL, "utf8")).filter((source) => source.enabled);
  const results = await Promise.allSettled(sources.map((source) => collectSource(source)));
  const items = [];
  const errors = [];

  results.forEach((result, index) => {
    const source = sources[index];
    if (result.status === "fulfilled") {
      items.push(...result.value);
    } else {
      errors.push({ source: source.id, message: result.reason?.message || String(result.reason) });
    }
  });

  const seen = new Set();
  const deduped = sortItems(items).filter((item) => {
    if (seen.has(item.sourceUrl)) return false;
    seen.add(item.sourceUrl);
    return true;
  }).slice(0, MAX_OUTPUT_ITEMS);

  // 如果设置了 GEMINI_API_KEY，自动翻译英文条目并优化内容
  const enriched = await enrichWithAI(deduped);

  const payload = {
    generatedAt: new Date().toISOString(),
    timezone: "Asia/Shanghai",
    runSlot: getRunSlot(),
    runSlotLabel: SLOT_LABELS[getRunSlot()],
    sourceStats: {
      official: sources.filter((source) => source.type === "official").length,
      creator: sources.filter((source) => source.type === "creator").length,
      failed: errors.length
    },
    sources: sources.map(({ id, label, type, platform, url, tags }) => ({ id, label, type, platform, url, tags })),
    errors,
    items: enriched
  };

  await writeFile(OUTPUT_URL, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Generated ${deduped.length} items from ${sources.length} sources.`);
  if (errors.length) console.warn(`Skipped ${errors.length} source(s): ${errors.map((error) => error.source).join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
