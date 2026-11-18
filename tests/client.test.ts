import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import {
	buildCompletionContext,
	type CompletionBackend,
	completeSnapshot,
	completionSettings,
	MAX_PREFIX_CHARS,
	MAX_SUFFIX_CHARS,
	normalizeCompletionText,
	SYSTEM_PROMPT,
} from "../src/client";

const idleSignal = new AbortController().signal;
const background = { cwd: "/project", recentTurns: [{ role: "user" as const, text: "请继续完善项目." }], recentFiles: [] };
const emptyDraft = { prefix: "", suffix: "" };
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

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

function recording(result: AssistantMessage | Error): { backend: CompletionBackend; calls: Array<{ context: Context; signal: AbortSignal }> } {
	const calls: Array<{ context: Context; signal: AbortSignal }> = [];
	const backend: CompletionBackend = async (context, signal) => {
		calls.push({ context, signal });
		if (result instanceof Error) throw result;
		return result;
	};
	return { backend, calls };
}

function draftOf(context: Context): { prefix: string; suffix: string } {
	const [message] = context.messages;
	if (message.role !== "user" || typeof message.content !== "string") throw new Error("expected one text user message");
	const draft = /(?:^|\n)Draft: (.*)$/.exec(message.content)?.[1];
	if (!draft) throw new Error("expected a Draft line");
	return JSON.parse(draft);
}

async function errorOf(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error(`non-Error rejection: ${String(error)}`);
	}
	throw new Error("expected rejection");
}

test("empty editor preserves registered invocations and drops unknown commands", async () => {
	const registered = "/skill:fabric-workflow 分头检查安装和卸载流程，再统一验收。";
	const { backend } = recording(reply(
		"<ins>/skill:fabric-workflow-extra 检查安装流程。</ins><ins>" + registered + "</ins>",
	));
	const routes = [{ invocation: "/skill:fabric-workflow", description: "", source: "skill" as const }];
	expect(await completeSnapshot(backend, emptyDraft, idleSignal, { background, routes })).toEqual([registered]);
});

describe("buildCompletionContext", () => {
	test("sends the system instruction and the draft as one JSON user turn", () => {
		const context = buildCompletionContext({ prefix: "hello wo", suffix: "\n" });
		expect(context.systemPrompt).toEqual([SYSTEM_PROMPT]);
		expect(context.messages.length).toBe(1);
		expect(context.tools).toBeUndefined();
		expect(draftOf(context)).toEqual({ prefix: "hello wo", suffix: "\n" });
	});

	test("bounds the draft to the tail of the prefix and head of the suffix without splitting pairs", () => {
		const prefix = `${"p".repeat(MAX_PREFIX_CHARS - 1)}\u{1F600}${"q".repeat(10)}`;
		const suffix = `${"s".repeat(MAX_SUFFIX_CHARS - 1)}\u{1F600}${"t".repeat(10)}`;
		const draft = draftOf(buildCompletionContext({ prefix, suffix }));
		expect(draft.prefix.length).toBeLessThanOrEqual(MAX_PREFIX_CHARS);
		expect(draft.prefix.endsWith("q".repeat(10))).toBe(true);
		expect(draft.suffix.length).toBeLessThanOrEqual(MAX_SUFFIX_CHARS);
		expect(draft.suffix.startsWith("s".repeat(10))).toBe(true);
		expect(LONE_SURROGATE.test(draft.prefix)).toBe(false);
		expect(LONE_SURROGATE.test(draft.suffix)).toBe(false);
	});

});

