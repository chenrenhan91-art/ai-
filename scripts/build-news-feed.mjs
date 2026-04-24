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
  // 只返回文章标题，不加来源前缀
  const escaped = source.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return clean.replace(new RegExp(`^${escaped}[：:\\s]+`, "i"), "").trim() || clean;
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

// 基于量子位/机器之心/差评等头部中文AI账号文案规律设计的分类钩子模板
// 核心：数字/反转/场景/冲突四类 × 6个分类
const CATEGORY_HOOKS = {
  product: [
    "这个功能刚上线，可能你还不知道它能做什么。",
    "又有 AI 工具更新了，这次改的这个地方，直接影响你每天的用法。",
    "同一件事，用 AI 新版本和旧版本做，差距已经不是一点点了。"
  ],
  model: [
    "新模型出来了，先别急着换——先看它在你用的场景里强在哪。",
    "AI 能力又往前跳了一步，这次最明显的变化是这一点。",
    "你现在用的 AI，可能3个月后就要被这个替代了。"
  ],
  research: [
    "一个研究结论让人意外：AI 在这件事上，比我们预期强得多。",
    "有篇研究被低估了，它说的这件事，半年内会影响你用的产品。",
    "AI 的能力边界，又往外移了一点——这次是在这个方向。"
  ],
  security: [
    "用 AI 的时候，有一件事你最好现在就知道。",
    "这个 AI 安全问题不是技术圈的事，和你输入的每一条信息都有关。",
    "AI 数据权限这件事，搞清楚之前最好先暂停这个操作。"
  ],
  open: [
    "开源 AI 和商业 AI 的差距，正在快速缩小——这次缩到了这里。",
    "免费、开源、本地跑，这件事变得比你想象的简单多了。",
    "如果你在用付费 AI 工具，这个开源替代品值得先试试。"
  ],
  default: [
    "今天有条 AI 动态，和你用工具的方式直接有关。",
    "AI 圈这周最值得关注的变化，就是这件事。",
    "不是所有 AI 新闻都值得看，但这条今天你必须知道。"
  ]
};

const CATEGORY_ONELINERS = {
  product: "一个 AI 产品发布了新功能，核心变化直接影响现有用户的使用体验。",
  model: "一个新 AI 模型更新了，能力边界有明显变化，下游应用很快会跟进。",
  research: "一项 AI 研究出了新结论，代表技术方向的最新信号，几个月后会反映在产品里。",
  security: "一条 AI 安全动态，涉及数据权限或使用风险，普通用户需要了解。",
  open: "开源 AI 生态有新进展，可自由部署，开发者和进阶用户值得关注。",
  default: "AI 领域有最新动态，影响日常工具使用，建议了解一下。"
};

const COMMENT_PROMPTS = {
  product: "这个功能你会用还是不用？评论区选边站。",
  model: "你觉得这次升级值不值得关注？A值 B不值。",
  research: "这个研究结论你信吗？评论区聊聊。",
  security: "你平时在 AI 工具里输入过真实个人信息吗？A有 B没有。",
  open: "你用开源还是商业 AI 工具？告诉我你的选择。",
  default: "这条对你有影响吗？有的话告诉我你做哪行。"
};

