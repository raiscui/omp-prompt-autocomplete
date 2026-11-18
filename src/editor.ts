import {
	type AutocompleteProvider,
	type EditorTextAssistProvider,
	type EditorTheme,
	type KeybindingsManager,
	matchesKey,
	truncateToWidth,
	type TUI,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { text as nativeText } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type { CompletionSnapshot } from "./client";
import { type CompletionErrorHandler, CompletionController, type CompletionRequest } from "./controller";
import { nextWordOf } from "./next-word";
import { protectedTokensOf } from "./refine";

/**
 * Where the prompt-refinement feature stands, reported through `onRefineStateChange`:
 * `refining` while a rewrite is in flight for `draft`; `refined` while the editor still shows
 * the unedited rewrite, which Escape (or the undo key) reverts to `original`.
 */
export type RefineState =
	| { kind: "idle" }
	| { kind: "refining"; draft: string }
	| { kind: "refined"; original: string; refined: string };

/** One in-flight rewrite, handed out by {@link PromptAutocompleteEditor.beginRefine}. */
export interface RefineJob {
	/** Draft text at the start, placeholders collapsed exactly as the editor stores them. */
	readonly draft: string;
	/** Placeholders the rewrite must keep verbatim. */
	readonly protectedTokens: readonly string[];
	/** Aborted by Escape, by editing or sending the draft, or by a newer job. */
	readonly signal: AbortSignal;
	/**
	 * Replace the draft with `text`. Returns false (and changes nothing) when the job was
	 * cancelled or the draft changed meanwhile, so a late rewrite never clobbers newer input.
	 */
	apply(text: string): boolean;
	/** End the job without applying anything (failure path). */
	finish(): void;
}

export interface PromptAutocompleteEditorOptions {
	complete: CompletionRequest;
	onError?: CompletionErrorHandler;
	onRefineStateChange?: (state: RefineState) => void;
}

interface ActiveRefine {
	readonly draft: string;
	readonly controller: AbortController;
}

/** Open candidate panel. Rows and the preview are derived from the controller's full texts. */
interface CandidateMenu {
	readonly snapshot: CompletionSnapshot;
	/** Editor text when the menu opened; any change retires the menu. */
	readonly draft: string;
	selectedIndex: number;
	previewOffset: number;
}

export type EditorConstructor = new (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor;
export type EditorLayer = (Base: EditorConstructor) => EditorConstructor;
export const EDITOR_LAYERS = Symbol.for("omp.editor.layers.v1");
export const AUTOCOMPLETE_KEYS = ["ctrl+shift+right", "super+shift+right"] as const;

/** First non-blank line of a candidate for a compact list row; leading insert spaces survive. */
function compactRow(text: string): string {
	for (const line of text.split(/\r\n|\r|\n/)) {
		if (line.trim().length > 0) {
			return line.replace(/\s+$/, "");
		}
	}
	return "";
}

/** 保留宿主编辑器行为, 同时允许其他编辑器层参与继承链. */
export const createPromptAutocompleteEditor = (Base: EditorConstructor) => class PromptAutocompleteEditor extends Base {
	#controller: CompletionController;
	#keybindings: KeybindingsManager;
	#onRefineStateChange: ((state: RefineState) => void) | undefined;
	#enabled = true;
	#agentBusy = false;
	#disposed = false;
	#autocompleteProvider?: AutocompleteProvider;
	#refining: ActiveRefine | null = null;
	#refined: { original: string; refined: string } | null = null;
	#menu: CandidateMenu | null = null;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options: PromptAutocompleteEditorOptions) {
		super(tui, theme, keybindings);
		this.#keybindings = keybindings;
		this.#onRefineStateChange = options.onRefineStateChange;
		this.#controller = new CompletionController({
			complete: options.complete,
			onError: options.onError,
			onUpdate: () => {
				// Focus or menu state can change while inference is in flight.
				this.#sync();
				this.invalidate();
				tui.requestRender();
			},
		});
	}

	override setTextAssistProvider(provider: EditorTextAssistProvider | undefined): void {
		// CustomEditor's constructor calls this override before subclass fields exist.
		// Only the deferred callbacks touch subclass state. Preserve spelling's receiver.
		super.setTextAssistProvider({
			tryAutocorrect: provider?.tryAutocorrect?.bind(provider),
			getWordReplacements: provider?.getWordReplacements?.bind(provider),
			getWordCompletion: () => {
				const snapshot = this.#sync();
				return snapshot ? this.#controller.getGhost(snapshot) : null;
			},
			wordCompletionFeedback: () => {
				const snapshot = this.#snapshot();
				if (snapshot) this.#controller.dismiss(snapshot);
			},
		});
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.#autocompleteProvider = provider;
		super.setAutocompleteProvider(provider);
	}

	setAutocompleteEnabled(enabled: boolean): void {
		if (this.#disposed) return;
		this.#enabled = enabled;
		this.#controller.setEnabled(enabled);
		this.#sync();
		this.invalidate();
		this.tui?.requestRender();
	}

	triggerAutocomplete(): void {
		const snapshot = this.#snapshot();
		if (!snapshot) return;
		this.#openMenu(snapshot);
		this.#controller.requestNow(snapshot, "list");
		this.#refreshMenu();
	}

	/** Agent 执行期间隐藏并取消建议; 状态切换时清除旧会话背景. */
	setAgentBusy(busy: boolean): void {
		if (this.#disposed || this.#agentBusy === busy) return;
		this.#agentBusy = busy;
		this.#menu = null;
		this.#controller.reset();
	}

	get refineState(): RefineState {
		if (this.#refining) return { kind: "refining", draft: this.#refining.draft };
		if (this.#refined) return { kind: "refined", ...this.#refined };
		return { kind: "idle" };
	}

	/**
	 * Start rewriting the current draft, cancelling any earlier job. Returns `undefined` for an
	 * empty draft. The draft stays editable: typing, sending or Escape cancels the job.
	 */
	beginRefine(): RefineJob | undefined {
		if (this.#disposed) return undefined;
		const draft = this.getText();
		if (!draft.trim()) return undefined;
		this.#refining?.controller.abort();
		const active: ActiveRefine = { draft, controller: new AbortController() };
		this.#refining = active;
		this.#refined = null;
		this.#emitRefineState();
		const end = (): boolean => {
			if (this.#refining !== active) return false;
			this.#refining = null;
			return true;
		};
		return {
			draft,
			protectedTokens: protectedTokensOf(draft, this.atomicTokenPattern, this.atoms.keys()),
			signal: active.controller.signal,
			apply: text => {
				if (!end()) return false;
				if (this.#disposed || this.getText() !== draft) {
					this.#emitRefineState();
					return false;
				}
				// setText empties the native undo stack; the refined state carries its own revert.
				this.setText(text);
				this.#refined = { original: draft, refined: this.getText() };
				this.#emitRefineState();
				this.invalidate();
				this.tui?.requestRender();
				return true;
			},
			finish: () => {
				if (end()) this.#emitRefineState();
			},
		};
	}

	/** Abort an in-flight rewrite. Returns true when there was one. */
	cancelRefine(): boolean {
		const active = this.#refining;
		if (!active) return false;
		this.#refining = null;
		active.controller.abort();
		this.#emitRefineState();
		return true;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.cancelRefine();
		this.#disposed = true;
		this.#refined = null;
		this.#menu = null;
		this.#controller.dispose();
		this.invalidate();
		this.tui?.requestRender();
	}

	override render(width: number): readonly string[] {
		this.#trackRefineDraft();
		const snapshot = this.#sync();
		const lines = super.render(width);
		const rows = snapshot ? this.#displayRows(snapshot, width) : [];
		if (!rows.length) return lines;
		return [...lines, ...rows.map(line => `\x1b[2m${line}\x1b[0m`)];
	}

	override describe(cx: DescribeContext): NativeNode {
		this.#trackRefineDraft();
		const snapshot = this.#sync();
		const root = super.describe(cx);
		const rows = snapshot ? this.#displayRows(snapshot, cx.cols) : [];
		return {
			...root,
			c: [
				...(root.c ?? []),
				...rows.map(line => nativeText(line)),
			],
		};
	}

	#suggestionRows(suggestion: string, width: number): string[] {
		return wrapTextWithAnsi(`建议: ${suggestion}`, Math.max(1, width));
	}

	#displayRows(snapshot: CompletionSnapshot, width: number): string[] {
		if (this.#menu) {
			const choices = this.#controller.getSuggestions(snapshot);
			if (!choices.length) return [this.#controller.pending ? "正在获取建议…" : "暂无建议"];
			const selected = Math.min(this.#menu.selectedIndex, choices.length - 1);
			const cols = Math.max(1, width);
			const budget = Math.max(4, Math.min(24, (this.tui?.terminal.rows || 24) - 6));
			const rows = choices.map((text, index) =>
				truncateToWidth(`${index === selected ? "›" : " "} ${compactRow(text)}`, cols));
			rows.push(truncateToWidth(`${selected + 1}/${choices.length} · ↑↓ 选择 · Enter 填入 · Esc 关闭 · PgUp/PgDn 预览`, cols));
			// The full selected candidate, untruncated, paged with PgUp/PgDn.
			const preview = wrapTextWithAnsi(`提示词: ${choices[selected]}`, cols);
			const available = Math.max(1, budget - rows.length);
			this.#menu.previewOffset = Math.min(this.#menu.previewOffset, Math.max(0, preview.length - available));
			rows.push(...preview.slice(this.#menu.previewOffset, this.#menu.previewOffset + available));
			return rows;
		}
		const ghost = this.#controller.getGhost(snapshot);
		return ghost ? this.#suggestionRows(ghost, width) : [];
	}

	#openMenu(snapshot: CompletionSnapshot): void {
		this.#menu = { snapshot, draft: this.getText(), selectedIndex: 0, previewOffset: 0 };
	}

	#refreshMenu(): void {
		this.invalidate();
		this.tui?.requestRender();
	}

	override handleInput(data: string): void {
		if (this.isShowingAutocomplete() || this.isAutocompleteActive()) {
			this.#menu = null;
			try {
				super.handleInput(data);
			} finally {
				this.#trackRefineDraft();
				this.#sync();
			}
			return;
		}
		if (AUTOCOMPLETE_KEYS.some(key => matchesKey(data, key))) {
			this.triggerAutocomplete();
			return;
		}
		// Refine owns Escape before the ghost, menus and the agent interrupt: it cancels an
		// in-flight rewrite, or reverts an unedited one. The next Escape keeps its native meaning.
		if (this.#refining && matchesKey(data, "escape")) {
			this.cancelRefine();
			return;
		}
		// Escape is the portable revert key; Windows Terminal swallows Ctrl+- (the undo default) for zoom.
		if (
			this.#refined &&
			this.getText() === this.#refined.refined &&
			(matchesKey(data, "escape") || this.#keybindings.matches(data, "tui.editor.undo"))
		) {
			const { original } = this.#refined;
			this.#refined = null;
			this.setText(original);
			this.#emitRefineState();
			this.#sync();
			this.invalidate();
			this.tui?.requestRender();
			return;
		}
		const snapshot = this.#sync();
		if (snapshot && this.#menu) {
			const choices = this.#controller.getSuggestions(snapshot);
			if (matchesKey(data, "escape")) {
				this.#menu = null;
				this.#refreshMenu();
				return;
			}
			if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
				this.#menu.previewOffset = Math.max(0, this.#menu.previewOffset + (matchesKey(data, "pageUp") ? -3 : 3));
				this.#refreshMenu();
				return;
			}
			if (matchesKey(data, "up") || matchesKey(data, "down")) {
				if (choices.length) {
					const delta = matchesKey(data, "up") ? -1 : 1;
					this.#menu.selectedIndex = (this.#menu.selectedIndex + delta + choices.length) % choices.length;
					this.#menu.previewOffset = 0;
				}
				this.#refreshMenu();
				return;
			}
			if (matchesKey(data, "enter")) {
				const selected = choices[Math.min(this.#menu.selectedIndex, Math.max(0, choices.length - 1))];
				if (selected !== undefined) {
					this.#menu = null;
					// Empty editor: the candidate *is* the message, so replace the (blank) text.
					// Draft: the candidate is insert text, so it goes at the cursor and never deletes user text.
					if (!snapshot.prefix && !snapshot.suffix) this.setText(selected);
					else this.insertText(selected);
					this.#sync();
				}
				this.#refreshMenu();
				return;
			}
		}
		if (snapshot && matchesKey(data, "tab") &&
			(!snapshot.prefix && !snapshot.suffix || this.#menu || this.#controller.pending || this.#controller.getSuggestions(snapshot).length > 0)) {
			this.#openMenu(snapshot);
			// Explicit activation is always the long send-ready budget; the automatic basis is the
			// short inline ghost, which is not what Enter into an empty editor should insert.
			this.#controller.requestNow(snapshot, "list");
			this.#refreshMenu();
			return;
		}
		// A menu owns Escape before the ghost; the next Escape still reaches the
		// original CustomEditor interrupt/Vim handling after this snapshot is dismissed.
		if (snapshot && matchesKey(data, "escape") && this.#controller.dismiss(snapshot)) {
			this.invalidate();
			this.tui?.requestRender();
			return;
		}
		// Word-right at a shown ghost takes one word of it (Ctrl+→ / Alt+→ / Alt+F by default).
		// Without a ghost the cursor is at a line end, where native word-right keeps its meaning.
		if (snapshot && this.#keybindings.matches(data, "tui.editor.cursorWordRight")) {
			const ghost = this.#controller.getGhost(snapshot);
			if (ghost) {
				this.insertText(nextWordOf(ghost));
				this.#sync();
				return;
			}
		}
		try {
			// Native Tab inserts its provisional space; native right-arrow inserts exactly.
			super.handleInput(data);
		} finally {
			this.#trackRefineDraft();
			this.#sync();
		}
	}

	/** Editing or sending the draft cancels a pending rewrite and retires the undo offer. */
	#trackRefineDraft(): void {
		if (this.#refining && this.getText() !== this.#refining.draft) {
			this.cancelRefine();
		}
		if (this.#refined && this.getText() !== this.#refined.refined) {
			this.#refined = null;
			this.#emitRefineState();
		}
	}

	#emitRefineState(): void {
		this.#onRefineStateChange?.(this.refineState);
	}

	#sync(): CompletionSnapshot | null {
		const snapshot = this.#snapshot();
		if (this.#menu && (!snapshot || this.getText() !== this.#menu.draft || snapshot.prefix !== this.#menu.snapshot.prefix || snapshot.suffix !== this.#menu.snapshot.suffix)) {
			this.#menu = null;
		}
		this.#controller.update(snapshot);
		return snapshot;
	}

	#snapshot(): CompletionSnapshot | null {
		if (
			this.#disposed ||
			!this.#enabled ||
			this.#agentBusy ||
			// No ghost on a rewrite in flight or still unedited, so Escape always means revert there.
			this.#refining ||
			this.#refined ||
			!this.focused ||
			(this.isShowingAutocomplete() || this.isAutocompleteActive()) ||
			this.vimMode !== "insert"
		) {
			return null;
		}
		const lines = this.getLines();
		const { line, col } = this.getCursor();
		if (col !== lines[line].length) return null;
		if (this.#autocompleteProvider?.getInlineHint?.(lines, line, col)) return null;

		const text = lines.join("\n");
		// Whitespace-only text is the same state as an empty editor, whatever the engine knows.
		if (!text.trim()) return { prefix: "", suffix: "" };
		if (/^[\/!]/.test(text.trimStart())) return null;
		let offset = col;
		for (let i = 0; i < line; i++) offset += lines[i].length + 1;
		const prefix = text.slice(0, offset);

		// Avoid racing file/model mentions and path/skill completion while their
		// native menu is still loading. Code fences retain ordinary code suffixes.
		const token = /(?:^|\s)(\S+)$/.exec(prefix)?.[1] ?? "";
		if (/^[@^$]/.test(token)) return null;
		let fence: string | undefined;
		for (let i = 0; i <= line; i++) {
			const marker = /^\s*(`{3,}|~{3,})/.exec(lines[i])?.[1];
			if (!marker) continue;
			if (!fence) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
		}
		if (!fence && /[\\/]/.test(token)) return null;
		return { prefix, suffix: text.slice(offset) };
	}
};

export const PromptAutocompleteEditor = createPromptAutocompleteEditor(CustomEditor);
export type PromptAutocompleteEditor = InstanceType<typeof PromptAutocompleteEditor>;
