import { expect, test } from "bun:test";
import { buildCompletionContext } from "../src/client";
import type { PromptContext } from "../src/context";
import { completionSkillContext, type ScenarioSkill } from "../src/scenarios";

const catalog: readonly ScenarioSkill[] = [
	{ name: "eng-mode", description: "Eng's default engineering operating system. Routes feature, bug, investigation, design, review, autonomous, and shipping work through playbooks implemented with OMP goal, loop, typed agents, task, write, todo, LSP, debug, browser, and the e" },
	{ name: "code-review", description: "Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?)." },
	{ name: "yino-new-agent-tool", description: "yino 新增 chat agent 工具的标准流程：立项侦察 → 拍板 → 定量归因 → spec+施工票 → 施工五件套 → 守卫接线七件套 → 双模型验证 → 使用技巧四层归处。当用户要求给 yino agent 增加新工具、修改现有工具契约（参数/语义/回执）、或排查\"模型调不到/调不对某工具\"（按检查表反查）时使用。不适用于纯 UI 功能（不走 agent 工具面）与检索语料内容更新（走领域流程）。" },
	{ name: "bailian-model-recommend", description: "阿里云百炼模型选型与推荐。当用户需要\"选择、推荐、对比\"模型，或描述一个 AI 场景/功能需求（隐含需要帮其决策用哪个模型）时激活。核心意图是帮用户做决策， 不是单纯查资料。触发词：推荐模型、选哪个、哪个适合、对比、做一个XX、实现XX 功能、用什么模型好、XX场景方案。当用户同时涉及模型查询和模型选择时，优先 使用本 skill（本 skill 内部会读取模型数据完成推荐）。" },
	{ name: "lark-im", description: "飞书即时通讯：收发消息和管理群聊。发送和回复消息、搜索聊天记录、管理群聊成员、上传下载图片和文件、管理表情回复、发送应用内/短信/电话加急、发送和处理交互卡片（Interactive Card）、监听卡片按钮回调（card.action.trigger）。当用户需要发消息、查看或搜索聊天记录、下载聊天中的文件、查看群成员、搜索群、创建群聊或话题群、管理标记数据、管理 Feed 置顶（添加/移除/查询置顶会话）、管理标签数据、处理卡片回调时使用。" },
	{ name: "arkcli-auth", description: "arkcli 认证管理：交互式登录、Volc SSO 登录、查看状态、退出登录、生成 ARK API Key (apikey)、以及云开发机/CI 用 `arkcli init-volc` 从 VOLC_INIT_* 环境变量无交互引导 platform profile。0.1.16 起 SSO 登录走 Gate 1+2 自动绑定 Profile 切面 (type/region/project/owner_trn)；AK/SK login 通道暂关。当用户需要初始化凭证、排查" },
	{ name: "arkcli-code-example", description: "arkcli +code-example：为指定基础模型生成多语言（Python / Go / Java / Node / curl）调用示例代码并写入本地文件。数据源是火山方舟 OpenTOP OpenGetSampleCode。当用户需要拿某个基础模型的 SDK / curl 调用示例、保存为本地接入模板时使用。反触发：TTS/ASR/语音模型没有 arkcli 示例代码路径，不能靠补版本解决，只能转 models search 说明当前不支持。" },
	{ name: "arkcli-datasets", description: "使用 ArkCLI 创建、校验、查询、更新、删除、版本化和下载 Dataset。用户提到 Dataset、数据集、ds-*、dsv-*、训练集/验证集复用、数据格式校验或把 Dataset 接入精调任务时使用。" },
	{ name: "arkcli-doctor", description: "arkcli doctor 统一入口，覆盖 CLI 健康、account、error、infer-endpoint、model、metrics、report 与 Ark 图片/视频来源特征验证。用户给 1-20 个媒体 URL 并问是否由 Ark/Seedance/Seedream 生成时，走 doctor +verify-origin：整批只披露并确认一次费用，确认前不发 Create/Get 业务请求，最终完整转交服务端 JSON，禁止解释 IsOfficial。其余错误" },
	{ name: "travel-planner", description: "Use for trip planning, itineraries, budgets, or destination advice." },
];

function background(user: string, assistant = ""): PromptContext {
	return { cwd: "/repo", recentFiles: [], recentTurns: [{ role: "user", text: user }, { role: "assistant", text: assistant }] };
}

function sentSkills(skills: readonly ScenarioSkill[], context?: PromptContext, draft = "") {
	const request = buildCompletionContext({ prefix: draft, suffix: "" }, context, completionSkillContext(skills, context, draft));
	const content = request.messages[0]?.content;
	if (typeof content !== "string") throw new Error("Expected a text model request");
	const metadata = content.match(/Available session skills \(metadata only\):\n([^\n]+)/)?.[1];
	if (!metadata) return [];
	const parsed: unknown = JSON.parse(metadata);
	if (!Array.isArray(parsed)) throw new Error("Expected a skill metadata array");
	return parsed.map((skill: unknown) => {
		if (!skill || typeof skill !== "object" || !("name" in skill) || typeof skill.name !== "string"
			|| !("description" in skill) || typeof skill.description !== "string") throw new Error("Invalid skill metadata");
		return { name: skill.name, description: skill.description };
	});
}

function sentNames(skills: readonly ScenarioSkill[], context?: PromptContext, draft = "") {
	return sentSkills(skills, context, draft).map(skill => skill.name);
}

