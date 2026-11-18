import { expect, test } from "bun:test";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import {
	type CompletionBackend,
	completeSnapshot,
	completionSettings,
	insertionText,
	MAX_CANDIDATES,
	normalizeCompletionText,
} from "../src/client";

const idleSignal = new AbortController().signal;
const background = { cwd: "/project", recentTurns: [{ role: "user" as const, text: "请继续完善项目." }], recentFiles: [] };

function reply(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "google-gemini-cli",
		provider: "google-antigravity",
		model: "gemini-3.1-flash-lite",
		stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		timestamp: Date.now(),
		...extra,
	} as AssistantMessage;
}

function recording(result: AssistantMessage): { backend: CompletionBackend; calls: Context[] } {
	const calls: Context[] = [];
	const backend: CompletionBackend = async context => {
		calls.push(context);
		return result;
	};
	return { backend, calls };
}

test("budgets split by input state and purpose, with the empty default keeping 2048 tokens", () => {
	expect(completionSettings({ prefix: "", suffix: "" })).toEqual({ maxTokens: 2048, deadlineMs: 60000, maxOutputChars: 1800 });
	expect(completionSettings({ prefix: "", suffix: "" }, "list")).toEqual({ maxTokens: 2048, deadlineMs: 60000, maxOutputChars: 1800 });
	expect(completionSettings({ prefix: "", suffix: "" }, "ghost")).toEqual({ maxTokens: 512, deadlineMs: 6000, maxOutputChars: 200 });
	expect(completionSettings({ prefix: "half a draft", suffix: "" }, "ghost")).toEqual({ maxTokens: 288, deadlineMs: 4000, maxOutputChars: 400 });
	expect(completionSettings({ prefix: "half a draft", suffix: "" }, "list")).toEqual({ maxTokens: 1024, deadlineMs: 60000, maxOutputChars: 1400 });
	expect(completionSettings({ prefix: "", suffix: "trailing" }, "ghost")).toEqual({ maxTokens: 288, deadlineMs: 4000, maxOutputChars: 400 });
	expect(completionSettings({ prefix: "", suffix: "trailing" })).toEqual({ maxTokens: 1024, deadlineMs: 60000, maxOutputChars: 1400 });
});

test("a multi-line send-ready candidate survives normalization whole", async () => {
	const candidate = `第一步：运行 bun run test，确认失败集合与这次改动相关。\n\n第二步：只修相关代码，不改测试期望。\n\n第三步：把命令和结果贴出来。`;
	const { backend } = recording(reply(`<ins>${candidate}</ins>`));
	expect(await completeSnapshot(backend, { prefix: "", suffix: "" }, idleSignal, { background })).toEqual([candidate]);
});

test("the draft list keeps a long paragraph and cuts on a late line break, not mid-sentence", async () => {
	const head = "a".repeat(1200);
	const candidate = `${head}\n${"b".repeat(400)}`;
	const { backend } = recording(reply(`<ins>${candidate}</ins>`));
	const [text] = await completeSnapshot(backend, { prefix: "x", suffix: "" }, idleSignal, { purpose: "list" });
	expect(text).toBe(head);
	expect(text.length).toBeLessThanOrEqual(1400);
});

test("normalization trims blank edge lines while keeping interior breaks and leading spaces", () => {
	expect(normalizeCompletionText("\n\n  first line\n\nsecond line\n\n")).toBe("  first line\n\nsecond line");
	expect(normalizeCompletionText("first\r\nsecond")).toBe("first\nsecond");
	expect(normalizeCompletionText("\n\n")).toBeNull();
});

test("an echoed draft is stripped to the new characters", async () => {
	expect(insertionText({ prefix: "Please fix the ", suffix: "" }, "Please fix the bug")).toBe("bug");
	expect(insertionText({ prefix: "Please ", suffix: " now." }, "Please fix it now.")).toBe("fix it");
	expect(insertionText({ prefix: "", suffix: "" }, "whole message")).toBe("whole message");

	const echoed = recording(reply("<ins>Please fix the bug today.</ins>"));
	expect(await completeSnapshot(echoed.backend, { prefix: "Please fix the ", suffix: "" }, idleSignal)).toEqual(["bug today."]);
	const bounded = recording(reply("<ins>Please fix it now.</ins>"));
	expect(await completeSnapshot(bounded.backend, { prefix: "Please ", suffix: " now." }, idleSignal)).toEqual(["fix it"]);
});

