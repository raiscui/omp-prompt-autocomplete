import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	CURSOR_MARKER,
	getEditorTheme,
	getKeybindings,
	ProcessTerminal,
	TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type CompletionPurpose, type CompletionSnapshot, completeSnapshot } from "../src/client";
import type { PromptContext } from "../src/context";
import {
	PromptAutocompleteEditor,
	type PromptAutocompleteEditorOptions,
} from "../src/editor";

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const restores: Array<{ mockRestore(): void }> = [];
const editors: PromptAutocompleteEditor[] = [];
const timers = new Map<NodeJS.Timeout, () => void>();
let nextTimer = -1;

beforeEach(() => {
	// Control only the completion debounce, leaving native editor timers untouched.
	restores.push(spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
		if (ms !== 180) return realSetTimeout(callback, ms, ...args);
		const id = nextTimer-- as unknown as NodeJS.Timeout;
		timers.set(id, () => callback(...args));
		return id;
	}) as typeof setTimeout));
	restores.push(spyOn(globalThis, "clearTimeout").mockImplementation(((id: NodeJS.Timeout) => {
		if (typeof id === "number" && id < 0) timers.delete(id);
		else realClearTimeout(id);
	}) as typeof clearTimeout));
});

afterEach(() => {
	for (const editor of editors.splice(0)) editor.dispose();
	for (const restore of restores.splice(0).reverse()) restore.mockRestore();
	timers.clear();
});

function createEditor(
	complete: (snapshot: CompletionSnapshot, signal: AbortSignal, purpose?: CompletionPurpose) => Promise<readonly string[]>,
	options: Omit<PromptAutocompleteEditorOptions, "complete"> = {},
) {
	const tui = new TUI(new ProcessTerminal());
	restores.push(spyOn(tui, "requestRender").mockImplementation(() => {}));
	const editor = new PromptAutocompleteEditor(tui, getEditorTheme(), getKeybindings(), {
		complete: async (snapshot, signal, purpose) => complete(snapshot, signal, purpose),
		...options,
	});
	editor.setSpellingFeatures({ typoDetection: false, autocorrect: false, autocomplete: "off" });
	editor.focused = true;
	editors.push(editor);
	return editor;
}

async function settle() {
	// The real request path adds hops (backend await, deadline bookkeeping); 16 microtasks settle it.
	for (let i = 0; i < 16; i++) await Promise.resolve();
}

async function debounce() {
	const scheduled = [...timers.values()];
	timers.clear();
	for (const callback of scheduled) callback();
	await settle();
}

function deferred() {
	let resolve!: (value: readonly string[] | null) => void;
	const promise = new Promise<readonly string[] | null>(done => { resolve = done; });
	return { promise, resolve };
}

function screen(editor: PromptAutocompleteEditor, width = 100) {
	return stripVTControlCharacters(editor.render(width).join("\n").replaceAll(CURSOR_MARKER, ""));
}

function described(editor: PromptAutocompleteEditor, cols = 100) {
	return JSON.stringify(editor.describe({ cols, reduceMotion: false, dark: true, supports: () => true, feature: () => false }));
}

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "google-gemini-cli",
		provider: "google-antigravity",
		model: "gemini-3.1-flash-lite",
		stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		timestamp: Date.now(),
	} as AssistantMessage;
}

const background: PromptContext = {
	cwd: "/repo",
	recentFiles: [],
	recentTurns: [
		{ role: "user", text: "这轮把失败用例修完, 不要改测试期望." },
		{ role: "assistant", text: "已修完两个用例, 剩下一个仍失败." },
	],
};

test("the list has no group headings, shows compact rows, and inserts the whole multi-line draft", async () => {
	const full = "先跑一遍失败用例，确认失败集合与这次改动相关。\n\n再只修相关代码，不改测试期望。";
	const editor = createEditor(async () => [full]);
	const sent: string[] = [];
	editor.onSubmit = text => { sent.push(text); };
	editor.setText("这轮改完了，");
	editor.render(100);
	await debounce();
	editor.handleInput("\t");
	await settle();
	const rendered = screen(editor);
	const native = described(editor);
	for (const text of [rendered, native]) {
		expect(text).not.toContain("了解仓库");
		expect(text).not.toContain("智能建议");
		expect(text).toContain("› 先跑一遍失败用例");
		expect(text).toContain("1/1");
	}
	editor.handleInput("\r");
	expect(editor.getText()).toBe(`这轮改完了，${full}`);
	expect(sent).toEqual([]);
});

test("a long multi-line candidate from the data path inserts untruncated", async () => {
	const filler = Array.from({ length: 50 }, (_, i) => `第${i + 1}步：先核对失败用例与这次改动的关联，再只修相关代码。`).join("\n");
	const candidate = `${filler}\n\n最终证据：最后一行必须完整插入。`;
	expect(candidate.length).toBeGreaterThan(1400);
	expect(candidate.length).toBeLessThanOrEqual(1800);
	const editor = createEditor((snapshot, signal, purpose) => completeSnapshot(
		async () => reply(`<ins>${candidate}</ins>`),
		snapshot,
		signal,
		{ background, purpose },
	));
	const sent: string[] = [];
	editor.onSubmit = text => { sent.push(text); };
	editor.triggerAutocomplete();
	await settle();
	expect(screen(editor)).toContain("› 第1步");
	editor.handleInput("\r");
	expect(editor.getText()).toBe(candidate);
	expect(editor.getText().endsWith("最终证据：最后一行必须完整插入。")).toBe(true);
	expect(sent).toEqual([]);
});

