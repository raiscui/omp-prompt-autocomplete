import { expect, test } from "bun:test";
import { buildCompletionContext } from "../src/client";
import type { PromptContext } from "../src/context";
import { completionSkillContext, type ScenarioSkill } from "../src/scenarios";

const LARK_IM = "lark-im";
const SCRIPT_ANCHOR = "self-learning.script-replace-must-assert-anchor";
const NOTICE = "notice-template-review";

const LARK_IM_SKILL: ScenarioSkill = {
	name: LARK_IM,
	description: "飞书即时通讯：收发消息和管理群聊。发送和回复消息、搜索聊天记录、管理群聊成员、上传下载图片和文件、发送应用内/短信/电话加急、发送和处理交互卡片。当用户需要发消息、查看或搜索聊天记录、下载聊天中的文件、查看群成员、搜索群、创建群聊或话题群时使用。",
};

const SCRIPT_ANCHOR_SKILL: ScenarioSkill = {
	name: SCRIPT_ANCHOR,
	description: "脚本 (python/sed) 修改源码时 str.replace/sed 静默未命中的预防与排障：先断言替换锚点、核对退出码与写入后的真实内容；成功消息与实际状态矛盾时不要采信日志输出。",
};

const LARK_DOC_SKILL: ScenarioSkill = {
	name: "lark-doc",
	description: "飞书云文档：读取和编辑飞书 /docx/ /wiki/ 文档、图片附件、思维笔记与文档内表格；不适用于 Base 多维表格。",
};

const ARKCLI_AUTH_SKILL: ScenarioSkill = {
	name: "arkcli-auth",
	description: "arkcli 认证与登录：交互式登录、Volc SSO 登录、退出登录、生成 ARK API Key，以及无交互初始化 platform profile；初始化凭据失败时用于排查认证链路。",
};

/** 泛词陷阱: 与飞书/群聊无关, 但描述同时出现“消息”和“排查”。 */
const NOTICE_SKILL: ScenarioSkill = {
	name: NOTICE,
	description: "通知文案与公告模板的措辞校对、渠道配置、发布记录整理；历史消息模板归档与旧通告的排查流程说明。",
};

/** 用户真实场景里出现的那几个候选。 */
const DOMAIN_CATALOG: readonly ScenarioSkill[] = [LARK_IM_SKILL, SCRIPT_ANCHOR_SKILL, LARK_DOC_SKILL, ARKCLI_AUTH_SKILL, NOTICE_SKILL];

/**
 * 真实技能的频次门是 max(1, 目录条数 / 5)，随规模放宽；这里保持至少 15 项，使门槛达到 3，
 * 否则“消息”“排查”这类泛词会被整体过滤，回归用例在修复前就会意外变绿。
 */
const WIDER_CATALOG: readonly ScenarioSkill[] = [
	...DOMAIN_CATALOG,
	{ name: "pdf", description: "读取、合并、拆分、填写与 OCR PDF 扫描件、表单和签章；不处理演示文稿或电子表格。" },
	{ name: "minimax-xlsx", description: "打开、创建、编辑或校验 Excel 电子表格 (.xlsx, .csv)、数据透视表、财务模型与公式。" },
	{ name: "rust-async-patterns", description: "Rust 异步代码、Tokio 运行时、并发任务与错误传播模式。" },
	{ name: "unity-developer", description: "Unity 的玩法逻辑、C# 组件、界面布局、渲染管线与跨平台打包。" },
	{ name: "obsidian-vault", description: "本地笔记库的双链笔记整理、标签体系与每日复盘模板。" },
	{ name: "sre-oncall", description: "值班排期、告警分流与升级路径文档的维护。" },
	{ name: "kubernetes-ops", description: "Kubernetes 集群的滚动升级、探针配置、资源限额与节点排水。" },
	{ name: "swift-concurrency", description: "Swift 并发隔离、Actor 状态、任务取消与结构化并发检查。" },
	{ name: "django-migrations", description: "Django 数据库迁移、回滚策略、索引与查询性能调优。" },
	{ name: "figma-handoff", description: "Figma 设计稿交付、图层命名、间距标注与切图导出。" },
];

/** 通用文件管理技能: 描述覆盖文件管理, 但从不出现“整理”。 */
const FILE_MANAGER_SKILL: ScenarioSkill = {
	name: "local-file-manager",
	description: "磁盘与本地目录管理：文件的重命名、批量归档、跨目录移动、删除与恢复；不涉及云端同步。",
};