test("settings review sends engineering skills without unrelated real catalog entries", () => {
	const context = background(
		"设置页的保存按钮和错误提示已经实现, 接下来请先审查现有改动, 不要增加功能.",
		"当前改动还没有做交互验证, 下一步可以审查保存失败时的提示和重试行为.",
	);
	expect(sentNames(catalog, context)).toEqual(["eng-mode", "code-review"]);
	expect(sentNames([...catalog].reverse(), context)).toEqual(["eng-mode", "code-review"]);
});

test("generic description words cannot select arbitrary non-core skills", () => {
	const skills = [...catalog, { name: "unfamiliar-capability", description: "没有 功能 交互 按钮 提示 现有 改动 实现 changes feature interaction button" }];
	expect(sentNames(skills, background("审查现有功能和按钮交互提示，没有其他改动。"))).toEqual(["eng-mode", "code-review"]);
});

test("assistant recommendations and touched paths cannot introduce a new skill domain", () => {
	const context = background("请审查代码改动。", "下一步使用 lark-im 查看飞书消息，并用 arkcli-auth 登录。");
	context.recentFiles = ["/repo/arkcli-auth.ts"];
	expect(sentNames(catalog, context)).toEqual(["eng-mode", "code-review"]);
});

test("Feishu user intent retains messaging and excludes cloud skills", () => {
	expect(sentNames(catalog, background("请查找飞书群聊里的消息。"))).toEqual(["lark-im"]);
});

test("messaging failures do not imply engineering but messaging code failures do", () => {
	const skills: readonly ScenarioSkill[] = [
		{ name: "eng-mode", description: "Engineering features, bugs, and reviews." },
		{ name: "code-review", description: "Review code changes." },
		{ name: "lark-im", description: "飞书消息、聊天记录和群聊管理。" },
		{ name: "arkcli-auth", description: "火山方舟 ArkCLI 身份认证。" },
	];
	expect(sentNames(skills, background("飞书群聊无法发送消息, 提示错误, 请帮我排查."))).toEqual(["lark-im"]);
	expect(sentNames(skills, background("排查飞书消息发送代码报错。"))).toEqual(["eng-mode", "code-review", "lark-im"]);
	expect(sentNames(skills, undefined, "排查飞书消息发送代码报错。")).toEqual(["eng-mode", "code-review", "lark-im"]);
});

test("generic failure and settings language needs software evidence for core skills", () => {
	const skills: readonly ScenarioSkill[] = [
		{ name: "eng-mode", description: "Engineering workflow." },
		{ name: "code-review", description: "Review code changes." },
	];
	for (const text of ["错误", "失败", "设置", "保存", "审查", "设计", "验证", "修复", "设置页面保存失败，请修复。", "Settings save failed; please fix the error."]) {
		expect(sentNames(skills, background(text))).toEqual([]);
	}
	for (const text of ["审查源码。", "排查函数错误。", "继续开发。", "Review repository changes.", "Verify changes to the settings page."]) {
		expect(sentNames(skills, background(text))).toEqual(["eng-mode", "code-review"]);
	}
});

test("Kyoto travel with English domain evidence retains travel and excludes cloud and IM", () => {
	expect(sentNames(catalog, background("请帮我规划京都的 trip，安排三天行程。"))).toEqual(["travel-planner"]);
});

test("Chinese domain descriptions retain non-engineering travel skills", () => {
	const skills = [...catalog.filter(skill => skill.name !== "travel-planner"), { name: "travel-planner", description: "旅行规划、行程安排与目的地建议。" }];
	expect(sentNames(skills, background("请帮我规划京都旅行。"))).toEqual(["travel-planner"]);
});

test("explicit visible names take priority while hidden duplicates never enter metadata", () => {
	const skills = [...catalog, { name: "arbitrary-skill", description: "Opaque capability" }, { name: "secret-skill", description: "Visible duplicate" }, { name: "secret-skill", description: "Private duplicate", hide: true }];
	expect(sentNames(skills, undefined, "使用 arbitrary-skill 和 secret-skill 审查代码。")).toEqual(["arbitrary-skill", "eng-mode", "code-review"]);
	expect(sentNames(skills, background("使用 travel-planner 安排京都行程。"))).toEqual(["travel-planner"]);
	expect(sentNames([...skills].reverse(), undefined, "使用 arbitrary-skill 和 secret-skill 审查代码。")).toEqual(["arbitrary-skill", "eng-mode", "code-review"]);
});

test("empty drafts keep visible core defaults and empty catalogs send no skills", () => {
	const skills = [...catalog, { name: "how", description: "x".repeat(500) }, { name: "code-review", description: "Hidden duplicate", hide: true }];
	expect(sentSkills(skills)).toEqual([
		{ name: "eng-mode", description: catalog[0].description.slice(0, 240) },
		{ name: "how", description: "x".repeat(240) },
	]);
	expect(sentNames(skills, background("  "), "  ")).toEqual(["eng-mode", "how"]);
	expect(sentSkills([])).toEqual([]);
});

test("explicit metadata stays deterministic and bounded to sixteen entries", () => {
	const skills = Array.from({ length: 18 }, (_, index) => ({ name: `custom-${String(index).padStart(2, "0")}`, description: "d".repeat(300) }));
	const draft = skills.map(skill => skill.name).join(" ");
	expect(sentNames([...skills].reverse(), undefined, draft)).toEqual([
		"custom-00", "custom-01", "custom-02", "custom-03", "custom-04", "custom-05", "custom-06", "custom-07",
		"custom-08", "custom-09", "custom-10", "custom-11", "custom-12", "custom-13", "custom-14", "custom-15",
	]);
	expect(sentSkills([{ name: "n".repeat(110), description: "d".repeat(300) }], undefined, "n".repeat(110))).toEqual([
		{ name: "n".repeat(100), description: "d".repeat(240) },
	]);
});