function makeCreator(item, source, category) {
  const cleanTitle = stripHtml(item.title).replace(/\s+/g, " ").trim().replace(/^[^:]+:\s*/, "");
  const rawSummary = compactText(item.summary, item.title).replace(/^[^:]+:\s*/, "").trim();
  const isEnglish = source.language === "en" || /[a-zA-Z]{5,}/.test(cleanTitle);

  // 钩子：英文内容用分类模板，中文内容用标题提炼
  const hookTemplates = CATEGORY_HOOKS[category] || CATEGORY_HOOKS.default;
  const zhTitle = cleanTitle.replace(/[^\u4e00-\u9fa5]/g, "").slice(0, 16).trim();
  const hook = isEnglish
    ? hookTemplates[0]
    : (zhTitle.length >= 6 ? `${zhTitle}——这条 AI 消息，和你直接有关。` : hookTemplates[0]);

  // 一句话摘要：英文内容用分类模板，中文内容用实际摘要
  const oneLiner = isEnglish
    ? CATEGORY_ONELINERS[category] || CATEGORY_ONELINERS.default
    : (rawSummary.length > 15
        ? rawSummary.slice(0, 55) + (rawSummary.length > 55 ? "……" : "")
        : CATEGORY_ONELINERS[category] || CATEGORY_ONELINERS.default);

  // 角度说明：面向观众，说清楚和自己的关系
  const angle = source.type === "creator"
    ? `这位博主长期追踪 AI 工具实际表现，这条判断对你评估工具是否值得用有直接参考价值。`
    : `这是 ${source.label} 官方发布的动态，会直接反映在你正在使用的 AI 产品里。`;

  // 封面标题：英文内容用来源+分类，中文内容用实际标题
  const categoryLabels = { product: "产品发布", model: "模型更新", research: "研究发现", security: "安全动态", open: "开源进展" };
  const coverTitle = isEnglish
    ? `${source.label} · ${categoryLabels[category] || "AI动态"}`
    : cleanTitle.slice(0, 32);

  return {
    duration: "60 秒",
    oneLiner,
    hook,
    angle,
    coverTitle,
    coverSubtitle: source.type === "creator" ? "博主深度解读" : "官方第一手",
    commentPrompt: COMMENT_PROMPTS[category] || COMMENT_PROMPTS.default,
    cta: "关注我，每天帮你筛出真正值得关注的 AI 动态。"
  };
}

// 基于内容和分类生成三条有实质价值的要点（不再输出元数据）
const CATEGORY_TAKEAWAYS = {
  product: [
    "功能更新通常先出现在网页版或API，App端会稍后跟进，留意你习惯的入口。",
    "上手成本低，不需要技术背景，建议结合你最高频的工作场景直接实测。",
    "判断新功能值不值得用：看它能不能替换你现在某个重复性的操作。"
  ],
  model: [
    "模型升级会传导到下游产品，你在用的 AI 工具通常1-2周内就会接入新能力。",
    "关键看三个提升点：推理更准 / 速度更快 / 输出更长——哪条对你的场景更重要。",
    "不用急着切换，等产品层接入后看实际表现，再决定要不要调整工作流。"
  ],
  research: [
    "研究结论和产品落地之间通常有6-18个月的滞后，现在看到的是方向信号。",
    "关注这类研究的价值：提前了解 AI 能力还卡在哪些地方、哪些方向已经打通了。",
    "对普通用户来说，研究成果转化成工具功能才有实际影响，可持续跟进这个领域。"
  ],
  security: [
    "AI 安全最直接影响你输入的数据——不要在 AI 工具里输入身份证号、密码、合同原文。",
    "企业用户风险高于个人，公司内部敏感数据要用支持私有化部署的方案处理。",
    "遇到 AI 工具要求过多权限或存储对话记录的，先查清数据政策再决定是否使用。"
  ],
  open: [
    "开源模型的核心优势：可以本地运行，数据不离开你的设备，适合隐私要求高的场景。",
    "开源和商业 AI 的差距在今年快速缩小，某些任务上开源已经够用甚至更好。",
    "对普通用户来说，关注以开源模型为底层的封装产品，会比直接用原始模型更方便。"
  ],
  default: [
    "这条动态代表 AI 领域正在发生的一个方向性变化，值得持续关注。",
    "对你最直接的影响会出现在你日常用的工具里，留意未来几周的产品更新通知。",
    "判断一条 AI 新闻重不重要：看它有没有影响你正在用的工具，或者会不会改变你的工作流。"
  ]
};

function makeTakeaways(item, source, category) {
  const rawText = compactText(item.summary, item.title).replace(/^[^:]+[：:]\s*/, "").trim();
  const isEnglish = source.language === "en" || /[a-zA-Z]{5,}/.test(rawText.slice(0, 50));
  const templates = CATEGORY_TAKEAWAYS[category] || CATEGORY_TAKEAWAYS.default;

  // 中文内容：用实际摘要作为第一条，后面补两条分类要点
  if (!isEnglish && rawText.length > 30) {
    return [
      rawText.slice(0, 90) + (rawText.length > 90 ? "……" : ""),
      templates[1],
      templates[2]
    ];
  }
  // 英文内容或短内容：全用分类模板
  return templates;
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
