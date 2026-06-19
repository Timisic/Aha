import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function createHarness(cwd, initialSessionEntries = []) {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const sentMessages = [];
  const notifications = [];
  const editorTexts = [];
  const sessionEntries = [...initialSessionEntries];

  const pi = {
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    on(event, handler) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    sendUserMessage(content, options) {
      sentMessages.push({ content, options });
    },
    appendEntry(customType, data) {
      sessionEntries.push({
        type: "custom",
        customType,
        data,
        id: `custom-${sessionEntries.length + 1}`,
        parentId: null,
        timestamp: new Date().toISOString(),
      });
    },
  };

  extension(pi);

  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      editor: async () =>
        [
          "Insight: 编辑器输入 insight",
          "",
          "Context: 编辑器输入 context",
        ].join("\n"),
      notify(message, type) {
        notifications.push({ message, type });
      },
      setStatus(key, text) {
        notifications.push({ status: [key, text] });
      },
      setEditorText(text) {
        editorTexts.push(text);
      },
    },
    sessionManager: {
      getBranch: () => sessionEntries.slice(),
      getEntries: () => sessionEntries.slice(),
    },
  };

  async function emitSessionStart(reason = "resume") {
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason }, ctx);
    }
  }

  async function emitContext(messages) {
    let current = messages;
    for (const handler of handlers.get("context") ?? []) {
      const result = await handler({ type: "context", messages: current }, ctx);
      if (result?.messages) current = result.messages;
    }
    return current;
  }

  async function emitToolCall(toolName, input) {
    let result;
    for (const handler of handlers.get("tool_call") ?? []) {
      result = (await handler({ type: "tool_call", toolName, toolCallId: "tool-call-test", input }, ctx)) ?? result;
    }
    return result;
  }

  return {
    commands,
    tools,
    sentMessages,
    notifications,
    editorTexts,
    sessionEntries,
    ctx,
    emitContext,
    emitSessionStart,
    emitToolCall,
  };
}

const cwd = mkdtempSync(join(tmpdir(), "insight-extension-cwd-"));
const otherCwd = mkdtempSync(join(tmpdir(), "insight-extension-other-cwd-"));
const insightHome = mkdtempSync(join(tmpdir(), "insight-extension-home-"));
const fakeBinDir = mkdtempSync(join(tmpdir(), "insight-extension-bin-"));
const fakeQmd = join(fakeBinDir, "qmd");
const fakeObsidian = join(fakeBinDir, "obsidian");
process.env.INSIGHT_HOME = insightHome;
process.env.QMD_BIN = fakeQmd;
process.env.OBSIDIAN_BIN = fakeObsidian;
process.env.INSIGHT_EXPAND_BACKLINKS = "1";
process.env.INSIGHT_MEMORY_RERANKER = "none";
process.env.INSIGHT_COMMAND_OUTPUT_MAX_BYTES = "4096";

writeFileSync(
  fakeQmd,
  [
    "#!/usr/bin/env node",
    "const queryIndex = process.argv.findIndex((arg) => arg === 'search' || arg === 'vsearch' || arg === 'query') + 1;",
    "const query = queryIndex > 0 ? process.argv[queryIndex] : '';",
    "if ((process.env.QMD_FAKE_MODE || '') === 'large') {",
    "  process.stdout.write('x'.repeat(128 * 1024));",
    "  setInterval(() => {}, 1000);",
    "}",
    "process.stdout.write(JSON.stringify([",
    "  {",
    "    file: 'personal-review/feedback-visible-gap.md',",
    "    title: '反馈是经验差距的显影装置',",
    "    snippet: '反馈是一个显影装置，把经验差距、理解缺口、判断偏差和半成品边界暴露出来。',",
    "    score: 0.82,",
    "    query",
    "  },",
    "  {",
    "    file: 'personal-review/feedback-loop-source.md',",
    "    title: '反馈迭代的来源动力',",
    "    snippet: '输出可以得到反馈，也可以得到很多 insight，但需要避免确认偏差。',",
    "    score: 0.78,",
    "    query",
    "  }",
    "]));",
    "",
  ].join("\n"),
  "utf-8",
);
chmodSync(fakeQmd, 0o755);