test("PgUp/PgDn pages the full candidate in a narrow terminal and insertion stays untruncated", async () => {
	const candidate = `${"检查边界。".repeat(200)}\n最终证据。`;
	const editor = createEditor(async () => [candidate]);
	editor.setText("这轮改完了，");
	editor.render(12);
	await debounce();
	editor.handleInput("\t");
	await settle();
	const rendered = screen(editor, 12);
	for (const row of rendered.split("\n")) expect(visibleWidth(row)).toBeLessThanOrEqual(12);
	expect(rendered.split("\n").length).toBeLessThanOrEqual(24);
	for (let index = 0; index < 60; index++) { editor.handleInput("\x1b[6~"); screen(editor, 12); }
	expect(screen(editor, 12)).toContain("最终证据");
	for (let index = 0; index < 60; index++) { editor.handleInput("\x1b[5~"); screen(editor, 12); }
	expect(screen(editor, 12)).not.toContain("最终证据");
	editor.handleInput("\r");
	expect(editor.getText()).toBe(`这轮改完了，${candidate}`);
});

test("the inline ghost stays one line and never exceeds 160 characters", async () => {
	const candidate = `${"word ".repeat(60)}\nsecond line stays out of the ghost`;
	const editor = createEditor(async () => [candidate]);
	editor.setText("Explain ");
	editor.render(100);
	await debounce();
	const rendered = screen(editor);
	expect(rendered).toContain("建议: word");
	expect(rendered).not.toContain("second line");
	for (const row of rendered.split("\n")) {
		if (row.includes("建议:")) expect(row.length).toBeLessThanOrEqual("建议: ".length + 160);
	}
	editor.handleInput("\t");
	await settle();
	editor.handleInput("\r");
	expect(editor.getText()).toBe(`Explain ${candidate}`);
});

test("Ctrl+Right steps one word of the ghost and the list inserts the rest", async () => {
	const editor = createEditor((snapshot, signal, purpose) => completeSnapshot(
		async () => reply("<ins>Explain the failure path</ins>"),
		snapshot,
		signal,
		{ purpose },
	));
	editor.setText("Explain ");
	editor.render(100);
	await debounce();
	editor.handleInput("\x1b[1;5C");
	expect(editor.getText()).toBe("Explain the");
	editor.handleInput("\t");
	await settle();
	editor.handleInput("\r");
	expect(editor.getText()).toBe("Explain the failure path");
});

test("whitespace-only drafts trigger the empty-editor request and insert as a replacement", async () => {
	const snapshots: CompletionSnapshot[] = [];
	const purposes: Array<CompletionPurpose | undefined> = [];
	const editor = createEditor(async (snapshot, _signal, purpose) => {
		snapshots.push(snapshot);
		purposes.push(purpose);
		return ["next step"];
	});
	editor.setText(" \n  ");
	editor.render(100);
	await debounce();
	expect(snapshots).toEqual([{ prefix: "", suffix: "" }]);
	expect(purposes).toEqual(["ghost"]);
	editor.triggerAutocomplete();
	await settle();
	expect(purposes).toEqual(["ghost", "list"]);
	expect(screen(editor)).toContain("› next step");
	editor.handleInput("\r");
	expect(editor.getText()).toBe("next step");
});

test("a pending list shows the loading row and typing cancels the request", async () => {
	const result = deferred();
	let signal: AbortSignal | undefined;
	const editor = createEditor(async (_snapshot, requestSignal) => {
		signal = requestSignal;
		return (await result.promise) ?? [];
	});
	editor.setText("Explain ");
	editor.render(100);
	await debounce();
	editor.handleInput("\t");
	expect(screen(editor)).toContain("正在获取建议…");
	editor.handleInput("x");
	expect(signal?.aborted).toBe(true);
	result.resolve(["stale direction"]);
	await settle();
	expect(screen(editor)).not.toContain("stale direction");
	expect(editor.getText()).toBe("Explain x");
});

test("Esc closes the list, the next Esc dismisses the suggestion, and the third interrupts", async () => {
	const editor = createEditor(async () => ["the evidence"]);
	let interrupts = 0;
	editor.onEscape = () => { interrupts++; };
	editor.setText("Explain ");
	editor.render(100);
	await debounce();
	editor.triggerAutocomplete();
	await settle();
	expect(screen(editor)).toContain("› the evidence");
	editor.handleInput("\x1b");
	expect(screen(editor)).not.toContain("› the evidence");
	expect(interrupts).toBe(0);
	editor.handleInput("\x1b");
	expect(interrupts).toBe(0);
	editor.handleInput("\x1b");
	expect(interrupts).toBe(1);
});

test("native priority keeps the list closed, and an empty list consumes Enter without sending", async () => {
	const editor = createEditor(async () => []);
	const sent: string[] = [];
	editor.onSubmit = text => { sent.push(text); };
	editor.setText("$skill ");
	editor.triggerAutocomplete();
	expect(screen(editor)).not.toContain("›");

	editor.setText("Explain ");
	editor.triggerAutocomplete();
	await settle();
	expect(screen(editor)).toContain("暂无建议");
	editor.handleInput("\r");
	expect(editor.getText()).toBe("Explain ");
	expect(sent).toEqual([]);
});
