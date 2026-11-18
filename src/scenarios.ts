import type { PromptContext } from "./context";

/**
 * Skill metadata for model requests. The fixed scenario catalog that used to live here was
 * removed: suggestions are generated from the current task, not picked from templates.
 */
export interface ScenarioSkill {
	name: string;
	description: string;
	hide?: boolean;
}

function uniqueSkills(skills: readonly ScenarioSkill[]): ScenarioSkill[] {
	const byName = new Map<string, ScenarioSkill>();
	for (const skill of skills) {
		const previous = byName.get(skill.name);
		if (!previous) byName.set(skill.name, skill);
		else if (skill.hide && !previous.hide) byName.set(skill.name, { ...previous, hide: true });
	}
	return [...byName.values()];
}

const CORE_SKILLS = ["eng-mode", "how", "codebase-design", "improve-codebase-architecture", "grill-with-docs", "diagnosing-bugs", "code-review", "tdd", "writing-plans", "verification-before-completion"];
const STOP_WORDS = new Set("the a an and or to of in on for is it this that with from use using when only current please code task skill skills review error fail failed save user users need needs want wants work existing next already not without do does have has can should before after feature features function interaction button implement changes output result show 审查 错误 失败 保存 使用 当前 请 需要 检查 问题 进行 代码 可以 以及 我们 的 了 用户 没有 已经 现有 接下来 下一步 不要 增加 功能 交互 按钮 提示 实现 改动 修改 更新 处理 支持 生成 查看 创建 管理 设置 场景 需求 任务 完成 行为 重试 是否 不能 只能 适用 用于 时候 相关 排查".split(" "));
const ENGINEERING = /仓库|代码|源码|函数|开发|编程|重构|单元测试|编译|\b(?:repo(?:sitory)?|code|source|function|programming|development|refactor(?:ing)?|compiler|debugger)\b/i;
const UI_SUBJECT = /页面|设置页|按钮|交互|组件|\b(?:page|button|interaction|component)\b/i;
const UI_CHANGE = /(?:审查|实现|修改|验证).*?(?:改动|变更)|(?:改动|变更).*?(?:审查|实现|修改|验证)|\b(?:review|implement|modify|verify)\b.*?\bchanges?\b|\bchanges?\b.*?\b(?:review|implement|modify|verify)\b/i;
const WORD_SEGMENTER = new Intl.Segmenter("zh", { granularity: "word" });
// Low-information terms that recur across unrelated domains; on their own they never select a skill.
const WEAK_TERMS = new Set(["消息", "文件"]);
// Function/glue characters with no domain evidence; they break bigram runs (e.g. 请帮我, 排查) so generic action text never corroborates.
const GENERIC_CHARS = new Set("请帮我你他她它的了着吗呢吧啊里中用时未但并给出校对这那份些个和与或及排查报错是在有把被让给对从向到去来不没很就都也还又再会能要想做干搞弄".split(""));

// Adjacent pairs of single Chinese characters from the user context, broken at punctuation, spaces,
// non-Chinese text, multi-character words and glue characters. Used only to corroborate a weak-term
// match; never introduces a candidate on its own.
function domainBigrams(context: string): Set<string> {
	const grams = new Set<string>();
	let run = "";
	const flush = () => {
		for (let i = 0; i + 1 < run.length; i += 1) {
			const gram = run.slice(i, i + 2);
			if (!STOP_WORDS.has(gram)) grams.add(gram);
		}
		run = "";
	};
	for (const part of WORD_SEGMENTER.segment(context)) {
		const ch = part.segment;
		if (part.isWordLike && ch.length === 1 && /[一-鿿]/.test(ch) && !GENERIC_CHARS.has(ch)) run += ch;
		else flush();
	}
	flush();
	return grams;
}

function withoutSkillNames(context: string, names: readonly string[]): string {
	const escaped = [...new Set(names.map(name => name.toLowerCase()).filter(Boolean))]
		.sort((a, b) => b.length - a.length)
		.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	if (!escaped.length) return context;
	return context.replace(new RegExp(`(?<![a-z0-9_-])(?:${escaped.join("|")})(?![a-z0-9_-])`, "gi"), " ");
}

function words(text: string): Set<string> {
	return new Set(Array.from(WORD_SEGMENTER.segment(text.toLowerCase()))
		.filter(part => part.isWordLike && part.segment.length >= 2 && !STOP_WORDS.has(part.segment))
		.map(part => part.segment));
}