writeFileSync(
  fakeObsidian,
  [
    "#!/usr/bin/env node",
    "const { existsSync, readFileSync } = require('node:fs');",
    "if ((process.env.OBSIDIAN_FAKE_MODE || '') === 'fail') process.exit(1);",
    "const args = process.argv.slice(2);",
    "const command = args[0];",
    "const joined = args.join(' ');",
    "if (command === 'backlinks') {",
    "  if (joined.includes('feedback-visible-gap')) {",
    "    process.stdout.write(JSON.stringify([",
    "      { path: 'personal-review/feedback-linked-context.md', title: '反馈密度与学习系统' },",
    "      { path: 'personal-review/unrelated-shopping.md', title: '购物清单' }",
    "    ]));",
    "  } else {",
    "    process.stdout.write('[]');",
    "  }",
    "} else if (command === 'read') {",
    "  const pathArg = args.find((arg) => arg.startsWith('path='));",
    "  if (pathArg && existsSync(pathArg.slice('path='.length))) {",
    "    process.stdout.write(readFileSync(pathArg.slice('path='.length), 'utf-8'));",
    "  } else if (joined.includes('feedback-linked-context')) {",
    "    process.stdout.write('反馈密度会影响学习系统中判断被修正的速度。');",
    "  } else if (joined.includes('unrelated-shopping')) {",
    "    process.stdout.write('买牛奶和咖啡。');",
    "  } else if (joined.includes('Wiki Source Note')) {",
    "    process.stdout.write('# Wiki Heading\\n\\n由 Obsidian CLI 读取的 wiki note。');",
    "  }",
    "} else {",
    "  process.exit(1);",
    "}",
    "",
  ].join("\n"),
  "utf-8",
);
chmodSync(fakeObsidian, 0o755);

const extensionModule = await import(process.env.INSIGHT_EXTENSION_PATH ?? new URL("../../insight-package/extensions/insight.ts", import.meta.url).href);
const extension = extensionModule.default;

