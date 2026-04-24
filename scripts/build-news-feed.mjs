import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const SOURCES_URL = new URL("sources.json", ROOT);
const OUTPUT_URL = new URL("news-feed.json", ROOT);
const MAX_ITEMS_PER_SOURCE = 12;
const MAX_OUTPUT_ITEMS = 60;
const FEED_TIMEOUT_MS = 18000;

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
  const isCreator = source.type === "creator";
  const subject = titleForDisplay(item.title, source);
  const angle = isCreator
    ? "这类个人博主来源适合做“我替你试过/我替你看懂了”的选题，容易形成信任感和评论讨论。"
    : "这类官方来源适合做事实锚点，但口播时要翻译成普通用户能听懂的效率、工具或趋势变化。";

  return {
    duration: "60 秒",
    oneLiner: `${source.label} 这条动态适合做 60 秒 AI 热点，核心看点是 ${compactText(item.title, subject)}。`,
    hook: `先给你 5 秒结论：${source.label} 这条 ${formatKind(source, category)} 值得讲，因为它能转成“工具变化、效率提升或行业信号”三类流量钩子。`,
    angle,
    coverTitle: compactText(item.title, subject).replace(/^.+?:\s*/, "").slice(0, 32),
    coverSubtitle: isCreator ? "个人博主视角，帮你抓热点" : "官方消息，翻译成普通人看点",
    commentPrompt: "这条 AI 动态你会马上试用，还是先观望？",
    cta: "关注我，每天早中晚帮你筛出真正适合做内容的 AI 热点。"
  };
}

function makeTakeaways(item, source, category) {
  const summary = compactText(item.summary, item.title);
  const kind = source.type === "creator" ? "个人博主/研究者视角" : "官方一手来源";
  return [
    `来源属性：${kind}，适合${source.type === "creator" ? "做观点补充和趋势判断" : "作为快讯主来源"}。`,
    `内容信号：${summary}`,
    `发布前建议打开原文核对具体表述，再加入自己的使用场景或行业判断。`
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
      ? "这类个人来源适合补充实测、判断和语境，能帮 AI 博主快速形成自己的观点。"
      : "这类官方来源适合作为可信事实锚点，口播时要转译成普通用户关心的场景价值。",
    takeaways: makeTakeaways(item, source, category),
    tags: [...new Set([...(source.tags || []), ...(item.tags || [])])].slice(0, 8),
    sourceUrl,
    creator: makeCreator(item, source, category)
  };
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
    items: deduped
  };

  await writeFile(OUTPUT_URL, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Generated ${deduped.length} items from ${sources.length} sources.`);
  if (errors.length) console.warn(`Skipped ${errors.length} source(s): ${errors.map((error) => error.source).join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
