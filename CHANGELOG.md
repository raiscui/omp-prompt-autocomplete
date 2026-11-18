# Changelog

## 本地改版

- 空框生成时读取宿主当前可调用命令，按近期对话筛选并向模型提供准确调用名；合适时建议以单条命令开头，其他情况使用自然语言。发版、任务澄清和 Fabric 需求按实际目标选择，插入建议仍不发送。

- 建议改为围绕当前任务生成: 从近期对话读取目标、已完成内容、未解决问题与用户约束, 默认只给一条可直接发送的下一步; 仅当存在真正不同的动作时才给第二、三条, 完全重复、或词集重叠达 80% 的改写会被丢弃, 而包含在更长文本里的不同短动作仍会保留. 空框没有非空对话轮次时不请求模型, 只有技能元数据也不请求; 任务已完成且没有下一步时不显示建议. 固定的本地场景模板与分组面板已删除.
- 半句续写与候选列表分开预算: 自动 ghost 保持短小(空框 512 tokens / 6 秒 / 200 字符; 草稿 288 / 4 秒 / 400), 显式列表请求才用长预算(空框 2048 / 60 秒 / 1800; 草稿 1024 / 60 秒 / 1400). 60 秒硬上限与更大输出上限依据实测真实背景(19.8 秒 / 38.4 秒)修正; 输入、Esc 或关闭列表立即取消请求. 列表回复因 token 上限被截断时整条丢弃, 不插入半截文本; 单行 ghost 保留其内容.
- 技能相关性将“消息/文件”视为低信息弱词: 存在领域片段时仅凭弱词不再入选, 须另有普通有效词或用户上下文连续单汉字组成的领域双字片段佐证, 无可用片段时沿用原弱词频次门槛以保留纯文件意图; 具体领域佐证可让弱词越过原词频门槛, 但双字片段绝不单独引入候选. 片段在标点、空格、非汉字、多字词及通用/动作字(如“请”“我”“排查”)处断开, “排查”并入停用词, 避免不同分词器把它当作领域强证据. 修复飞书群聊报错误选脚本/通知技能, 保留无“发送”的飞书消息短请求、纯脚本替换任务与飞书+脚本混合请求; 显式命名、隐藏过滤、工程核心优先、排序与截断不变.
- 技能背景筛选以草稿和近期用户消息为依据, 降低通用词及非工程错误触发的误选; 助手建议和文件路径不再单独引入技能. 保留显式命名与隐藏技能过滤.
- 候选列表改为紧凑单行预览加选中项完整预览：Page Up / Page Down 翻页完整文本，Enter 原样插入包含换行的完整内容且不发送；空框替换草稿，有草稿时只在光标处插入。内联 ghost 仍只显示一行(最多 160 个 UTF-16 单元)。等待时显示「正在获取建议…」，没有候选时显示「暂无建议」。纯空白草稿一律视为空输入框，Tab 与 `Ctrl+Shift+→` 都会请求完整候选列表。
- 从当前宿主实例读取已加载技能，作为完成提示词的参考元数据：隐藏技能不发送；可见技能按完整名称、有效词匹配和工程技能优先级选择，最多 16 条，不再用无关技能填满名额。关闭上下文时不发送背景与技能元数据；技能元数据本身不再触发空框请求。半句续写只参考技能元数据补全新字符，不追加清单或验证要求。
- 参考 `goal-drift-check` 补充统一的目标校准规则, 用于半句续写, 空框建议和润色: 优先当前核心目标与背景中可见的未完成 todo, 不把计划当作扩面授权; 避免假设性防御, 辅助方案衍生任务和反复局部修补, 达到交付与必要验收条件后不再编造后续任务. 保留明确要求, 必要安全检查与验收, 不新增 todo 状态采集或运行时技能依赖.
- `Ctrl+Shift+→` 改为主动请求补全并打开候选列表, 同时支持 `Cmd+Shift+→` (终端需转发 Super 修饰键). 支持重新激活被 Esc 隐藏的建议, 重复触发取消旧请求. 不直接插入或发送消息, 不改变自动补全开关和原生菜单优先级.
- 提示续写不再主动追加未请求的测试、兼容或其他工程要求. 保留用户明确约束, 仅在用户采纳后才把助手建议视为要求.
- 空框建议取消硬性最小字数, 按任务需要决定长度; 空框和半句均可用 Tab 打开最多三条候选, 使用方向键选择并按 Enter 插入.
- Make it clear for the agent 只整理已有目标与细节, 不为填齐模板新增约束或验收标准. 附件、版本、输出解析和请求预算保护不变.

