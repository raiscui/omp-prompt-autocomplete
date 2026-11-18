import { afterEach, expect, spyOn, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, getEditorTheme, getKeybindings, ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { buildCompletionContext, completeSnapshot, SYSTEM_PROMPT } from "../src/client";
import type { PromptContext } from "../src/context";
import { PromptAutocompleteEditor, type PromptAutocompleteEditorOptions } from "../src/editor";
import { completionRouteContext, completionSkillContext } from "../src/scenarios";

const editors: PromptAutocompleteEditor[] = [];
const restores: Array<{ mockRestore(): void }> = [];
afterEach(() => {
	for (const editor of editors.splice(0)) editor.dispose();
	for (const restore of restores.splice(0)) restore.mockRestore();
});

function editorWith(options: Partial<PromptAutocompleteEditorOptions> = {}) {
	const tui = new TUI(new ProcessTerminal());
	restores.push(spyOn(tui, "requestRender").mockImplementation(() => {}));
	const editor = new PromptAutocompleteEditor(tui, getEditorTheme(), getKeybindings(), {
		complete: async () => [], ...options,
	});
	editor.setSpellingFeatures({ typoDetection: false, autocorrect: false, autocomplete: "off" });
	editor.focused = true;
	editors.push(editor);
	return editor;
}

function screen(editor: PromptAutocompleteEditor, width = 100) {
	return stripVTControlCharacters(editor.render(width).join("\n").replaceAll(CURSOR_MARKER, ""));
}

async function settle() {
	for (let index = 0; index < 8; index++) await Promise.resolve();
}

const context: PromptContext = { cwd: "/repo", recentFiles: [], recentTurns: [{ role: "user", text: "我们讨论的设计方案需要检查数据库事务边界。" }] };

test("arbitrary visible skill metadata is bounded and relevant skills precede unrelated entries", () => {
	const skills = Array.from({ length: 30 }, (_, index) => ({ name: `unrelated-${index}`, description: "x".repeat(500) }));
	skills.push({ name: "database-review", description: "数据库事务边界" });
	const metadata = completionSkillContext([...skills, { name: "hidden-secret", description: "secret", hide: true }, { name: "database-review", description: "duplicate" }], context);
	const parsed = JSON.parse(metadata);
	expect(parsed).toEqual([{ name: "database-review", description: "数据库事务边界" }]);
	expect(metadata).not.toContain("hidden-secret");
	const request = buildCompletionContext({ prefix: "", suffix: "" }, context, metadata);
	expect(request.messages[0].content).toContain("database-review");
	expect(request.messages[0].content).not.toContain("hidden-secret");
	expect(completionSkillContext([{ name: "same", description: "visible" }, { name: "same", description: "hidden", hide: true }])).toBe("[]");
});

test("Chinese division of work and joint acceptance shortlist Fabric workflow for an empty editor", () => {
	const commands = Array.from({ length: 30 }, (_, index) => ({
		name: "check-" + index, description: "梳理", source: "skill" as const,
	}));
	commands.push({ name: "skill:fabric-workflow", description: "Discover, fan out and verify", source: "skill" });
	const shortlist = (text: string) => completionRouteContext(commands, {
		...context, recentTurns: [{ role: "user", text }],
	}).map(route => route.invocation);
	const distributed = shortlist("先梳理、再独立分工、最后统一验收");
	expect(distributed).toHaveLength(24);
	expect(distributed).toContain("/skill:fabric-workflow");
	expect(shortlist("我自己先梳理需求，最后验收")).not.toContain("/skill:fabric-workflow");
});

function reply(text: string): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text }], api: "google-gemini-cli",
		provider: "google-antigravity", model: "gemini-3.1-flash-lite", stopReason: "stop", timestamp: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

test("settings failure selects loaded engineering skills over cloud and messaging descriptions", () => {
	const skills = [
		...Array.from({ length: 24 }, (_, index) => ({ name: `${index % 2 ? "arkcli" : "bailian"}-${index}`, description: "使用云服务保存配置，错误和失败诊断，审查设置。" })),
		{ name: "lark-im", description: "飞书消息、错误、保存、失败" },
		{ name: "eng-mode", description: "Engineering workflows" },
		{ name: "code-review", description: "Review code changes" },
	];
	const background: PromptContext = { cwd: "/repo", recentFiles: [], recentTurns: [{ role: "user", text: "请审查设置页保存失败的改动和错误提示。" }] };
	const selected = completionSkillContext(skills, background);
	expect(JSON.parse(selected).map((skill: { name: string }) => skill.name)).toEqual(["eng-mode", "code-review"]);
	expect(completionSkillContext([...skills].reverse(), background)).toBe(selected);
});

test("short skill names require complete names and explicit arbitrary skills remain eligible", () => {
	const skills = [{ name: "pr", description: "Publish a pull request" }, { name: "how", description: "Trace code" }, { name: "custom-audit", description: "Inspect ledger" }];
	expect(completionSkillContext(skills, undefined, "Improve this prompt and show the result")).toBe("[]");
	expect(JSON.parse(completionSkillContext(skills, undefined, "Use custom-audit")).map((skill: { name: string }) => skill.name)).toEqual(["custom-audit"]);
	expect(JSON.parse(completionSkillContext(skills, undefined, "Use pr")).map((skill: { name: string }) => skill.name)).toEqual(["pr"]);
});