/** 只有文件管理技能真正相关, 另外两项与请求无关。 */
const FILE_CATALOG: readonly ScenarioSkill[] = [
	FILE_MANAGER_SKILL,
	{ name: "travel-planner", description: "旅行规划、行程安排与目的地建议。" },
	{ name: "rust-async-patterns", description: "Rust 异步代码、Tokio 运行时、并发任务与错误传播模式。" },
];

function background(user: string): PromptContext {
	return { cwd: "/repo", recentFiles: [], recentTurns: [{ role: "user", text: user }] };
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

/** 无论输入来自最近一轮对话还是输入框草稿, 也无论候选顺序, 发送给模型的技能必须一致。 */
function sentNamesEveryWay(skills: readonly ScenarioSkill[], user: string): string[][] {
	return [
		sentSkills(skills, background(user)).map(skill => skill.name),
		sentSkills(skills, undefined, user).map(skill => skill.name),
		sentSkills([...skills].reverse(), background(user)).map(skill => skill.name),
	];
}

test("Feishu messaging failure sends only the IM skill", () => {
	const user = "飞书群聊无法发送消息, 提示错误, 请帮我排查.";
	for (const skills of [DOMAIN_CATALOG, WIDER_CATALOG]) {
		for (const names of sentNamesEveryWay(skills, user)) {
			expect(names).toEqual([LARK_IM]);
		}
	}
});

test("Feishu messaging requests without 发送 still send the IM skill and no script skill", () => {
	for (const user of ["请查找飞书群聊里的消息。", "请查看飞书消息。"]) {
		for (const skills of [DOMAIN_CATALOG, WIDER_CATALOG]) {
			for (const names of sentNamesEveryWay(skills, user)) {
				expect(names).toContain(LARK_IM);
				expect(names).not.toContain(SCRIPT_ANCHOR);
			}
		}
	}
});

test("script-replace debugging sends only the script skill, unless it is named explicitly", () => {
	const user = "用 Python 修改源码时 str.replace 静默未命中, 但脚本打印了成功消息, 实际文件没变, 请分析原因并给出预防方法。";
	for (const skills of [DOMAIN_CATALOG, WIDER_CATALOG]) {
		for (const names of sentNamesEveryWay(skills, user)) {
			expect(names).toEqual([SCRIPT_ANCHOR]);
			expect(names).not.toContain(LARK_IM);
		}
	}
	const explicit = "使用 self-learning.script-replace-must-assert-anchor 检查 str.replace 静默未命中的原因。";
	for (const skills of [DOMAIN_CATALOG, WIDER_CATALOG]) {
		for (const names of sentNamesEveryWay(skills, explicit)) {
			expect(names).toContain(SCRIPT_ANCHOR);
			expect(names[0]).toBe(SCRIPT_ANCHOR);
		}
	}
});

test("generic 消息 and 排查 wording never substitutes for Feishu domain evidence", () => {
	const user = "飞书群聊无法发送消息, 提示错误, 请帮我排查.";
	const narrow: readonly ScenarioSkill[] = [LARK_IM_SKILL, SCRIPT_ANCHOR_SKILL, NOTICE_SKILL];
	for (const skills of [narrow, DOMAIN_CATALOG, WIDER_CATALOG]) {
		for (const names of sentNamesEveryWay(skills, user)) {
			expect(names).not.toContain(NOTICE);
			expect(names).not.toContain(SCRIPT_ANCHOR);
			expect(names).toEqual([LARK_IM]);
		}
	}
	for (const names of sentNamesEveryWay(WIDER_CATALOG, "请校对这份公告通知的措辞和模板。")) {
		expect(names).toContain(NOTICE);
	}
});

test("one request touching two real domains keeps both skills", () => {
	const user = "请查看飞书群聊里今天的消息, 另外用 Python 脚本排查 str.replace 未命中、文件内容没有变化的原因。";
	for (const skills of [DOMAIN_CATALOG, WIDER_CATALOG]) {
		for (const names of sentNamesEveryWay(skills, user)) {
			expect(names).toContain(LARK_IM);
			expect(names).toContain(SCRIPT_ANCHOR);
		}
	}
});

test("a generic file request still selects a file-management skill when nothing else competes", () => {
	const user = "请整理这些文件。";
	for (const names of sentNamesEveryWay(FILE_CATALOG, user)) {
		expect(names).toContain("local-file-manager");
	}
});
