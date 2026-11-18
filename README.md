# omp-prompt-autocomplete

## Changes from upstream

This version modifies [n0uur/omp-prompt-autocomplete](https://github.com/n0uur/omp-prompt-autocomplete):

- Suggestions follow the current task. The model reads the goal, what is already done, what is unresolved and the user's explicit constraints from the recent conversation, then proposes the smallest next step as a prompt you could send. The fixed scenario catalog and its grouped panel were removed.
- The candidate list shows one suggestion by default. A second or third appears only for a genuinely different action: exact duplicates and word sets that overlap by 80% or more are dropped, while a different short action stays even when one text contains the other.
- Rows are compact one-line previews. PgUp/PgDn page the full selected text, and Enter inserts it whole, including line breaks, without sending. The inline ghost stays one short line, at most 160 UTF-16 code units.
- An empty editor only asks the model when the recent conversation contains a non-blank turn. Skill metadata alone no longer produces a request, and a finished task with no warranted next step yields no suggestion.
- Visible skills contribute bounded, relevance-ranked metadata to model requests. Hidden skills are never sent. `/autocomplete context off` disables that model background and the metadata.
- Empty-editor suggestions describe the next action and may begin with one callable session command when it fits the task. The plugin obtains command names from the host and sends relevant descriptions to the model. Accepting a suggestion only inserts it; sending still requires Enter.
- Skill metadata includes only loaded, visible skills, in this priority order: `eng-mode`, `how`, `codebase-design`, `improve-codebase-architecture`, `grill-with-docs`, `diagnosing-bugs`, `code-review`, `tdd`, `writing-plans`, `verification-before-completion`. Selection uses the draft and recent user turns, giving explicit skill names priority and filtering common words. For empty-editor command ranking, recent assistant turns can also help identify the current route; they do not authorize extra work. The lexical match can still miss cross-language synonyms or include unrelated skills. At most 16 skills are sent, with alphabetical tie-breaking. Typed drafts use metadata only to finish the text, without adding requirements or proof checklists.

- When the editor is empty and the session has a real turn to reason about, suggest the next instruction. The first is shown as a one-line ghost; the complete send-ready text is one Tab away. Nothing is generated while the agent is running.
- When the user is typing, the automatic request completes the sentence in one short line. Tab requests the full send-ready completion and opens the list.
- Complete the user's intent without adding unrequested engineering requirements. Preserve explicit constraints; assistant suggestions become requirements only when the user adopts them.
- Keep suggestions on the current core goal and unfinished in-scope todos visible in the background. Todos do not authorise extra scope. Avoid speculative defensive work, solution-generated prerequisites and repeated patching without progress; do not invent follow-ups after delivery and necessary acceptance are complete. Explicit requirements and necessary safety checks remain intact.
- Compose the prompt editor with the compatible modified `pi-omp-skills-autocomplete` editor in either load order. The `$skill` menu has priority.
- The original `Alt+E` prompt refinement remains available. No agent model, provider, or credentials are changed by these modifications.

The npm installation command below installs the upstream package, not necessarily this modified version. To use these changes, clone this repository and link the checkout as described below.

AI help for the oh-my-pi (`omp`) prompt box:

- **Ghost-text autocomplete.** An empty editor suggests a next instruction based on recent conversation; while typing, a short continuation appears. Accept the suggestion, one word at a time, or choose a different candidate.
- **One-key prompt refine.** Press **Alt+E**, pick an instruction ("Polish", "Make it concise", …) or type your own, and the draft is rewritten in place before you send it.

Both features use small, fast models through omp's own providers and logins. The agent's model, roles and thinking level are never touched.

![Demo: a ghost suggestion accepted word by word with Ctrl+→ and then in full with →; a rough draft refined with Alt+E and a custom instruction, then restored with Esc](docs/demo.gif)

<sub>Recorded in a live omp 18.4.4 session. The badges show which key was pressed.</sub>

## Install

```sh
omp plugin install omp-prompt-autocomplete
```

From a local checkout:

```sh
cd omp-prompt-autocomplete
omp plugin link .
```

Restart omp afterwards. Requirements: omp 18.4 or newer, and a login for the model used (by default `google-antigravity/gemini-3.1-flash-lite`; see [Models](#models)).

## Autocomplete

| Key | Action |
| --- | --- |
| **Ctrl+Shift+→ / Cmd+Shift+→** | Immediately request fresh suggestions and open the candidate list, including after dismissal with Esc |
| **Tab** | Open the candidate list and request the full send-ready candidate, or show a waiting message while it is generated |
| **→** | Accept the inline ghost exactly (omp's native behaviour) |
| **Ctrl+→** | Accept the next word of the ghost. Also works with **Alt+→** and **Alt+F**, or whatever `tui.editor.cursorWordRight` is bound to |
| **↑/↓, Enter** | Select a candidate and insert its complete text without sending the message |
| **PgUp/PgDn** | Page the full preview of the selected candidate |
| **Esc** | Close the candidate list or dismiss the suggestion. Pressing Esc again keeps omp's normal behaviour |

Word-at-a-time acceptance uses Unicode word segmentation, so languages written without spaces between words (Thai, Japanese, Chinese) advance one dictionary word at a time. Punctuation stays attached to the word before it (`requests.`), and the rest of the suggestion stays on screen without a new request.

Suggestions appear only at the end of a line. Empty-editor generation needs a non-blank recent turn; skill metadata alone never triggers a request. The automatic ghost is one short line, while the candidate list carries and inserts the complete text. Native menus, spelling, `/` commands, `!` shell lines, `@`/`^` mentions and path completion keep priority.

`Ctrl+Shift+→` (or `Cmd+Shift+→` on macOS) works with an empty editor or a draft. Press it again to replace a pending request or refresh the candidates. It respects the same eligibility rules as automatic suggestions and does not turn autocomplete back on after `/autocomplete off`; run `/autocomplete on` first. Use `/hotkeys` to check for shortcut conflicts. Cmd requires a terminal that forwards the Super modifier; otherwise use Ctrl.

When `pi-omp-skills-autocomplete` is installed with the compatible local editor-layer implementation, both plugins compose their editor behavior regardless of load order. The `$skill` menu retains priority over prompt ghost text.

## Refine

1. Type a prompt.
2. Press **Alt+E**. A picker replaces the editor:
   - Press **Enter** to use the highlighted preset. It starts on the last one you used.
   - Type your own instruction, for example `fix grammar and keep it in Thai`, then press **Enter**.
   - **↑/↓** move between presets. **Tab** copies the highlighted preset into the text field so you can edit it. **Esc** cancels.
3. Your draft is rewritten in place. A line under the editor shows the current state:
   - `✎ Refining prompt · Polish · Esc cancel · Enter sends it unchanged`
   - `✓ Refined · Polish · Enter send · Esc restore original · Alt+E refine again`

| While… | Key | Effect |
| --- | --- | --- |
| refining | **Esc** | Cancel the rewrite. The draft is not changed |
| refining | **Enter** | Send the original draft. The rewrite is dropped |
| refining | typing | Cancel the rewrite and keep editing |
| refined | **Enter** | Send the rewritten prompt |
| refined | **Esc** | Restore the original draft. The next Esc behaves normally (for example, it interrupts the agent) |
| refined | **Alt+E** | Refine the rewritten prompt again with another instruction |

Once you edit the rewritten text, the refined state ends. From then on, Esc and undo work normally. While the rewritten text is unedited, no autocomplete suggestion is shown, so Esc always restores the original.

Omp's undo key (**Ctrl+-** by default) also restores the original in terminals that pass it through. Windows Terminal uses Ctrl+- to zoom out, so on Windows use Esc.

Presets:

| Preset | Instruction |
| --- | --- |
| Polish | Fix grammar, spelling and awkward wording; keep meaning, tone and length |
| Fix grammar only | Fix grammar, spelling and punctuation only |
| Make it concise | Remove filler and repetition; keep every requirement |
| Make it clear for the agent | Put the goal first and organise existing details. Include constraints and completion criteria only when supplied by the user |
| Translate to English | Translate to natural English; leave code and paths unchanged |

Your last three custom instructions are listed above the presets as `recent` until omp restarts.

Attachments are protected. Placeholders such as `[Image #1, …]` and `[Paste #2, +30 lines]`, as well as skill and model chips, are passed to the model as text that must not change. If the rewrite drops or duplicates one of them, the rewrite is rejected and your draft stays unchanged.

Names and versions are protected too. Small models tend to "correct" names newer than their training data, for example rewriting `Claude Haiku 5.5` as `Claude Haiku 3.5`. The model is told to keep names and version numbers exactly as written, and the rewrite is checked afterwards. If it drops a number from your draft or adds a version that appears nowhere in the draft, the instruction or the session background, it is rejected and your draft stays unchanged. Plain counts the model adds (`two` → `2`, numbered list items) are allowed. If your own instruction mentions a number (`change 5.5 to 6`), that number may change.

To change the shortcut, set `OMP_PROMPT_REFINE_KEY` (for example `ctrl+shift+e`) in the environment before starting omp. Run `/hotkeys` to check for conflicts.

## Commands

```text
/autocomplete status                 Show both models, where each came from, context state, and the (unchanged) agent model
/autocomplete off | on               Turn ghost suggestions off or on for this session (refine keeps working)
/autocomplete context off | on       Stop or resume sending session background with requests (this session only)
/autocomplete model <spec>           Override the autocomplete model for this session: provider/id or @role, e.g. @tiny
/autocomplete refine-model <spec>    Override the refine model for this session
/autocomplete model default          Clear the override (same for refine-model)
```

## Models

Model order, from highest priority:

- **Autocomplete:** a session override, then `modelRoles.autocomplete`, then `google-antigravity/gemini-3.1-flash-lite`
- **Refine:** a session override, then `modelRoles.refine`, then `modelRoles.autocomplete`, then `google-antigravity/gemini-3.1-flash-lite`

Set a default model for each feature in `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  autocomplete: cerebras/qwen-3.8-27b   # needs to be very fast; called on every pause
  refine: google-antigravity/gemini-3.1-flash-lite
```

Requests always use the model's lowest reasoning effort, so a `:level` suffix makes no difference. Models are looked up read-only with `ctx.models.resolve`. Requests go straight to `completeSimple` with omp's credential resolver. The plugin never calls `setModel` or `registerProvider`, and never changes roles or thinking levels.

If no model is available, for example because you are not logged in, autocomplete shows one warning and then stays quiet until you run `/autocomplete on` or change the model. Refine explains the problem when you press the shortcut.

## What is sent

**Autocomplete** makes one request after a 180 ms typing pause. Each request contains:

- a system prompt chosen for an empty editor or a typed draft;
- up to 2,048 characters before the cursor and 512 after it;
- background, unless `/autocomplete context off` is set:
  - the project folder and session name;
  - up to 10 file paths from the agent's recent `read`/`write`/`edit` calls (paths only, never file contents);
  - the last 4 conversation turns, about 1.5 KB in total.

Thinking blocks, tool output, images and `<system-reminder>` blocks are never sent. Each request picks a budget from the input state and the purpose, both use temperature 0, and replies that only echo the draft are reduced to their new tail:

| Input | Request | Tokens | Deadline | Inserted-text cap |
| --- | --- | --- | --- | --- |
| empty | automatic ghost | 512 | 6 s | 200 |
| empty | Tab / Ctrl+Shift+→ list | 2,048 | 60 s | 1,800 |
| draft | automatic ghost | 288 | 4 s | 400 |
| draft | Tab / Ctrl+Shift+→ list | 1,024 | 60 s | 1,400 |

These budgets cover every candidate in one response: one by default, three at most. The caps bound inserted text only, so a whole multi-line message is inserted untruncated when it fits. A list reply cut off by the token budget is discarded instead of inserted half-written; the one-line ghost keeps its text. The 60-second list deadline comes from measured runs on real backgrounds (19.8 s and 38.4 s), which the earlier 15-second ceiling discarded; typing, Escape or closing the list cancels a running request at once. Empty-editor suggestions have no minimum length: a simple next step can be one sentence, with more detail only when the task needs it.

These focus rules also apply to refinement, without appending a checklist or removing explicitly requested work. Todo awareness is limited to text visible in the bounded recent conversation above; this version does not separately read live todo-tool state or load `goal-drift-check` at runtime.

**Refine** sends the whole draft once, up to 16,000 characters, together with your instruction, the list of protected placeholders and the same optional background. Refine has a 30-second deadline, and the output budget grows with the draft length up to 8,192 tokens. The reply must be wrapped in `<prompt>…</prompt>`. Terminal control characters are removed and nothing is executed.

Draft text never appears in notifications or error messages.

## Development

```sh
bun install
bun test          # unit tests plus editor tests on the real omp editor
bun run typecheck
```

The `@oh-my-pi/*` packages are optional peer dependencies. At runtime omp gives the plugin its own copies, and the dev dependencies exist only for tests and type checking. Keep the version in `devDependencies` the same as the omp release you are testing against.

Source layout:

| File | Role |
| --- | --- |
| `src/index.ts` | Extension entry: editor installation, model resolution, refine shortcut and `/autocomplete` command |
| `src/editor.ts` | `CustomEditor` subclass: ghost integration, word-at-a-time accept, refine state (cancel, apply, undo) |
| `src/controller.ts` | Debounced, cancellation-safe ghost suggestion state machine |
| `src/client.ts` | Autocomplete request building and reply normalisation |
| `src/refine.ts` | Refine presets, request building, placeholder protection, reply parsing |
| `src/picker.ts` | Refine instruction picker component |
| `src/next-word.ts` | Unicode word segmentation for Ctrl+→ |
| `src/context.ts` | Bounded session background collection |

## License

MIT