- 空输入框在智能体结束后根据近期对话推荐完整的下一条指令; 简单下一步允许一句话, 输入过程中继续提供简短续写.
- 空框推荐使用独立于草稿的长度和超时预算，没有非空的近期对话轮次时不生成。
- 提示编辑器与兼容版本的 `pi-omp-skills-autocomplete` 按加载顺序组合, 技能候选保持优先.

## 0.2.2 — 2026-10-09

### Fixed

- **Suggestions no longer answer back.** The model sometimes suggested the agent's reply instead of your next words (`Please fix this issue` → ` Yeah I will do that`). The system prompt now says suggestions are the user's own words addressed to the agent: it may still suggest a next sentence (another instruction, detail or question), but it never answers, acknowledges or agrees to the message. As a backstop, a suggestion that opens with an acknowledgement (`Sure,`, `Yeah I…`, `Got it.`) is dropped, and so is one that starts a new sentence with the agent committing to act (`I'll…`, `Let me check…`). Mid-sentence words like `make sure` or `is it OK to` are unaffected.
- **Refine no longer changes model names and versions.** "Polish", "Fix grammar only" and the other presets would rewrite names newer than the refine model knows: `Claude Haiku 5.5` became `Claude Haiku 3.5`, and even `Gemini 3.1 Flash Lite` became `Gemini 1.5`. This happened in 24 of 40 live test runs. The model is now told that names and versions are correct as written, and it is given the list of numbers in the draft. A rewrite that drops one of them, or adds a version mentioned nowhere in the draft, instruction or background, is rejected like a lost attachment placeholder, and your draft stays unchanged. The same 40 runs now keep every version.

## 0.2.1 — 2026-09-30

### Changed

- Package metadata now includes `homepage`, `repository` and `bugs`, which point to [GitHub](https://github.com/n0uur/omp-prompt-autocomplete). The npm page links there and shows the README demo GIF.

## 0.2.0 — 2026-09-30

### Added

- **Ctrl+→ accepts one word of the suggestion at a time.** It follows the `tui.editor.cursorWordRight` binding (Ctrl+→, Alt+→ and Alt+F by default) and uses Unicode word segmentation, so Thai, Japanese and Chinese advance by dictionary word. When no suggestion is shown, word-right moves the cursor as usual.
- **Prompt refine (Alt+E).** A picker offers presets (Polish, Fix grammar only, Make it concise, Make it clear for the agent, Translate to English) or accepts your own instruction. The draft is rewritten in place, and a status line under the editor shows the current state. While a rewrite is running, Esc or typing cancels it, and Enter sends the original text. After a rewrite, Esc restores the original. Omp's undo key does the same in terminals that don't claim Ctrl+- for zoom. No autocomplete suggestion is shown until you edit the rewrite. Attachment placeholders and chips must come back unchanged, otherwise the rewrite is rejected.
- `modelRoles.refine` and `/autocomplete refine-model <spec|default>` to choose the refine model. `/autocomplete status` now shows the refine model as well.
- `OMP_PROMPT_REFINE_KEY` changes the refine shortcut.

### Changed

- Packaged as a standalone omp plugin (`omp plugin install omp-prompt-autocomplete`) with `package.json#omp.extensions`, optional peer dependencies on the host packages, and dev dependencies so the tests run with `bun install && bun test`.

## 0.1.0 — 2026-09-28

- Ghost-text autocomplete in the omp prompt editor using a small cloud model through omp's provider stack. Includes session background (project, recent files, recent turns), `/autocomplete on|off|status|context|model`, and isolation from the agent's model.