export function completionRouteContext(
	commands: readonly { name: string; description?: string; source: "extension" | "prompt" | "skill" }[],
	background?: PromptContext,
) {
	const context = (background?.recentTurns.map(turn => turn.text).join(" ") ?? "").toLowerCase();
	const terms = words(context);
	const distributedWorkflow = /分工|并行处理|并行执行|分头/.test(context) && /统一验收|集成验收|汇总验证|合并验证|统一验证/.test(context);
	return commands.map(command => {
		const name = command.name.toLowerCase();
		const description = (command.description ?? "").slice(0, 240);
		const text = `${name} ${description.toLowerCase()}`;
		let score = context.includes(name) ? 100 : 0;
		for (const term of words(text)) if (terms.has(term)) score += 1;
		if (/发版|发布|发行|上线/.test(context) && /release|publish|ship|发版|发布|发行/.test(text)) score += 8;
		if (/梳理任务|明确任务|细化需求|完善需求|澄清需求/.test(context) && /sharpen|clarif|specif|梳理|细化|澄清/.test(text)) score += 8;
		if (/fabric/i.test(context) && /fabric/i.test(text)) score += 8;
		if (distributedWorkflow && name === "skill:fabric-workflow") score += 8;
		return { command, description, score };
	}).filter(item => item.score > 0)
		.sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name, "en"))
		.slice(0, 24)
		.map(({ command, description }) => ({ invocation: `/${command.name}`, description, source: command.source }));
}

export function completionSkillContext(skills: readonly ScenarioSkill[], background?: PromptContext, draft = ""): string {
	const context = [draft, ...(background?.recentTurns.filter(turn => turn.role === "user").map(turn => turn.text) ?? [])].join(" ").trim().toLowerCase();
	const terms = words(context);
	const visible = uniqueSkills(skills).filter(skill => !skill.hide);
	const generic = withoutSkillNames(context, visible.map(skill => skill.name));
	const engineering = ENGINEERING.test(generic) || (UI_SUBJECT.test(generic) && UI_CHANGE.test(generic));
	const descriptions = visible.map(skill => words(skill.description.slice(0, 240)));
	const frequency = new Map<string, number>();
	for (const description of descriptions) for (const term of description) frequency.set(term, (frequency.get(term) ?? 0) + 1);
	const threshold = Math.max(1, visible.length / 5);
	const weakTerms = [...terms].filter(term => WEAK_TERMS.has(term));
	const bigrams = weakTerms.length ? domainBigrams(context) : new Set<string>();
	return JSON.stringify(visible.map((skill, index) => {
		const name = skill.name.toLowerCase();
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const explicit = new RegExp(`(?<![a-z0-9_-])${escaped}(?![a-z0-9_-])`, "i").test(context);
		const core = CORE_SKILLS.indexOf(name);
		let score = explicit ? 1000 : 0;
		if (core >= 0 && (!context || engineering)) score += 100 - core;
		if (context) {
			for (const term of words(name)) if (terms.has(term) && term.length >= 3) score += 20;
			const description = descriptions[index];
			let hasSolidTerm = false;
			for (const term of terms) {
				if (WEAK_TERMS.has(term) || !description.has(term)) continue;
				if ((frequency.get(term) ?? 0) <= threshold) {
					score += 1;
					hasSolidTerm = true;
				}
			}
			const matchedWeak = weakTerms.filter(term => description.has(term));
			if (matchedWeak.length) {
				const text = skill.description.slice(0, 240).toLowerCase();
				const corroborated = [...bigrams].some(gram => text.includes(gram));
				for (const term of matchedWeak) {
					const frequent = (frequency.get(term) ?? 0) <= threshold;
					// Corroboration lifts the frequency gate; otherwise the original gate applies when a
					// strong term exists or the context offers no fragments. A candidate that misses
					// available fragments stays filtered.
					if (corroborated || (frequent && (hasSolidTerm || bigrams.size === 0))) score += 1;
				}
			}
		}
		return { skill, score };
	}).filter(item => item.score > 0)
		.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name, "en"))
		.slice(0, 16)
		.map(({ skill }) => ({ name: skill.name.slice(0, 100), description: skill.description.slice(0, 240) })));
}