try {
  const harness = createHarness(cwd);
  const insight = harness.commands.get("insight");
  assert.ok(insight, "/insight command registered");
  assert.ok(harness.tools.get("insight_search_memory"), "search tool registered");
  assert.ok(harness.tools.get("insight_update_state"), "state tool registered");
  assert.ok(harness.tools.get("insight_append_grill_context"), "grill context tool registered");
  assert.ok(harness.tools.get("insight_save_summary"), "summary tool registered");

  await insight.handler(
    [
      "Insight: 反馈密度可能比努力程度更影响成长",
      "",
      "Context: 这是一个关于学习系统的测试。",
      "",
      "Connected History Notes:",
      "- 反馈是经验差距的显影装置",
    ].join("\\n"),
    harness.ctx,
  );

  assert.equal(harness.sentMessages.length, 1, "start replays the original insight input as the automatic follow-up");
  assert.ok(harness.sentMessages[0].content.includes("Insight: 反馈密度可能比努力程度更影响成长"));
  assert.ok(!harness.sentMessages[0].content.includes("开始处理这个 insight"));
  assert.equal(harness.sentMessages[0].options?.deliverAs, "followUp");

  const injectedMessages = await harness.emitContext([
    { role: "user", content: harness.sentMessages[0].content, timestamp: Date.now() },
  ]);
  assert.equal(injectedMessages.length, 2, "pending insight context is injected once");
  assert.ok(injectedMessages[0].content.includes("hidden-insight-session-context"));
  assert.ok(injectedMessages[0].content.includes("insight_search_memory"));
  assert.ok(!injectedMessages[0].content.includes("Follow the local PRD"));
  assert.ok(!injectedMessages[0].content.includes("Grill context:"));
  assert.ok(injectedMessages[0].content.includes("Do not run shell commands, search project docs"));
  assert.ok(!injectedMessages[0].content.includes("Review-Grill guidance"));
  assert.ok(!injectedMessages[0].content.includes("Summary structure rule"));
  assert.ok(injectedMessages[1].content.includes("Insight: 反馈密度可能比努力程度更影响成长"));

  const reinjectedMessages = await harness.emitContext([
    { role: "user", content: "第二条正式消息", timestamp: Date.now() },
  ]);
  assert.equal(reinjectedMessages.length, 1, "hidden context is not injected twice");

  const indexPath = join(insightHome, "index.json");
  assert.ok(existsSync(indexPath), "index.json created");
  const index = JSON.parse(readFileSync(indexPath, "utf-8"));
  assert.equal(index.length, 1);

  const sessionDir = index[0].dir;
  const statePath = join(sessionDir, "state.json");
  const grillPath = join(sessionDir, "grill-context.md");
  assert.ok(existsSync(statePath), "state.json created");
  assert.ok(existsSync(grillPath), "grill-context.md created");
  const initialGrillContext = readFileSync(grillPath, "utf-8");
  assert.ok(initialGrillContext.includes("# Insight Grill 上下文"));
  assert.ok(initialGrillContext.includes("## Language"));
  assert.ok(initialGrillContext.includes("## Decision Records"));
  assert.ok(!initialGrillContext.includes("## Raw Insight"));

  let state = JSON.parse(readFileSync(statePath, "utf-8"));
  assert.match(state.id, /^[a-f0-9]{16}$/i, "new session id has enough entropy");
  assert.ok(
    harness.sessionEntries.some(
      (entry) =>
        entry.customType === "insight.active_session" &&
        entry.data?.active === true &&
        entry.data?.sessionId === state.id,
    ),
    "active insight binding is persisted in Pi session entries",
  );
  assert.equal(state.stage, "memory");
  assert.equal(state.originCwd, cwd);
  assert.equal(state.rawInsight, "反馈密度可能比努力程度更影响成长");
  assert.equal(state.context, "这是一个关于学习系统的测试。");
  assert.deepEqual(state.explicitMemoryCues, ["反馈是经验差距的显影装置"]);
  assert.ok(
    harness.notifications.some((item) => item.status?.[1] === `insight ${state.id} · Memory`),
    "status line shows active insight and memory stage",
  );
  const blockedStateLookup = await harness.emitToolCall("bash", {
    command: "find . -path '*/state.json' -o -path '*/grill-context.md' | head -50",
  });
  assert.equal(blockedStateLookup?.block, true, "memory stage blocks state/grill-context discovery bash");
  assert.ok(blockedStateLookup.reason.includes("insight_search_memory"));

  const searchResult = await harness.tools.get("insight_search_memory").execute(
    "tool-1",
    {
      queries: [
        {
          kind: "raw",
          qmd: {
            intent: "召回关于反馈密度如何影响成长和判断修正的旧笔记。",
            lex: ["反馈密度", "成长", "判断修正", "学习系统"],
            vec: state.rawInsight,
            hyde: "一篇相关旧笔记会讨论反馈如何暴露经验差距、推动判断修正，并影响学习系统中的成长速度。",
          },
        },
        { text: "反馈密度 成长 判断", kind: "abstracted_judgment" },
        { text: "学习系统 反馈密度", kind: "open-ended" },
        { text: "反馈是经验差距的显影装置", kind: "explicit_cue", command: "qmd search" },
      ],
      limit: 8,
    },
    undefined,
    undefined,
    harness.ctx,
  );

  state = JSON.parse(readFileSync(statePath, "utf-8"));
  assert.equal(state.stage, "memory_review");
  assert.ok(
    harness.sessionEntries.some(
      (entry) =>
        entry.customType === "insight.active_session" &&
        entry.data?.active === true &&
        entry.data?.sessionId === state.id &&
        entry.data?.updatedAt === state.updatedAt,
    ),
    "state updates refresh the persisted active binding",
  );
  assert.ok(
    harness.notifications.some((item) => item.status?.[1] === `insight ${state.id} · Memory Review`),
    "status line updates to memory review",
  );
  assert.ok(searchResult.content[0].text.includes("Stage: memory_review"));
  assert.ok(searchResult.content[0].text.includes("| Note | Relation | Hit | Why |"));
  assert.ok(!searchResult.content[0].text.includes("| # |"));
  assert.ok(!searchResult.content[0].text.includes("| Source |"));
  assert.ok(!searchResult.content[0].text.includes("| Title |"));
  assert.equal(searchResult.details.candidateCount, state.memoryCandidates.length);
  assert.equal(searchResult.details.memoryCandidates.length, state.memoryCandidates.length);
  const renderedSearchResult = harness.tools
    .get("insight_search_memory")
    .renderResult(searchResult, { expanded: false, isPartial: false }, {}, { args: {}, cwd });
  const renderedSearchLines = renderedSearchResult.render(140).join("\n");
  assert.ok(renderedSearchLines.includes(`cumulative candidates: ${state.memoryCandidates.length}`));
  assert.ok(renderedSearchLines.includes("Hit"));
  assert.ok(renderedSearchLines.includes("Why"));
  assert.ok(state.memoryCandidates.length >= 3, "memory candidates merged with relevant backlinks");
  assert.ok(
    state.memoryCandidates.some(
      (candidate) =>
        candidate.title === "反馈密度与学习系统" &&
        candidate.searchSignals?.source === "obsidian_backlink",
    ),
    "relevant backlink note is included as memory candidate",
  );
  assert.ok(
    !state.memoryCandidates.some((candidate) => candidate.title === "购物清单"),
    "irrelevant backlink note is filtered out",
  );
  assert.equal(state.memoryQueries.length, 4);
  assert.equal(state.memoryQueries[0].qmd.intent, "召回关于反馈密度如何影响成长和判断修正的旧笔记。");
  assert.equal(state.memoryQueries[2].kind, "contextual");

  const secondSearchResult = await harness.tools.get("insight_search_memory").execute(
    "tool-1b",
    {
      queries: [{ text: "反馈 显影 判断边界", kind: "bounds" }],
      limit: 8,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const stateAfterSecondSearch = JSON.parse(readFileSync(statePath, "utf-8"));
  assert.ok(secondSearchResult.content[0].text.includes("Candidate table to present to the user"));
  assert.equal(
    secondSearchResult.details.memoryCandidates.length,
    stateAfterSecondSearch.memoryCandidates.length,
    "second search result exposes cumulative memory candidates",
  );
  assert.ok(
    secondSearchResult.details.memoryCandidates.some((candidate) => candidate.title === "反馈密度与学习系统"),
    "second search cumulative list retains prior backlink candidate",
  );

  process.env.QMD_FAKE_MODE = "large";
  const largeOutputHarness = createHarness(cwd);
  await largeOutputHarness.commands.get("insight").handler(
    "Insight: 大输出测试\n\nContext: QMD 异常输出不应撑爆会话",
    largeOutputHarness.ctx,
  );
  const largeIndex = JSON.parse(readFileSync(indexPath, "utf-8"));
  const largeStatePath = join(largeIndex[0].dir, "state.json");
  const largeResult = await largeOutputHarness.tools.get("insight_search_memory").execute(
    "large-output-search",
    { queries: [{ text: "large output", kind: "raw" }], limit: 8 },
    undefined,
    undefined,
    largeOutputHarness.ctx,
  );
  const largeState = JSON.parse(readFileSync(largeStatePath, "utf-8"));
  assert.equal(largeState.stage, "memory");
  assert.equal(largeState.memoryCandidates.length, 0);
  assert.ok(largeResult.content[0].text.includes("Search issues"));
  delete process.env.QMD_FAKE_MODE;

  const restoredHarness = createHarness(cwd, [
    {
      type: "custom",
      customType: "insight.active_session",
      data: { active: true, sessionId: state.id },
      id: "custom-restore",
      parentId: null,
      timestamp: new Date().toISOString(),
    },
  ]);
  await restoredHarness.emitSessionStart("resume");
  assert.ok(
    restoredHarness.notifications.some(
      (item) => item.status?.[1] === `insight ${state.id} · Memory Review`,
    ),
    "resume session_start restores status from persisted binding",
  );
  await restoredHarness.commands.get("insight").handler("current", restoredHarness.ctx);
  assert.ok(restoredHarness.editorTexts.at(-1).includes(`Active insight session: ${state.id}`));
  const restoredInjectedMessages = await restoredHarness.emitContext([
    { role: "user", content: "继续 resume 后的 insight", timestamp: Date.now() },
  ]);
  assert.equal(restoredInjectedMessages.length, 2);
  assert.ok(restoredInjectedMessages[0].content.includes("Current stage: memory_review"));

  const fallbackHarness = createHarness(cwd, [
    {
      type: "message",
      id: "message-with-old-tool-output",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        content: [{ type: "text", text: `state path from old run: ${statePath}` }],
      },
    },
  ]);
  await fallbackHarness.emitSessionStart("resume");
  assert.ok(
    fallbackHarness.notifications.some(
      (item) => item.status?.[1] === `insight ${state.id} · Memory Review`,
    ),
    "old sessions without custom binding restore from state.json path in branch entries",
  );

  const outsideSessionRoot = mkdtempSync(join(tmpdir(), "insight-extension-outside-sessions-"));
  const outsideSessionDir = join(outsideSessionRoot, "sessions", "2026-06-07-spoof-abcdef");
  mkdirSync(outsideSessionDir, { recursive: true });
  writeFileSync(
    join(outsideSessionDir, "state.json"),
    JSON.stringify({ ...state, id: "abcdef", rawInsight: "spoofed outside session" }, null, 2),
    "utf-8",
  );
  const spoofedPathHarness = createHarness(cwd, [
    {
      type: "message",
      id: "message-with-spoofed-path",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        content: [{ type: "text", text: `spoofed state path: ${join(outsideSessionDir, "state.json")}` }],
      },
    },
  ]);
  await spoofedPathHarness.emitSessionStart("resume");
  assert.ok(
    spoofedPathHarness.notifications.some((item) => item.status?.[1] === ""),
    "state.json paths outside the configured insight sessions root are ignored",
  );
  await spoofedPathHarness.commands.get("insight").handler("current", spoofedPathHarness.ctx);
  assert.equal(spoofedPathHarness.editorTexts.at(-1), "No active insight session.");
  rmSync(outsideSessionRoot, { recursive: true, force: true });

  const cancelledRestoreHarness = createHarness(cwd, [
    {
      type: "custom",
      customType: "insight.active_session",
      data: { active: true, sessionId: state.id },
      id: "custom-old-active",
      parentId: null,
      timestamp: new Date().toISOString(),
    },
    {
      type: "custom",
      customType: "insight.active_session",
      data: { active: false },
      id: "custom-new-inactive",
      parentId: null,
      timestamp: new Date().toISOString(),
    },
  ]);
  await cancelledRestoreHarness.emitSessionStart("resume");
  assert.ok(
    cancelledRestoreHarness.notifications.some((item) => item.status?.[1] === ""),
    "latest inactive binding prevents cancelled insight mode from being resurrected",
  );

  await insight.handler(`resume ${state.id}`, harness.ctx);

  await harness.tools.get("insight_update_state").execute(
    "tool-enter-grill",
    { stage: "review_grill" },
    undefined,
    undefined,
    harness.ctx,
  );
  state = JSON.parse(readFileSync(statePath, "utf-8"));
  assert.equal(state.stage, "review_grill");
  const grillBriefingPath = join(sessionDir, "grill-briefing.md");
  assert.ok(existsSync(grillBriefingPath), "grill-briefing.md written when entering grill");
  const grillBriefing = readFileSync(grillBriefingPath, "utf-8");
  assert.ok(grillBriefing.includes("Grill Briefing"));
  assert.ok(!grillBriefing.includes("multiple-choice"), "briefing does not hard-ban answer forms");
  assert.ok(grillBriefing.includes("可用的旧笔记阻力"));
  const compactGrillMessages = await harness.emitContext([
    { role: "user", content: "旧 memory 表格消息", timestamp: Date.now() - 2 },
    { role: "assistant", content: "| Note | Relation |", timestamp: Date.now() - 1 },
    { role: "user", content: "进入 grill 后继续", timestamp: Date.now() },
  ]);
  assert.equal(compactGrillMessages.length, 2, "entering grill compacts context to hidden briefing plus latest user turn");
  assert.ok(compactGrillMessages[0].content.includes("Grill Briefing"));
  assert.equal(compactGrillMessages[1].content, "进入 grill 后继续");
  assert.ok(
    harness.notifications.some((item) => item.status?.[1] === `insight ${state.id} · Grill`),
    "status line updates to grill",
  );

  const beforeNoOpEntryCount = harness.sessionEntries.length;
  const beforeNoOpState = JSON.parse(readFileSync(statePath, "utf-8"));
  const sameStageResult = await harness.tools.get("insight_update_state").execute(
    "tool-same-stage",
    { stage: "review_grill" },
    undefined,
    undefined,
    harness.ctx,
  );
  const afterNoOpState = JSON.parse(readFileSync(statePath, "utf-8"));
  assert.ok(sameStageResult.content[0].text.includes("no state update needed"));
  assert.equal(afterNoOpState.updatedAt, beforeNoOpState.updatedAt, "same-stage-only update does not rewrite state");
  assert.equal(harness.sessionEntries.length, beforeNoOpEntryCount, "same-stage-only update does not persist binding");

  await harness.tools.get("insight_update_state").execute(
    "tool-2",
    {
      usedMemoryIds: [state.memoryCandidates[0].id],
      newInsight: { text: "反馈不是评价，而是显影", openedDirection: true },
      grillTurn: {
        question: "这个 insight 改变了哪个旧判断？",
        answer: "它改变了我对反馈的理解。",
      },
      candidateJudgment: {
        text: "高质量反馈的核心是让判断可被现实修正。",
        userStatus: "pending",
      },
    },
    undefined,
    undefined,
    harness.ctx,
  );

  await harness.tools.get("insight_append_grill_context").execute("tool-3", {
    heading: "Resolved Term",
    body: "反馈在这里更接近显影装置，而不是评价。",
  });

  assert.ok(readFileSync(grillPath, "utf-8").includes("反馈在这里更接近显影装置"));
  assert.ok(readFileSync(grillPath, "utf-8").includes("## 已稳定术语"));

  await harness.tools.get("insight_save_summary").execute(
    "tool-4",
    {
      summaryDraft:
        "# Summary Draft\n\n原判断 -> 新判断：反馈不是外部评价，而是让判断被修正的显影装置。",
      usedMemoryIds: [state.memoryCandidates[0].id],
      unresolvedQuestions: ["反馈密度如何量化？"],
      markComplete: true,
    },
    undefined,
    undefined,
    harness.ctx,
  );

  const summaryPath = join(sessionDir, "summary-draft.md");
  assert.ok(existsSync(summaryPath), "summary-draft.md written");
  state = JSON.parse(readFileSync(statePath, "utf-8"));
  assert.equal(state.stage, "complete");
  assert.ok(state.summaryDraft.includes("原判断 -> 新判断"));
  assert.ok(
    harness.notifications.some((item) => item.status?.[1] === `insight ${state.id} · Complete`),
    "status line updates to complete",
  );

  await insight.handler("list", harness.ctx);
  assert.ok(harness.editorTexts.at(-1).includes("| Session | Stage | Updated | Title |"));

  const sentBeforeResume = harness.sentMessages.length;
  await insight.handler(`resume ${state.id}`, harness.ctx);
  assert.equal(harness.sentMessages.length, sentBeforeResume, "resume does not send a new visible follow-up message");
  const resumeInjectedMessages = await harness.emitContext([
    { role: "user", content: "继续这个 insight", timestamp: Date.now() },
  ]);
  assert.ok(resumeInjectedMessages[0].content.includes("Resume the active /insight session."));

  const beforeSecondSessionCount = JSON.parse(readFileSync(indexPath, "utf-8")).length;
  await insight.handler(
    [
      "Insight: 第二个 insight",
      "",
      "Context: 第二个 context",
    ].join("\\n"),
    harness.ctx,
  );
  const nextIndex = JSON.parse(readFileSync(indexPath, "utf-8"));
  assert.equal(nextIndex.length, beforeSecondSessionCount + 1, "new insight session is indexed");
  assert.notEqual(nextIndex[0].dir, nextIndex[1].dir, "session directories are isolated");

  const otherHarness = createHarness(otherCwd);
  await otherHarness.commands.get("insight").handler("list", otherHarness.ctx);
  assert.ok(
    otherHarness.editorTexts.at(-1).includes("这是一个关于学习系统的测试"),
    "global insight list works from another cwd",
  );

  await otherHarness.commands.get("insight").handler(`resume ${state.id}`, otherHarness.ctx);
  assert.equal(otherHarness.sentMessages.length, 0, "global resume does not send visible follow-up");
  const otherResumeInjectedMessages = await otherHarness.emitContext([
    { role: "user", content: "继续跨路径 session", timestamp: Date.now() },
  ]);
  assert.ok(otherResumeInjectedMessages[0].content.includes("Resume the active /insight session."));

  await otherHarness.commands.get("insight").handler("", otherHarness.ctx);
  assert.ok(
    otherHarness.notifications.some((item) => item.message?.includes("Insight mode cancelled")),
    "blank /insight cancels the active insight mode",
  );
  await otherHarness.commands.get("insight").handler("current", otherHarness.ctx);
  assert.equal(otherHarness.editorTexts.at(-1), "No active insight session.");

  const fullCommandHarness = createHarness(cwd);
  await fullCommandHarness.commands.get("insight").handler("/insight", fullCommandHarness.ctx);
  const fullCommandIndex = JSON.parse(readFileSync(indexPath, "utf-8"));
  const fullCommandState = JSON.parse(readFileSync(join(fullCommandIndex[0].dir, "state.json"), "utf-8"));
  assert.equal(fullCommandState.rawInsight, "编辑器输入 insight");
  assert.notEqual(fullCommandState.rawInsight, "/insight");

  const sourceNotePath = join(cwd, "和 Linya 碰面的三天.md");
  writeFileSync(
    sourceNotePath,
    [
      "# 见面经过",
      "",
      "这里记录具体相处过程。",
      "",
      "## 心动与退潮",
      "",
      "这里记录心动、分别后的落差和后续判断。",
    ].join("\n"),
    "utf-8",
  );
  const pathHarness = createHarness(cwd);
  await pathHarness.commands.get("insight").handler(
    [
      "Insight:",
      sourceNotePath,
      "里面包含了我的 insight",
      "",
      "Context:",
      sourceNotePath,
      "里面包含了我的 insight",
    ].join("\n"),
    pathHarness.ctx,
  );
  const pathIndex = JSON.parse(readFileSync(indexPath, "utf-8"));
  assert.ok(
    pathIndex[0].dir.includes("和-linya-碰面的三天"),
    "path-like input creates concise session directory from source note title",
  );
  assert.ok(
    !pathIndex[0].dir.includes("usershongobsidian"),
    "session directory does not slugify the full absolute path",
  );
  const pathState = JSON.parse(readFileSync(join(pathIndex[0].dir, "state.json"), "utf-8"));
  assert.equal(pathState.sourceNote.path, sourceNotePath);
  assert.ok(pathState.sourceNote.content.includes("## 心动与退潮"));
  const pathInjectedMessages = await pathHarness.emitContext([
    { role: "user", content: "正式开始处理路径 insight", timestamp: Date.now() },
  ]);
  assert.ok(!pathInjectedMessages[0].content.includes("Summary structure rule"));
  assert.ok(pathInjectedMessages[0].content.includes("Source note for memory search:"));
  assert.ok(pathInjectedMessages[0].content.includes("这里记录心动、分别后的落差和后续判断。"));
  await pathHarness.tools.get("insight_search_memory").execute(
    "path-memory-search",
    { queries: [{ text: "心动 分别 落差 后续判断", kind: "raw" }], limit: 4 },
    undefined,
    undefined,
    pathHarness.ctx,
  );
  await pathHarness.tools.get("insight_update_state").execute(
    "path-enter-grill",
    { stage: "review_grill" },
    undefined,
    undefined,
    pathHarness.ctx,
  );
  const pathGrillMessages = await pathHarness.emitContext([
    { role: "user", content: "进入 grill", timestamp: Date.now() },
  ]);
  assert.ok(pathGrillMessages[0].content.includes("Original Obsidian source note heading order"));
  assert.ok(pathGrillMessages[0].content.includes("# 见面经过"));
  assert.ok(pathGrillMessages[0].content.includes("## 心动与退潮"));

  const fallbackSourcePath = join(cwd, "fallback source.md");
  writeFileSync(fallbackSourcePath, "# Fallback Source\n\n只有显式 source note 才允许文件 fallback。", "utf-8");
  process.env.OBSIDIAN_FAKE_MODE = "fail";
  const implicitPathHarness = createHarness(cwd);
  await implicitPathHarness.commands.get("insight").handler(
    [
      "Insight:",
      fallbackSourcePath,
      "",
      "Context: 这里只是普通路径引用",
    ].join("\n"),
    implicitPathHarness.ctx,
  );
  const implicitIndex = JSON.parse(readFileSync(indexPath, "utf-8"));
  const implicitState = JSON.parse(readFileSync(join(implicitIndex[0].dir, "state.json"), "utf-8"));
  assert.equal(implicitState.sourceNote, undefined, "implicit absolute markdown path is not read via filesystem fallback");

  const explicitFallbackHarness = createHarness(cwd);
  await explicitFallbackHarness.commands.get("insight").handler(
    [
      "Insight: fallback source note",
      "",
      "Context: 测试 Obsidian CLI 失败后的显式 fallback",
      "",
      "Source Note:",
      fallbackSourcePath,
    ].join("\n"),
    explicitFallbackHarness.ctx,
  );
  const explicitFallbackIndex = JSON.parse(readFileSync(indexPath, "utf-8"));
  const explicitFallbackState = JSON.parse(readFileSync(join(explicitFallbackIndex[0].dir, "state.json"), "utf-8"));
  assert.equal(explicitFallbackState.sourceNote.path, fallbackSourcePath);
  assert.ok(explicitFallbackState.sourceNote.content.includes("只有显式 source note"));

  const naturalSourcePath = join(cwd, "2026-06-07 和 Linya 碰面的三天.md");
  writeFileSync(naturalSourcePath, "# Natural Source\n\n自然语言说明这是我的原始笔记也应当允许 fallback。", "utf-8");
  const naturalSourceHarness = createHarness(cwd);
  await naturalSourceHarness.commands.get("insight").handler(
    `${naturalSourcePath}; 这是我的原始笔记，里面也有我的 insight 和一些思考`,
    naturalSourceHarness.ctx,
  );
  const naturalSourceIndex = JSON.parse(readFileSync(indexPath, "utf-8"));
  const naturalSourceState = JSON.parse(readFileSync(join(naturalSourceIndex[0].dir, "state.json"), "utf-8"));
  assert.equal(naturalSourceState.sourceNote.path, naturalSourcePath);
  assert.ok(naturalSourceState.sourceNote.content.includes("自然语言说明"));
  assert.ok(
    naturalSourceIndex[0].dir.includes("和-linya-碰面的三天"),
    "leading date is stripped from source note title before date-stamped session dir",
  );
  assert.ok(
    !naturalSourceIndex[0].dir.includes("2026-06-07-2026-06-07"),
    "session directory does not duplicate source note date prefix",
  );
  delete process.env.OBSIDIAN_FAKE_MODE;

  const wikiHarness = createHarness(cwd);
  await wikiHarness.commands.get("insight").handler(
    [
      "Insight: [[Wiki Source Note]]",
      "",
      "Context: wiki link source note",
    ].join("\n"),
    wikiHarness.ctx,
  );
  const wikiIndex = JSON.parse(readFileSync(indexPath, "utf-8"));
  const wikiState = JSON.parse(readFileSync(join(wikiIndex[0].dir, "state.json"), "utf-8"));
  assert.ok(wikiState.sourceNote.content.includes("由 Obsidian CLI 读取的 wiki note"));
  const wikiInjectedMessages = await wikiHarness.emitContext([
    { role: "user", content: "正式开始处理 wiki insight", timestamp: Date.now() },
  ]);
  assert.ok(!wikiInjectedMessages[0].content.includes("Summary structure rule"));
  await wikiHarness.tools.get("insight_search_memory").execute(
    "wiki-memory-search",
    { queries: [{ text: "wiki source note", kind: "raw" }], limit: 4 },
    undefined,
    undefined,
    wikiHarness.ctx,
  );
  await wikiHarness.tools.get("insight_update_state").execute(
    "wiki-enter-grill",
    { stage: "review_grill" },
    undefined,
    undefined,
    wikiHarness.ctx,
  );
  const wikiGrillMessages = await wikiHarness.emitContext([
    { role: "user", content: "进入 grill", timestamp: Date.now() },
  ]);
  assert.ok(wikiGrillMessages[0].content.includes("# Wiki Heading"));

  console.log("insight extension tests passed");
} finally {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(otherCwd, { recursive: true, force: true });
  rmSync(insightHome, { recursive: true, force: true });
  rmSync(fakeBinDir, { recursive: true, force: true });
  delete process.env.QMD_BIN;
  delete process.env.OBSIDIAN_BIN;
  delete process.env.QMD_FAKE_MODE;
  delete process.env.OBSIDIAN_FAKE_MODE;
  delete process.env.INSIGHT_EXPAND_BACKLINKS;
  delete process.env.INSIGHT_MEMORY_RERANKER;
  delete process.env.INSIGHT_COMMAND_OUTPUT_MAX_BYTES;
}