test("one ins block is one candidate and the hard cap is three", async () => {
	const single = recording(reply("<ins>only one action</ins>"));
	expect(await completeSnapshot(single.backend, { prefix: "Please", suffix: "" }, idleSignal)).toEqual(["only one action"]);
	const many = recording(reply(["one action", "two action", "three action", "four action", "five action"].map(text => `<ins> ${text}</ins>`).join("\n")));
	const kept = await completeSnapshot(many.backend, { prefix: "Please", suffix: "" }, idleSignal);
	expect(kept).toEqual([" one action", " two action", " three action"]);
	expect(kept.length).toBe(MAX_CANDIDATES);
});

test("exact duplicates and 80%-overlapping rewordings are dropped, a contained short action is kept", async () => {
	const exact = recording(reply("<ins> add tests.</ins><ins> add tests.</ins><ins> update docs.</ins>"));
	expect(await completeSnapshot(exact.backend, { prefix: "Please", suffix: "" }, idleSignal)).toEqual([" add tests.", " update docs."]);

	const near = recording(reply([
		"<ins>run unit tests on login</ins>",
		"<ins>run unit tests on login module</ins>",
		"<ins>add tests</ins>",
		"<ins>add tests for the parser</ins>",
	].join("\n")));
	expect(await completeSnapshot(near.backend, { prefix: "Please ", suffix: "" }, idleSignal)).toEqual([
		"run unit tests on login",
		"add tests",
		"add tests for the parser",
	]);
});

test("a length-truncated list reply is discarded while a one-line ghost keeps it", async () => {
	const truncated = recording(reply("<ins>half of a paragraph</ins>", { stopReason: "length" }));
	expect(await completeSnapshot(truncated.backend, { prefix: "x", suffix: "" }, idleSignal, { purpose: "list" })).toEqual([]);
	expect(await completeSnapshot(truncated.backend, { prefix: "x", suffix: "" }, idleSignal, { purpose: "ghost" })).toEqual(["half of a paragraph"]);
});

test("an empty editor without a real turn makes no request, even with skill metadata", async () => {
	const { backend, calls } = recording(reply("<ins>unexpected</ins>"));
	const skillContext = JSON.stringify([{ name: "how", description: "Trace code" }]);
	expect(await completeSnapshot(backend, { prefix: "", suffix: "" }, idleSignal)).toEqual([]);
	expect(await completeSnapshot(backend, { prefix: "", suffix: "" }, idleSignal, { skillContext })).toEqual([]);
	expect(await completeSnapshot(backend, { prefix: "", suffix: "" }, idleSignal, { skillContext, purpose: "ghost" })).toEqual([]);
	expect(await completeSnapshot(backend, { prefix: "", suffix: "" }, idleSignal, {
		skillContext,
		background: { cwd: "/project", recentFiles: [], recentTurns: [{ role: "assistant", text: "   " }] },
	})).toEqual([]);
	expect(calls.length).toBe(0);

	// A draft with skill metadata is a real task, so it does request.
	expect(await completeSnapshot(backend, { prefix: "hello", suffix: "" }, idleSignal, { skillContext })).toEqual(["unexpected"]);
	expect(calls.length).toBe(1);
});

test("ghost and list requests send different instructions and budgets", async () => {
	const { backend, calls } = recording(reply("<ins>next</ins>"));
	await completeSnapshot(backend, { prefix: "half a sentence, ", suffix: "" }, idleSignal, { purpose: "ghost" });
	await completeSnapshot(backend, { prefix: "half a sentence, ", suffix: "" }, idleSignal, { purpose: "list" });
	expect(calls.length).toBe(2);
	expect(calls[0].systemPrompt).not.toEqual(calls[1].systemPrompt);
	expect(JSON.stringify(calls[0].systemPrompt)).toContain("at most 12 words");
	expect(JSON.stringify(calls[1].systemPrompt)).not.toContain("at most 12 words");
});