describe("completeSnapshot", () => {
	test("按输入状态与用途选择预算, 空框默认用途保持 2048 tokens", () => {
		expect(completionSettings(emptyDraft)).toEqual({ maxTokens: 2048, deadlineMs: 60000, maxOutputChars: 1800 });
		expect(completionSettings(emptyDraft, "list")).toEqual({ maxTokens: 2048, deadlineMs: 60000, maxOutputChars: 1800 });
		expect(completionSettings(emptyDraft, "ghost")).toEqual({ maxTokens: 512, deadlineMs: 6000, maxOutputChars: 200 });
		expect(completionSettings({ prefix: "x", suffix: "" })).toEqual({ maxTokens: 1024, deadlineMs: 60000, maxOutputChars: 1400 });
		expect(completionSettings({ prefix: "x", suffix: "" }, "list")).toEqual({ maxTokens: 1024, deadlineMs: 60000, maxOutputChars: 1400 });
		expect(completionSettings({ prefix: "x", suffix: "" }, "ghost")).toEqual({ maxTokens: 288, deadlineMs: 4000, maxOutputChars: 400 });
		expect(completionSettings({ prefix: "", suffix: "x" }, "ghost")).toEqual({ maxTokens: 288, deadlineMs: 4000, maxOutputChars: 400 });
		expect(completionSettings({ prefix: "", suffix: "x" }, "list")).toEqual({ maxTokens: 1024, deadlineMs: 60000, maxOutputChars: 1400 });
	});

	test("空框没有有效对话背景时不请求", async () => {
		const { backend, calls } = recording(reply("不应调用"));
		expect(await completeSnapshot(backend, emptyDraft, idleSignal)).toEqual([]);
		expect(await completeSnapshot(backend, emptyDraft, idleSignal, { background: { ...background, recentTurns: [] } })).toEqual([]);
		expect(await completeSnapshot(backend, emptyDraft, idleSignal, { background: { ...background, recentTurns: [{ role: "user", text: "  " }] } })).toEqual([]);
		expect(calls.length).toBe(0);
	});

	test("空框请求仍遵循取消和超时", async () => {
		const waiting: CompletionBackend = (_context, signal) => {
			const { promise, reject } = Promise.withResolvers<AssistantMessage>();
			signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
			return promise;
		};
		const controller = new AbortController();
		const pending = completeSnapshot(waiting, emptyDraft, controller.signal, { background });
		controller.abort();
		expect((await errorOf(pending)).name).toBe("AbortError");
		expect(await completeSnapshot(waiting, emptyDraft, idleSignal, { background, deadlineMs: 5 })).toEqual([]);
	});
	test("returns the normalised text of the reply", async () => {
		const { backend, calls } = recording(reply("rld\nignored"));
		const text = await completeSnapshot(backend, { prefix: "hello wo", suffix: "" }, idleSignal);
		expect(text).toEqual(["rld\nignored"]);
		expect(calls.length).toBe(1);
		expect(draftOf(calls[0].context)).toEqual({ prefix: "hello wo", suffix: "" });
	});

	test("concatenates text blocks and ignores thinking", async () => {
		const { backend } = recording(
			reply("", { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "r" }, { type: "text", text: "ld" }] } as Partial<AssistantMessage>),
		);
		expect(await completeSnapshot(backend, { prefix: "wo", suffix: "" }, idleSignal)).toEqual(["rld"]);
	});

	test("an empty or whitespace reply yields null", async () => {
		expect(await completeSnapshot(recording(reply("")).backend, { prefix: "x", suffix: "" }, idleSignal)).toEqual([]);
		expect(await completeSnapshot(recording(reply("  \n")).backend, { prefix: "x", suffix: "" }, idleSignal)).toEqual([]);
	});

	test("drops suggestions where the agent answers the draft, keeps the user's own next words", async () => {
		const suggest = async (prefix: string, raw: string) =>
			completeSnapshot(recording(reply(`<ins>${raw}</ins>`)).backend, { prefix, suffix: "" }, idleSignal);
		const answers: Array<[string, string]> = [
			["Please fix this issue", " Yeah I will do that"],
			["Please fix this issue", " Sure, on it."],
			["Can you add tests for the parser? ", "Got it."],
			["Please fix this issue. ", "I'll fix it now."],
			["Run the tests.", " Let me check the failures."],
			['Use "strict".', " I\u2019m going to update the config."],
			["请修复问题", "好的，我来处理。"],
			["请修复问题。", "我来检查一下。"],
		];
		for (const [prefix, raw] of answers) {
			expect(await suggest(prefix, raw)).toEqual([]);
		}
		const ownWords: Array<[string, string, string]> = [
			["Can you make", " sure the tests pass?", " sure the tests pass?"],
			["Is it", " OK to delete this file?", " OK to delete this file?"],
			["Check why it fails when", " I will run it in CI.", " I will run it in CI."],
			["Please fix this issue. ", "Let me know if anything is unclear.", "Let me know if anything is unclear."],
			["Please fix this issue. Su", "re the cache is cleared first.", "re the cache is cleared first."],
			["Please fix this issue. ", "Also add a regression test.", "Also add a regression test."],
		];
		for (const [prefix, raw, expected] of ownWords) {
			expect(await suggest(prefix, raw)).toEqual([expected]);
		}
	});

	test("throws an AbortError when the caller aborts, before or during the request", async () => {
		const aborted = new AbortController();
		aborted.abort();
		const { backend, calls } = recording(reply("never"));
		expect((await errorOf(completeSnapshot(backend, { prefix: "x", suffix: "" }, aborted.signal))).name).toBe("AbortError");
		expect(calls.length).toBe(0);

		const controller = new AbortController();
		const slow: CompletionBackend = (_context, signal) => {
			const { promise, reject } = Promise.withResolvers<AssistantMessage>();
			signal.addEventListener("abort", () => reject(new Error("socket closed")), { once: true });
			return promise;
		};
		const pending = completeSnapshot(slow, { prefix: "x", suffix: "" }, controller.signal);
		controller.abort();
		expect((await errorOf(pending)).name).toBe("AbortError");
	});

	test("the request signal follows the caller's signal", async () => {
		const controller = new AbortController();
		const { backend, calls } = recording(reply("ok"));
		await completeSnapshot(backend, { prefix: "x", suffix: "" }, controller.signal);
		expect(calls[0].signal.aborted).toBe(false);
		controller.abort();
		expect(calls[0].signal.aborted).toBe(true);
	});

	test("a reply that arrives after the caller aborted is discarded as an abort", async () => {
		const controller = new AbortController();
		const backend: CompletionBackend = async () => {
			controller.abort();
			return reply("late");
		};
		expect((await errorOf(completeSnapshot(backend, { prefix: "x", suffix: "" }, controller.signal))).name).toBe("AbortError");
	});

	test("a deadline yields null instead of an error, whether the backend rejects or reports aborted", async () => {
		const rejecting: CompletionBackend = (_context, signal) => {
			const { promise, reject } = Promise.withResolvers<AssistantMessage>();
			signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
			return promise;
		};
		expect(await completeSnapshot(rejecting, { prefix: "x", suffix: "" }, idleSignal, { deadlineMs: 5 })).toEqual([]);

		const reporting: CompletionBackend = (_context, signal) => {
			const { promise, resolve } = Promise.withResolvers<AssistantMessage>();
			signal.addEventListener("abort", () => resolve(reply("", { stopReason: "aborted" })), { once: true });
			return promise;
		};
		expect(await completeSnapshot(reporting, { prefix: "x", suffix: "" }, idleSignal, { deadlineMs: 5 })).toEqual([]);
	});

	test("provider errors surface as a one-line error without the draft", async () => {
		const { backend } = recording(reply("", { stopReason: "error", errorMessage: "401 unauthorized\nbody: SECRET DRAFT" }));
		const error = await errorOf(completeSnapshot(backend, { prefix: "SECRET DRAFT", suffix: "" }, idleSignal));
		expect(error.message).toBe("401 unauthorized");
		expect(error.message).not.toContain("SECRET");

		const thrown = await errorOf(completeSnapshot(recording(new Error("network down")).backend, { prefix: "x", suffix: "" }, idleSignal));
		expect(thrown.message).toBe("network down");
	});

	test("requires a signal", async () => {
		const { backend } = recording(reply("x"));
		await expect(completeSnapshot(backend, { prefix: "x", suffix: "" }, undefined as unknown as AbortSignal)).rejects.toThrow("AbortSignal is required");
	});

	test("一次请求独立过滤、去重并最多返回三个候选", async () => {
		const { backend, calls } = recording(reply("<ins> Sure, on it.</ins>\n<ins> add tests.</ins>\n<ins> add tests.</ins>\n<ins> update docs.</ins>\n<ins> check types.</ins>\n<ins> extra.</ins>"));
		expect(await completeSnapshot(backend, { prefix: "Please", suffix: "" }, idleSignal)).toEqual([" add tests.", " update docs.", " check types."]);
		expect(calls.length).toBe(1);
	});
});