test("no-history policy selects only visible loaded core skills and caps metadata", () => {
	const skills = [{ name: "unrelated", description: "cloud" }, { name: "how", description: "x".repeat(500) }, { name: "eng-mode", description: "Engineering" }, { name: "how", description: "duplicate" }, { name: "tdd", description: "visible" }, { name: "tdd", description: "hidden", hide: true }];
	expect(JSON.parse(completionSkillContext(skills))).toEqual([{ name: "eng-mode", description: "Engineering" }, { name: "how", description: "x".repeat(240) }]);
	expect(completionSkillContext([{ name: "unrelated", description: "cloud" }])).toBe("[]");
});

test("typed draft uses skills only for continuation and inserts only the new characters", async () => {
	const requests: Context[] = [];
	const editor = editorWith({ complete: (snapshot, signal) => completeSnapshot(async request => {
		requests.push(request);
		return reply("<ins>g in settings.</ins>");
	}, snapshot, signal, { skillContext: completionSkillContext([{ name: "eng-mode", description: "Engineering" }], undefined, "fix code") }) });
	editor.setText("Please fix the bu");
	editor.triggerAutocomplete();
	await settle();
	expect(screen(editor)).toContain("› g in settings.");
	editor.handleInput("\r");
	expect(editor.getText()).toBe("Please fix the bug in settings.");
	expect(requests).toHaveLength(1);
	expect(JSON.stringify(requests[0].systemPrompt)).toContain("Never add requirements, a checklist, proof obligations");
	expect(JSON.stringify(requests[0].systemPrompt)).not.toContain("Suggest the user's outcome");
	expect(requests[0].messages[0].content).toContain("eng-mode");
	expect(buildCompletionContext({ prefix: "Please fix the bu", suffix: "" }).systemPrompt).toEqual([SYSTEM_PROMPT]);
});

test("Enter accepts a multiline slash suggestion before submitting it", async () => {
	const suggestion = "/skill:fabric-workflow 分头核查安装和卸载。\n最后统一验收。";
	const editor = editorWith({ complete: async () => [suggestion] });
	const submitted: string[] = [];
	editor.onSubmit = text => { submitted.push(text); };
	editor.handleInput("\t");
	await settle();
	editor.handleInput("\r");
	expect(editor.getText()).toBe(suggestion);
	expect(submitted).toEqual([]);
	editor.handleInput("\r");
	expect(submitted).toEqual([suggestion]);
});

test("closing a pending panel cannot be undone by a late reply", async () => {
	const { promise, resolve } = Promise.withResolvers<readonly string[]>();
	const editor = editorWith({ complete: () => promise });
	editor.triggerAutocomplete();
	editor.handleInput("\x1b");
	resolve(["请验证当前任务的实际完成条件。"]);
	await settle();
	expect(screen(editor)).not.toContain("› ");
	expect(screen(editor)).toContain("建议: 请验证当前任务的实际完成条件。");
	editor.handleInput("\t");
	await settle();
	expect(screen(editor)).toContain("› 请验证当前任务的实际完成条件。");
});

test("input, focus, native hints, busy and disposal retire an open panel", async () => {
	for (const invalidate of [
		(editor: PromptAutocompleteEditor) => editor.handleInput("新的草稿"),
		(editor: PromptAutocompleteEditor) => { editor.focused = false; },
		(editor: PromptAutocompleteEditor) => editor.setAutocompleteProvider({ getSuggestions: async () => null, applyCompletion: (_lines, _line, _col, _item) => ({ lines: [], cursorLine: 0, cursorCol: 0 }), getInlineHint: () => "native hint" }),
		(editor: PromptAutocompleteEditor) => editor.setAgentBusy(true),
		(editor: PromptAutocompleteEditor) => editor.dispose(),
	]) {
		const editor = editorWith({ complete: async () => ["模型建议"] });
		editor.triggerAutocomplete();
		await settle();
		expect(screen(editor)).toContain("› 模型建议");
		invalidate(editor);
		expect(screen(editor)).not.toContain("› 模型建议");
	}
});

test("native tokens retain priority while an ordinary draft still uses string completions", async () => {
	const editor = editorWith({ complete: async () => ["the evidence"] });
	for (const draft of ["/help", "!pwd", "$how", "@file", "^model", "src/file"]) {
		editor.setText(draft);
		editor.triggerAutocomplete();
		expect(screen(editor)).not.toContain("the evidence");
		expect(editor.getText()).toBe(draft);
	}
	editor.setText("Explain ");
	editor.triggerAutocomplete();
	await settle();
	expect(screen(editor)).toContain("› the evidence");
	editor.handleInput("\r");
	expect(editor.getText()).toBe("Explain the evidence");
});

test("no task basis makes no request, and a failing model leaves the editor unchanged", async () => {
	let calls = 0;
	const skillContext = completionSkillContext([{ name: "eng-mode", description: "Engineering" }]);
	const silent = editorWith({
		complete: (snapshot, signal) => completeSnapshot(async () => { calls++; return reply("<ins>unexpected</ins>"); }, snapshot, signal, { skillContext }),
	});
	silent.triggerAutocomplete();
	await settle();
	expect(calls).toBe(0);
	expect(screen(silent)).toContain("暂无建议");
	silent.handleInput("\r");
	expect(silent.getText()).toBe("");

	const errors: unknown[] = [];
	const failing = editorWith({ complete: async () => { throw new Error("model unavailable"); }, onError: error => errors.push(error) });
	failing.triggerAutocomplete();
	await settle();
	expect(errors).toHaveLength(1);
	expect(screen(failing)).not.toContain("› ");
	expect(failing.getText()).toBe("");
});
