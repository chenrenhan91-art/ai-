import re

with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

new_block = '''        // ══════════════════════════════════════════════════════════════════
        //  口播稿生成引擎 v2  ·  三种风格 × 专属结构
        //  研究参考：差评、回形针、老石谈芯等头部 AI 账号热门视频规律
        //  核心原则：张力钩子 → 场景翻译 → 作者明确表态 → 二选一互动
        // ══════════════════════════════════════════════════════════════════

        function buildFiveSecondHook(item) {
            return stripTrailingPunctuation(item.creator.hook) + "。";
        }

        function cleanSummary(raw) {
            return (raw || "").replace(/^[\\s\\S]{0,30}更新[：:]/, "").replace(/^[\\s\\S]{0,30}:\\s*/, "").trim();
        }

        function buildSupportLine(supports, connector) {
            return supports.slice(0, 2).map((item) => {
                const src = getSourceMeta(item.source);
                const line = stripTrailingPunctuation(item.creator.oneLiner);
                return `${connector}${src.label} 那边也有一条：${line}`;
            }).join("。") + (supports.length ? "。" : "");
        }

        // ── 风格 A：快讯冲击型（early · quick）
        // 结论前置，每句都在推进，无废话
        // 结构：数字/反转钩子 → 核心事件 → 直接影响 → 快速判断 → 二选一互动
        function buildQuickScript(slotInfo, lead, supports) {
            const summary = cleanSummary(lead.summary);
            const supportLine = buildSupportLine(supports, "另外，");
            const isProductOrModel = lead.category === "product" || lead.category === "model";

            const lines = [
                buildFiveSecondHook(lead),
                `今天${slotInfo.shortLabel}最值得先看的一条——${lead.titleZh}。`,
                summary.length > 10 ? `核心是什么？${stripTrailingPunctuation(summary)}。` : "",
                `换句人话就是：${stripTrailingPunctuation(lead.creator.oneLiner)}。`,
                `直接影响你的地方在这：${stripTrailingPunctuation(lead.creator.angle)}。`,
                supportLine,
                `我的快速判断：这条是${isProductOrModel ? "值得跟的信号" : "需要持续观察的动向"}，别只收藏，先用起来。`,
                `${lead.creator.commentPrompt} 评论区快聊。\\n\\n${lead.creator.cta}`
            ].filter(Boolean).join("\\n\\n");

            return {
                script: lines,
                angleText: `【快讯冲击型】结论前置 → 核心事件 → 直接影响 → 快速判断 → 二选一互动。适合早报快节奏发布。`,
                headlines: [
                    `${slotInfo.shortLabel}快讯｜${lead.creator.coverTitle}`,
                    `${lead.creator.coverTitle}，已经开始影响了`,
                    `AI 圈今天最快的一条`
                ]
            };
        }

        // ── 风格 B：真人闲聊型（noon · natural）
        // 像朋友聊，从熟悉场景切入，有转折，有作者感受
        // 结构：场景钩子 → 转折引入 → 事件翻译 → 要点拆解 → 真实判断 → 具体互动
        function buildNaturalScript(slotInfo, lead, supports) {
            const summary = cleanSummary(lead.summary);
            const audienceTakeaways = Array.isArray(lead.takeaways)
                ? lead.takeaways.filter((t) => !t.startsWith("来源属性") && !t.startsWith("内容信号") && !t.startsWith("发布前建议"))
                : [];

            const takeawayLines = audienceTakeaways.length >= 2
                ? "我自己整理了一下，有几个点比较值得注意：\\n" +
                  audienceTakeaways.slice(0, 3).map((t, i) => `→ 第${["一","二","三"][i]}个：${stripTrailingPunctuation(t)}`).join("\\n")
                : "";

            const supportPart = supports.length ? `顺带说一下，${buildSupportLine(supports, "")}` : "";

            const lines = [
                buildFiveSecondHook(lead),
                `不过最近有件事，值得认真说一说——${lead.titleZh}。`,
                summary.length > 10 ? `简单说就是：${stripTrailingPunctuation(summary)}。` : "",
                `换成我们能听懂的话：${stripTrailingPunctuation(lead.creator.oneLiner)}。`,
                takeawayLines,
                supportPart,
                `说实话我的感受是：${stripTrailingPunctuation(lead.creator.angle)}，这不是在夸它，是真的有这个感受。`,
                `${lead.creator.commentPrompt} 留言告诉我。\\n\\n${lead.creator.cta}`
            ].filter(Boolean).join("\\n\\n");

            return {
                script: lines,
                angleText: `【真人闲聊型】场景切入 → 事件翻译 → 要点拆解 → 真实判断 → 具体互动。适合午报建立亲近感。`,
                headlines: [
                    `${lead.creator.coverTitle}`,
                    `${lead.creator.coverTitle}，我自己整理了一下`,
                    `今天这条 AI 消息，比你想的更接地气`
                ]
            };
        }

        // ── 风格 C：观点深挖型（evening · opinion）
        // 先亮出有争议的判断，用事件做论据，引发讨论
        // 结构：反直觉判断 → 事件论据 → 表面vs深层解读 → 趋势预判 → 挑战性问题
        function buildOpinionScript(slotInfo, lead, supports) {
            const summary = cleanSummary(lead.summary);
            const opinionSupport = supports.slice(0, 2).map((item) => {
                const src = getSourceMeta(item.source);
                return `再看 ${src.label} 那边：${stripTrailingPunctuation(item.creator.angle)}。这两条加在一起，方向就很清楚了。`;
            }).join("\\n\\n");

            const lines = [
                buildFiveSecondHook(lead),
                `今天要聊的这条，正好可以说明这一点——${lead.titleZh}。`,
                summary.length > 10 ? `事件本身是这样的：${stripTrailingPunctuation(summary)}。` : "",
                `表面上看，这是一次${lead.format}。但如果往深一层想：${stripTrailingPunctuation(lead.creator.angle)}。`,
                opinionSupport,
                `所以我的预判是：这个方向不是在实验，是已经在部署了。如果你还在等"成熟再用"，可能等到的是被替代。`,
                `${lead.creator.commentPrompt} 评论区聊，我都会回。\\n\\n${lead.creator.cta}`
            ].filter(Boolean).join("\\n\\n");

            return {
                script: lines,
                angleText: `【观点深挖型】反直觉判断 → 事件论据 → 表面vs深层解读 → 趋势预判 → 挑战性互动。适合晚报建立权威感。`,
                headlines: [
                    `我的判断：${lead.creator.coverTitle}`,
                    `${lead.creator.coverTitle}，背后是更大的变化`,
                    `别只看发布本身，这条更值得聊的是方向`
                ]
            };
        }

        function buildSixtySecondScripts(slotInfo, lead, supports, tone) {
            let pack;
            if (tone === "quick") {
                pack = buildQuickScript(slotInfo, lead, supports);
            } else if (tone === "opinion") {
                pack = buildOpinionScript(slotInfo, lead, supports);
            } else {
                pack = buildNaturalScript(slotInfo, lead, supports);
            }
            return {
                quickScript: pack.script,
                fullScript: pack.script,
                angleText: pack.angleText,
                headlines: pack.headlines
            };
        }
'''

new_content = re.sub(
    r'        function buildFiveSecondHook[\s\S]+?(?=\n        function buildScriptPack)',
    lambda m: new_block,
    content
)

if new_content == content:
    print("ERROR: no change made")
else:
    with open('index.html', 'w', encoding='utf-8') as f:
        f.write(new_content)
    print("SUCCESS")
    c = new_content
    checks = [
        ('buildQuickScript', 'function buildQuickScript' in c),
        ('buildNaturalScript', 'function buildNaturalScript' in c),
        ('buildOpinionScript', 'function buildOpinionScript' in c),
        ('tone routing quick', 'if (tone === "quick")' in c),
        ('tone routing opinion', 'else if (tone === "opinion")' in c),
        ('old block gone', '個人博主源的優勢' not in c),
        ('cleanSummary helper', 'function cleanSummary' in c),
        ('buildSupportLine helper', 'function buildSupportLine' in c),
    ]
    for name, ok in checks:
        print('OK' if ok else 'FAIL', name)