describe("normalizeCompletionText", () => {
	test("keeps interior line breaks and trims blank leading and trailing lines", () => {
		expect(normalizeCompletionText("rld\nextra line")).toBe("rld\nextra line");
		expect(normalizeCompletionText("first\r\nsecond")).toBe("first\nsecond");
		expect(normalizeCompletionText("rld\n")).toBe("rld");
		expect(normalizeCompletionText("\n\n  return value;")).toBe("  return value;");
		expect(normalizeCompletionText("first\n\nsecond")).toBe("first\n\nsecond");
	});

	test("keeps leading spaces and a leading-space continuation", () => {
		expect(normalizeCompletionText(" world")).toBe(" world");
		expect(normalizeCompletionText("  return value;")).toBe("  return value;");
	});

	test("unwraps the ins wrapper, keeping leading spaces, and tolerates a missing close", () => {
		expect(normalizeCompletionText("<ins> error handling.</ins>")).toBe(" error handling.");
		expect(normalizeCompletionText("Output: <ins>led.</ins> trailing chatter")).toBe("led.");
		expect(normalizeCompletionText("<ins>unterminated")).toBe("unterminated");
		expect(normalizeCompletionText("<ins></ins>")).toBeNull();
		expect(normalizeCompletionText('led API requests."')).toBe('led API requests."');
	});

	test("removes C0/C1 controls and whole ANSI escape sequences", () => {
		expect(normalizeCompletionText("a\u0007b\u009bc")).toBe("abc");
		expect(normalizeCompletionText("a\tb")).toBe("a b");
		expect(normalizeCompletionText("\u001b[31mred\u001b[0m")).toBe("red");
		expect(normalizeCompletionText("\u001b]0;title\u0007rld")).toBe("rld");
		expect(normalizeCompletionText("\u{1F600}ok \u00e9\u0e44\u0e17\u0e22")).toBe("\u{1F600}ok \u00e9\u0e44\u0e17\u0e22");
	});

	test("rejects reasoning output instead of showing it", () => {
		expect(normalizeCompletionText("<thinking>weighing options</thinking>rld")).toBeNull();
		expect(normalizeCompletionText("<thinking>weighing")).toBeNull();
		expect(normalizeCompletionText("Thinking: the user wants")).toBeNull();
		expect(normalizeCompletionText("Reasoning - because")).toBeNull();
	});

	test("stops at chat and other special tokens", () => {
		expect(normalizeCompletionText("<|fim_middle|>rld")).toBeNull();
		expect(normalizeCompletionText("rld<|fim_middle|>")).toBe("rld");
		expect(normalizeCompletionText("rld<|im_end|>")).toBe("rld");
		expect(normalizeCompletionText("<|eot_id|>")).toBeNull();
		expect(normalizeCompletionText("rld<end_of_turn>junk")).toBe("rld");
	});

	test("unwraps a wholesale fenced block", () => {
		expect(normalizeCompletionText("```ts\n  return a + b;\n```")).toBe("  return a + b;");
		expect(normalizeCompletionText("```")).toBeNull();
		expect(normalizeCompletionText("```ts\n```")).toBeNull();
	});

	test("returns null for empty or non-string output", () => {
		expect(normalizeCompletionText("")).toBeNull();
		expect(normalizeCompletionText("   \n\t")).toBeNull();
		expect(normalizeCompletionText(null)).toBeNull();
		expect(normalizeCompletionText(undefined)).toBeNull();
		expect(normalizeCompletionText(42)).toBeNull();
	});

	test("caps very long output without splitting surrogate pairs", () => {
		const long = `${"a".repeat(500)}\u{1F600}tail`;
		const capped = normalizeCompletionText(long, 400);
		expect(capped).not.toBeNull();
		expect((capped as string).length).toBeLessThanOrEqual(400);
		expect(LONE_SURROGATE.test(capped as string)).toBe(false);
		// The default cap is the draft-list parse budget.
		expect(normalizeCompletionText(long)).toBe(long);
	});
});
