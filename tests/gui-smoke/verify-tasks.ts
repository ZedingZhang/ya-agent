import { dialog, type BrowserWindow } from "electron";
import { appendAuditRecord } from "../../dist/typescript/audit-log";
import { DeepSeekClient, type FetchLike } from "../../dist/typescript/deepseek";
import { createFileChange } from "../../dist/typescript/file-diff";
import { GuiController, LANGUAGES, type GuiRunCallbacks, type GuiTaskOptions, type Language } from "../../dist/typescript/gui/controller";
import { DesktopRuntime } from "../../dist/typescript/gui/main/runtime";
import { type RunResult } from "../../dist/typescript/orchestrator";
import { runTask, TaskStore } from "../../dist/typescript/service";
import type { ChatMessage } from "../../dist/typescript/types";
import { verifyRenderer } from "./verify-workspace";

export async function verifyStorageManagement(window: BrowserWindow): Promise<void> {
  const day = new Date(2004, 3, 4);
  const store = new TaskStore({ now: () => day, reconcileOnStartup: false });
  const legacyTask = store.create({ objective: "Cleanup fixture" });
  store.transition(legacyTask.id, "completed");
  appendAuditRecord({ timestamp: day.toISOString(), operation: "read" });
  await window.webContents.executeJavaScript(`(async () => {
    const original = currentBot;
    const confirm = window.confirm;
    const fixture = createBot({ title: 'Cleanup fixture', instructions: 'Keep this profile' });
    const turn = (task, createdAt) => ({ task, createdAt, images: [], answer: task, status: 'complete', commands: [], changes: [] });
    fixture.turns.push(turn('undated'), turn('previous day', new Date(2004, 3, 3, 23, 59, 59).getTime()),
      { ...turn('midnight'), taskId: '${legacyTask.id}' }, turn('late', new Date(2004, 3, 4, 23, 59, 59, 999).getTime()));
    fixture.draft = 'Keep this draft';
    fixture.activities.push({ operation: 'read', paths: ['old.txt'], status: 'success' });
    try {
      await selectBot(fixture);
      element('settings-tab').click();
      document.querySelector('[data-settings-tab="storage"]').click();
      element('storage-period').value = 'custom';
      element('storage-period').dispatchEvent(new Event('change'));
      element('storage-from').value = '2004-04-04';
      element('storage-to').value = '2004-04-03';
      element('storage-to').dispatchEvent(new Event('input'));
      if (!element('storage-delete').disabled) throw new Error('Reversed dates enabled deletion.');
      element('storage-to').value = '2004-04-04';
      element('storage-to').dispatchEvent(new Event('input'));
      await refreshStorage();
      if (element('storage-delete').disabled || storageSelection().length !== 2) throw new Error('Single-day selection missed a boundary.');
      let prompted = false;
      window.confirm = (message) => { prompted = message.includes('2004-04-04'); return false; };
      element('storage-delete').click();
      if (!prompted || fixture.turns.length !== 4) throw new Error('Cancelled deletion changed chat history.');
      window.confirm = () => true;
      await deleteSelectedHistory();
      const saved = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY)).sessions.find((bot) => bot.id === fixture.id);
      if (saved.turns.map((entry) => entry.task).join('|') !== 'undated|previous day' || saved.activities.length
        || saved.draft !== fixture.draft || saved.instructions !== fixture.instructions || !element('storage-delete').disabled
        || document.querySelectorAll('#timeline .turn').length !== 2) throw new Error('Cleanup did not persist the expected turns and bot profile.');
      for (const kind of ['tasks', 'audit']) {
        element('storage-kind').value = kind;
        await refreshStorage();
        if (storageSelection().length !== 1) throw new Error('Missing dated ' + kind + ' record in preview.');
        await deleteSelectedHistory();
        if (!element('storage-delete').disabled || storageSelection().length) throw new Error('Deletion failed for ' + kind);
      }
    } finally {
      window.confirm = confirm;
      element('storage-kind').value = 'chats';
      element('storage-period').value = '30';
      bots = bots.filter((bot) => bot !== fixture);
      await selectBot(original);
    }
  })()`);
}

export async function verifyTaskHistory(runtime: DesktopRuntime, window: BrowserWindow): Promise<void> {
  const originalController = runtime.controller;
  const firstChunk = "A streamed ";
  const markdown = ["A streamed reply.", "- one", "- two", "```ts", "const n = 1;", "```"].join("\n");
  runtime.controller = new GuiController(async (_apiKey, task, _config, options = {}) => {
    if (task === "smoke-error") throw new Error("Expected smoke failure");
    if (task === "smoke-stream" || task === "smoke-stream-characters") {
      options.onContent?.(firstChunk);
      const delivered = await window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          if (document.body.classList.contains('task-running') && activeTurn?.status === 'running'
            && activeTurn.answer === 'A streamed ' && activeAnswer?.textContent.includes('A streamed')) return true;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return false;
      })()`) as boolean;
      if (!delivered) throw new Error("The live streaming chunk did not reach the running conversation.");
      const rest = markdown.slice(firstChunk.length);
      for (const chunk of task === "smoke-stream" ? [rest] : rest) options.onContent?.(chunk);
      return { content: markdown, mode: "single", usage: {} };
    }
    if (options.localWorkspace) {
      await options.localWorkspace.write({ path: "smoke.txt", content: "Approved smoke task" });
      if (task === "smoke-approval") {
        const result = JSON.parse(await options.localWorkspace.toolHandlers.local_search!({ query: "Approved smoke task" }));
        if (!result.results.some((hit: { path: string }) => hit.path === "smoke.txt")) throw new Error("Granted folder search failed.");
      }
    }
    return { content: "A streamed reply.", mode: "single", usage: {} };
  });
  runtime.controller.setSessionApiKey("smoke-only-key");
  const originalPicker = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [originalController.folderState().validWorkspace!] });
  try {
    const results = await window.webContents.executeJavaScript(`(async () => {
      try {
      const originalSession = currentBot;
      state = await bridge.state();
      const fixtureBot = createBot();
      await selectBot(fixtureBot);
      await updateFolderAccess(false);
      const testSession = currentBot;
      const input = document.querySelector('#task-input');
      document.querySelector('#local-enabled').checked = false;
      document.querySelector('#web-mode').value = 'off';
      syncWorkspaceControls();
      const markdown = ${JSON.stringify(markdown)};
      const expected = document.createElement('div');
      renderMarkdown(expected, markdown);
      const render = renderMarkdown;
      try {
        for (const task of ['smoke-stream', 'smoke-stream-characters']) {
          const parsed = [];
          renderMarkdown = (container, text) => { parsed.push(text); render(container, text); };
          input.value = task;
          await runTask();
          const turn = currentBot.turns.at(-1);
          const answer = document.querySelector('#timeline .turn:last-child .answer-card');
          if (turn.status !== 'complete' || turn.answer !== markdown || answer?.innerHTML !== expected.innerHTML
            || !answer.querySelector('p + ul + pre > code') || answer.querySelectorAll('li').length !== 2) {
            throw new Error(task + ' produced a different final answer.');
          }
          if (parsed.length !== 1 || parsed[0] !== markdown) throw new Error(task + ' parsed intermediate Markdown.');
        }
      } finally { renderMarkdown = render; }
      document.querySelector('#local-enabled').checked = true;
      syncWorkspaceControls();
      input.value = 'smoke-approval';
      const running = runTask();
      const deadline = Date.now() + 3000;
      while (!pendingAction && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      if (!pendingAction) {
        await bridge.cancelTask();
        await running;
        throw new Error('The live task did not request approval.');
      }
      const automaticApproval = !document.querySelector('#details-drawer').hidden && drawerPage === 'activity'
        && !document.querySelector('#action-content').hidden;
      const originalFolder = state.workspace;
      let folderLocked = false;
      try { await bridge.revokeFolder(currentBot.id); } catch (error) { folderLocked = errorText(error).includes('running'); }
      const navigationLocked = document.querySelector('#new-bot').disabled
        && document.querySelector('#choose-workspace').disabled;
      document.querySelector('#action-approve').click();
      await running;
      const approvalCompleted = currentBot.turns.at(-1).status === 'complete'
        && currentBot.activities.some((activity) => activity.operation === 'write' && activity.status === 'success')
        && state.workspace === originalFolder;
      const changeDelivered = currentBot.turns.at(-1).changes.length === 1
        && currentBot.turns.at(-1).changes[0].operation === 'create'
        && document.querySelector('#timeline .file-change .addition .diff-code').textContent === 'Approved smoke task';
      document.querySelector('#toggle-changes').click();
      const changesPanel = drawerPage === 'changes' && !document.querySelector('#drawer-changes').hidden
        && document.querySelectorAll('#change-list .file-change').length === 1;
      input.value = 'smoke-denied';
      const deniedRun = runTask();
      const deniedDeadline = Date.now() + 3000;
      while (!pendingAction && Date.now() < deniedDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
      if (!pendingAction) { await bridge.cancelTask(); await deniedRun; throw new Error('Denied task did not request approval.'); }
      document.querySelector('#action-deny').click();
      await deniedRun;
      const deniedChanges = currentBot.turns.at(-1).changes.length === 0
        && botChanges().length === 1 && document.querySelectorAll('#timeline .file-change').length === 1;
      input.value = 'smoke-error';
      await runTask();
      const failureSaved = currentBot.turns.at(-1).status === 'error'
        && currentBot.turns.at(-1).answer.includes('Expected smoke failure')
        && !document.body.classList.contains('task-running') && !document.querySelector('#send-button').disabled;
      await selectBot(originalSession);
      await selectBot(testSession);
      const historyRestored = document.querySelector('#timeline').textContent.includes('A streamed reply.')
        && document.querySelector('#timeline').textContent.includes('Expected smoke failure')
        && document.querySelector('#timeline .file-change .addition .diff-code').textContent === 'Approved smoke task';
      bots = bots.filter((session) => session.id !== testSession.id);
      await selectBot(originalSession);
      return { automaticApproval, folderLocked, navigationLocked, approvalCompleted, changeDelivered,
        changesPanel, deniedChanges, failureSaved, historyRestored };
      } catch (error) { return { failure: errorText(error) }; }
    })()`) as Record<string, boolean | string>;
    for (const [name, value] of Object.entries(results)) {
      if (value !== true) throw new Error(`Desktop task history check failed: ${name} (${value}).`);
    }
  } finally {
    dialog.showOpenDialog = originalPicker;
    runtime.controller = originalController;
    await window.webContents.executeJavaScript("(async () => { state = await bridge.state(); fillSettings(); renderNavigation(); })()");
  }
}

export async function verifyApprovalLifecycle(runtime: DesktopRuntime, window: BrowserWindow): Promise<void> {
  const language = await window.webContents.executeJavaScript("state.language") as Language;
  try {
    for (const locale of LANGUAGES) {
      const expiredId = `smoke-expired-${locale}`;
      const acceptedId = `smoke-accepted-${locale}`;
      await window.webContents.executeJavaScript(`
        state.language = ${JSON.stringify(locale)}; applyLanguage();
        pendingAction = { id: ${JSON.stringify(expiredId)}, action: { operation: 'write', paths: ['expired.txt'], summary: 'Expired action' } };
        actionExpired = false; setRunning(true); renderPendingAction(); setDrawer('activity'); setStatus(t('waiting'), 'busy');
      `);
      runtime.sendTaskEvent({ type: "local-action-expired", id: expiredId });
      const expired = await window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 3000;
        while (pendingAction && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        const hidden = !pendingAction && document.querySelector('#action-content').hidden;
        const notice = document.querySelector('#action-empty').textContent === t('approvalExpired');
        const status = document.querySelector('#app-status').textContent;
        document.querySelector('#action-approve').click();
        bridge.respondLocalAction(${JSON.stringify(expiredId)}, true);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const lateIgnored = document.querySelector('#app-status').textContent === status && status === t('approvalExpired');
        pendingAction = { id: ${JSON.stringify(acceptedId)}, action: { operation: 'write', paths: ['accepted.txt'], summary: 'Await acknowledgement' } };
        actionExpired = false; renderPendingAction(); setStatus(t('waiting'), 'busy');
        activeTurn = { turnId: crypto.randomUUID(), task: 'approval', answer: '', images: [], status: 'running', commands: [], changes: [] };
        currentBot.turns.push(activeTurn);
        const save = Storage.prototype.setItem;
        try {
          Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
          decideLocalAction(true);
          if (pendingAction.responding || document.querySelector('#app-status').textContent !== t('historySaveError')) return false;
        } finally { Storage.prototype.setItem = save; }
        setStatus(t('waiting'), 'busy');
        decideLocalAction(true);
        currentBot.turns.pop();
        activeTurn = undefined;
        persistSessions();
        const awaitsAck = pendingAction?.id === ${JSON.stringify(acceptedId)} && pendingAction.responding
          && document.querySelector('#action-approve').disabled && document.querySelector('#app-status').textContent === t('waiting');
        return hidden && notice && lateIgnored && awaitsAck;
      })()`) as boolean;
      if (!expired) throw new Error(`Approval expiration or late-click feedback failed (${locale}).`);
      // An older event must not clear a newer pending action.
      runtime.sendTaskEvent({ type: "local-action-expired", id: expiredId });
      runtime.sendTaskEvent({ type: "local-action-resolved", id: acceptedId });
      const accepted = await window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 3000;
        while (pendingAction && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        return !pendingAction && document.querySelector('#action-content').hidden
          && document.querySelector('#app-status').textContent === t('working');
      })()`) as boolean;
      if (!accepted) throw new Error(`Accepted approval acknowledgement was not displayed (${locale}).`);
    }
  } finally {
    await window.webContents.executeJavaScript(`pendingAction = undefined; actionExpired = false; setRunning(false);
      state.language = ${JSON.stringify(language)}; applyLanguage(); renderPendingAction(); setStatus(t('done'));`);
  }
}

export async function verifyApprovalAccessibility(runtime: DesktopRuntime, window: BrowserWindow): Promise<void> {
  const originalLanguage = await window.webContents.executeJavaScript("state.language") as Language;
  try {
    for (const language of LANGUAGES) {
      const id = `accessible-approval-${language}`;
      const summary = "Create text file: synthetic-approval.txt";
      await window.webContents.executeJavaScript(`state.language = ${JSON.stringify(language)}; applyLanguage();
        switchPage('workspace'); setRunning(true); document.querySelector('#toggle-files').focus();`);
      runtime.sendTaskEvent({ type: "local-action", id, action: { operation: "write", paths: ["synthetic-approval.txt"], summary } });
      const names = await window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 3000;
        while (pendingAction?.id !== ${JSON.stringify(id)} && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        if (document.activeElement?.id !== 'action-deny') throw new Error('Approval did not take focus.');
        const toggle = document.querySelector('#toggle-activity');
        if (toggle.getAttribute('aria-label') !== t('activityPending') || toggle.title !== t('activityPending')) throw new Error('Missing pending accessible name.');
        if (document.querySelector('#approval-announcement').textContent !== t('approvalAnnouncement')) throw new Error('Missing live announcement.');
        document.querySelector('#task-options').open = true;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        if (document.querySelector('#task-options').open || document.querySelector('#details-drawer').hidden
          || document.querySelector('#action-content').hidden || drawerPage !== 'activity' || document.activeElement?.id !== 'action-deny') {
          throw new Error('Escape hid the approval or lost its focus.');
        }
        return { heading: t('pendingAction'), deny: t('deny'), announcement: t('approvalAnnouncement') };
      })()`) as { heading: string; deny: string; announcement: string };
      const attached = window.webContents.debugger.isAttached();
      if (!attached) window.webContents.debugger.attach("1.3");
      try {
        await window.webContents.debugger.sendCommand("Accessibility.enable");
        const tree = await window.webContents.debugger.sendCommand("Accessibility.getFullAXTree") as {
          nodes: Array<{ nodeId: string; ignored: boolean; role?: { value: string }; name?: { value: string };
            description?: { value: string }; childIds?: string[]; properties?: Array<{ name: string; value: { value: unknown } }> }>;
        };
        const nodes = tree.nodes.filter((node) => !node.ignored);
        // Chromium can expose the Activity heading's CSS capitalization in the region name.
        const heading = names.heading.toLocaleLowerCase(language);
        const region = nodes.find((node) => node.role?.value === "region" && node.name?.value.toLocaleLowerCase(language) === heading);
        const deny = nodes.find((node) => node.role?.value === "button" && node.name?.value === names.deny && node.description?.value === summary);
        const announced = nodes.find((node) => node.role?.value === "StaticText" && node.name?.value === names.announcement);
        const live = nodes.find((node) => node.role?.value === "status" && node.childIds?.includes(announced?.nodeId ?? "")
          && node.properties?.some((property) => property.name === "live" && property.value.value === "polite"));
        if (!region || !deny?.properties?.some((property) => property.name === "focused" && property.value.value === true) || !live) {
          throw new Error(`Approval landmark, focused description, or live status missing from the accessibility tree (${language}).`);
        }
      } finally { if (!attached) window.webContents.debugger.detach(); }
      await window.webContents.executeJavaScript(`pendingAction.responding = true; renderPendingAction();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        if (document.activeElement?.id !== 'action-summary') throw new Error('Disabled approval lost its keyboard target.');`);
      runtime.sendTaskEvent({ type: "local-action-resolved", id });
      const restored = await window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 3000;
        while (pendingAction && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        return document.activeElement?.id === 'toggle-files' && document.querySelector('#toggle-activity').getAttribute('aria-label') === t('activity');
      })()`) as boolean;
      if (!restored) throw new Error(`Approval did not restore prior focus and accessible name (${language}).`);
      await window.webContents.executeJavaScript(`setRunning(false); document.querySelector('#task-input').focus(); setRunning(true);
        // Hidden smoke windows may retain a disabled input as activeElement until explicitly blurred.
        document.activeElement?.blur();
        if (document.activeElement !== document.body) throw new Error('Expected document focus before approval.');`);
      runtime.sendTaskEvent({ type: "local-action", id: `${id}-disabled-input`, action: { operation: "write", paths: [], summary } });
      await window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 3000;
        while (!pendingAction && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      })()`);
      runtime.sendTaskEvent({ type: "local-action-resolved", id: `${id}-disabled-input` });
      const fallback = await window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 3000;
        while (pendingAction && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        return document.activeElement?.id === 'toggle-activity';
      })()`) as boolean;
      if (!fallback) throw new Error(`Approval did not restore usable focus after the composer was disabled (${language}).`);
      runtime.sendTaskEvent({ type: "local-action", id: `${id}-expired`, action: { operation: "write", paths: [], summary } });
      await window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 3000;
        while (!pendingAction && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        document.querySelector('#toggle-changes').focus();
      })()`);
      runtime.sendTaskEvent({ type: "local-action-expired", id: `${id}-expired` });
      const keptFocus = await window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 3000;
        while (pendingAction && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        return document.activeElement?.id === 'toggle-changes';
      })()`) as boolean;
      if (!keptFocus) throw new Error("Expiration stole focus after the user moved outside the approval.");
    }
  } finally {
    await window.webContents.executeJavaScript(`clearPendingAction(false); setRunning(false);
      state.language = ${JSON.stringify(originalLanguage)}; applyLanguage();`);
  }
}

export async function verifyIcmHistory(runtime: DesktopRuntime, window: BrowserWindow): Promise<void> {
  const originalController = runtime.controller;
  let requests = 0;
  const fetcher: FetchLike = async (_input, init) => {
    requests += 1;
    const payload = JSON.parse(String(init?.body)) as { messages: ChatMessage[]; stream: boolean };
    const supplement = String(payload.messages[0]?.content).includes("prior draft identifies");
    const content = supplement ? "Evidence [icm_gap] and [ICM_GAP]." : "Draft [ICM_GAP] and [icm_gap].";
    return new Response(payload.stream
      ? `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`
      : JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
  };
  runtime.controller = new GuiController((apiKey, task, config, options = {}) => runTask(apiKey, task, config, {
    ...options, clientFactory: (key, signal) => new DeepSeekClient(key, fetcher, undefined, signal),
  }));
  runtime.controller.setSessionApiKey("smoke-only-key");
  let fixture: { id: string; originalId: string; clean: boolean } | undefined;
  try {
    fixture = await window.webContents.executeJavaScript(`(async () => {
      const originalId = currentBot.id;
      state = await bridge.state();
      const session = createBot(); await selectBot(session);
      document.querySelector('#local-enabled').checked = false;
      document.querySelector('#toa-enabled').checked = false;
      document.querySelector('#web-mode').value = 'auto'; syncWorkspaceControls();
      document.querySelector('#task-input').value = 'Check answer cleanup'; await runTask();
      const answer = currentBot.turns.at(-1).answer;
      return { id: session.id, originalId, clean: answer.includes('Evidence supplement:') && !answer.toLowerCase().includes('[icm_gap]') };
    })()`) as typeof fixture;
    if (!fixture?.clean || requests !== 2) throw new Error("ICM result cleanup or single follow-up failed in the GUI.");
    await window.loadFile(runtime.rendererFile);
    await verifyRenderer(window);
    const restored = await window.webContents.executeJavaScript(`currentBot.id === ${JSON.stringify(fixture.id)}
      && !JSON.stringify(currentBot.turns).toLowerCase().includes('[icm_gap]')
      && !document.querySelector('#timeline').textContent.toLowerCase().includes('[icm_gap]')`) as boolean;
    if (!restored) throw new Error("ICM markers leaked into saved GUI history.");
  } finally {
    runtime.controller = originalController;
    if (fixture) await window.webContents.executeJavaScript(`(async () => {
      bots = bots.filter((session) => session.id !== ${JSON.stringify(fixture.id)});
      state = await bridge.state();
      await selectBot(bots.find((session) => session.id === ${JSON.stringify(fixture.originalId)}));
    })()`);
  }
}

export async function verifyConversationContext(runtime: DesktopRuntime, window: BrowserWindow): Promise<void> {
  const originalController = runtime.controller;
  const requests: ChatMessage[][] = [];
  const fetcher: FetchLike = async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as { messages: ChatMessage[]; stream: boolean };
    requests.push(payload.messages);
    if (payload.messages.at(-1)?.content === "Truncated stream request") {
      if (!payload.stream) throw new Error("The truncated conversation fixture needs streaming.");
      return new Response('data: {"choices":[{"delta":{"content":"Truncated reply"},"finish_reason":null}]}\n\n');
    }
    return new Response(payload.stream
      ? `data: ${JSON.stringify({ choices: [{ delta: { content: "Context smoke reply" } }] })}\n\ndata: [DONE]\n\n`
      : JSON.stringify({ choices: [{ message: { role: "assistant", content: "Context smoke reply" } }] }));
  };
  runtime.controller = new GuiController((apiKey, task, config, options = {}) => runTask(apiKey, task, config, {
    ...options,
    clientFactory: (key, signal) => new DeepSeekClient(key, fetcher, undefined, signal),
  }));
  const originalApiKey = runtime.controller.apiKey;
  runtime.controller.apiKey = () => undefined;
  let fixture: { originalId: string; sourceId: string } | undefined;
  let otherId: string | undefined;
  try {
    fixture = await window.webContents.executeJavaScript(`(async () => {
      const originalId = currentBot.id;
      state = await bridge.state();
      const count = bots.length;
      document.querySelector('#new-bot').click();
      const editor = document.querySelector('#bot-editor');
      const cancelled = new Promise((resolve) => editor.addEventListener('close', resolve, { once: true }));
      document.querySelector('#cancel-bot').click();
      await cancelled;
      if (bots.length !== count || currentBot.id !== originalId) throw new Error('Cancel created a bot.');
      const create = showBotEditor();
      document.querySelector('#bot-name').value = 'Reviewer';
      document.querySelector('#bot-instructions').value = 'Review patches.';
      document.querySelector('#save-bot').click();
      await create;
      const source = currentBot;
      const edit = showBotEditor(source);
      document.querySelector('#bot-name').value = 'Code reviewer';
      document.querySelector('#save-bot').click();
      await edit;
      if (bots.length !== count + 1 || source.title !== 'Code reviewer' || source.id === originalId) {
        throw new Error('Creating or renaming a bot did not preserve its identity.');
      }
      document.querySelector('#local-enabled').checked = false;
      document.querySelector('#web-mode').value = 'off';
      document.querySelector('#toa-enabled').checked = false;
      syncWorkspaceControls();
      document.querySelector('#task-input').value = '新建一个 md 文件，内容是 Ya 的介绍';
      await runTask();
      if (source.turns.at(-1).status !== 'error' || !source.turns.at(-1).answer.includes('Sign in to DeepSeek or add an API key')) {
        throw new Error('The missing-key conversation fixture did not fail as expected.');
      }
      return { originalId, sourceId: source.id };
    })()`) as { originalId: string; sourceId: string };
    runtime.controller.apiKey = originalApiKey;
    otherId = await window.webContents.executeJavaScript(`(async () => {
      state = await bridge.saveSettings({ ...state.config, language: state.language, stream: true,
        apiKey: 'smoke-only-key', keyStorage: 'session' });
      document.querySelector('#task-input').value = '继续';
      await runTask();
      document.querySelector('#task-input').value = 'Truncated stream request';
      await runTask();
      const failed = currentBot.turns.at(-1);
      if (failed.status !== 'error' || !failed.answer.includes('ended before completion')) {
        throw new Error('The truncated conversation fixture did not report an incomplete response.');
      }
      currentBot.turns.push({ task: 'Interrupted request', answer: 'Incomplete reply that must not be replayed',
        status: 'interrupted', images: [], commands: [], changes: [] });
      const other = createBot({ title: 'Research', instructions: '' });
      await selectBot(other);
      document.querySelector('#task-input').value = 'Unrelated session';
      await runTask();
      await selectBot(bots.find((session) => session.id === '${fixture.sourceId}'));
      return other.id;
    })()`) as string;
    await window.loadFile(runtime.rendererFile);
    await verifyRenderer(window);
    const restored = await window.webContents.executeJavaScript(`(async () => {
      if (currentBot.id !== '${fixture.sourceId}') return false;
      if (currentBot.turns.find((turn) => turn.task === 'Truncated stream request')?.status !== 'error') return false;
      document.querySelector('#local-enabled').checked = false;
      document.querySelector('#web-mode').value = 'off';
      document.querySelector('#task-input').value = '接着写';
      await runTask();
      return currentBot.turns.at(-1).status === 'complete';
    })()`) as boolean;
    const originalRequest = { role: "user", content: "新建一个 md 文件，内容是 Ya 的介绍" };
    const followUp = { role: "user", content: "继续" };
    const profileMessage = (name: string, instructions: string) => ({
      role: "user", content: `Bot profile: ${JSON.stringify({ name, instructions })}`,
    });
    const reviewer = profileMessage("Code reviewer", "Review patches.");
    const answer = { role: "assistant", content: "Context smoke reply" };
    const truncated = { role: "user", content: "Truncated stream request" };
    const expected = [
      [reviewer, originalRequest, followUp],
      [reviewer, originalRequest, followUp, answer, truncated],
      [profileMessage("Research", ""), { role: "user", content: "Unrelated session" }],
      [reviewer, originalRequest, followUp, answer, truncated,
        { role: "user", content: "Interrupted request" }, { role: "user", content: "接着写" }],
    ];
    if (!restored || JSON.stringify(requests.map((messages) => messages.slice(1))) !== JSON.stringify(expected)) {
      throw new Error("Model requests lost conversation context after a task failure, session switch, or reload.");
    }
  } finally {
    runtime.controller = originalController;
    if (fixture) await window.webContents.executeJavaScript(`(async () => {
      state = await bridge.state();
      bots = bots.filter((session) => !['${fixture.sourceId}', '${otherId ?? ""}'].includes(session.id));
      await selectBot(bots.find((session) => session.id === '${fixture.originalId}'));
    })()`);
  }
}

export async function verifyReloadDuringTask(runtime: DesktopRuntime, window: BrowserWindow): Promise<void> {
  const originalController = runtime.controller;
  let signal: AbortSignal | undefined;
  let taskStarted = false;
  let deliverLate!: () => void;
  let release!: () => void;
  let finished!: () => void;
  const stopping = new Promise<void>((resolve) => { release = resolve; });
  const stopped = new Promise<void>((resolve) => { finished = resolve; });
  runtime.controller = new class extends GuiController {
    override async run(options: GuiTaskOptions, callbacks: GuiRunCallbacks = {}): Promise<RunResult> {
      callbacks.onStarted?.();
      if (options.task === "smoke-reload") {
        taskStarted = true;
        signal = callbacks.signal;
        callbacks.onContent?.("Reply before reload");
        try {
          await stopping;
          // An approved operation can finish after the initiating renderer detached.
          callbacks.onLocalActivity?.({ operation: "edit", paths: ["note.txt"], status: "pending" });
          deliverLate = () => {
            callbacks.onFileChange?.(createFileChange("note.txt", "draft", "final", "edit"));
            callbacks.onLocalActivity?.({ operation: "edit", paths: ["note.txt"], status: "success" });
          };
          callbacks.onContent?.(" late reply from the old task");
          signal?.throwIfAborted();
        } finally {
          finished();
        }
      }
      return { content: "Reply after reload", mode: "single", usage: {} };
    }
  }();
  runtime.controller.setSessionApiKey("smoke-only-key");
  const fixture = await window.webContents.executeJavaScript(`(async () => {
    const originalId = currentBot.id;
    state = await bridge.state();
    await selectBot(createBot());
    const source = currentBot;
    document.querySelector('#task-input').value = 'smoke-reload';
    document.querySelector('#task-input').dispatchEvent(new Event('input'));
    await selectBot(createBot());
    const nextId = currentBot.id;
    await selectBot(source);
    document.querySelector('#local-enabled').checked = false;
    document.querySelector('#web-mode').value = 'off';
    syncWorkspaceControls();
    void runTask();
    return { originalId, sourceId: source.id, nextId };
  })()`) as { originalId: string; sourceId: string; nextId: string };
  try {
    const live = await window.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (activeTurn?.answer === 'Reply before reload' && document.querySelector('#new-bot').disabled) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    })()`) as boolean;
    if (!live) throw new Error("The reload fixture did not start a live task.");
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The renderer reload did not finish.")), 5000);
      window.webContents.once("did-finish-load", () => { clearTimeout(timer); resolve(); });
    });
    window.webContents.reload();
    await loaded;
    if (!signal?.aborted) throw new Error("Reload did not cancel the previous task.");
    const waiting = await window.webContents.executeJavaScript("document.body.inert && document.body.dataset.ready !== 'true'") as boolean;
    if (!waiting) throw new Error("The reloaded renderer became interactive before the previous task stopped.");
    release();
    await stopped;
    await verifyRenderer(window);
    await window.webContents.executeJavaScript(`selectBot(bots.find((session) => session.id === '${fixture.nextId}'))`);
    deliverLate();
    const recovered = await window.webContents.executeJavaScript(`(async () => {
      const source = bots.find((session) => session.id === '${fixture.sourceId}');
      const turn = source.turns.at(-1);
      const deadline = Date.now() + 3000;
      while (source.activities.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      const interrupted = turn.status === 'interrupted'
        && turn.answer === 'Reply before reload' && turn.changes.length === 1 && turn.changes[0].path === 'note.txt'
        && turn.committedActivities.length === 2 && source.activities[0].status === 'pending' && source.activities[1].status === 'success';
      const outcome = { id: source.activities[0].id, botId: source.id, turnId: turn.turnId,
        event: { type: 'activity', activity: source.activities[0] } };
      applyCommittedOutcome(outcome);
      applyCommittedOutcome({ ...outcome, id: crypto.randomUUID(), event: { type: 'file-change', change: turn.changes[0] } });
      const saved = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY)).sessions.find((bot) => bot.id === source.id);
      const durable = saved.activities.length === 2 && saved.turns.at(-1).changes.length === 1
        && saved.turns.at(-1).changes[0].id === turn.changes[0].id;
      const isolated = currentBot.id === '${fixture.nextId}' && currentBot.activities.length === 0
        && currentBot.turns.length === 0 && pendingAction === undefined && document.querySelector('#stop-button').hidden;
      document.querySelector('#local-enabled').checked = false;
      document.querySelector('#task-input').value = 'smoke-reload-next';
      await runTask();
      return interrupted && durable && isolated && currentBot.turns.at(-1).status === 'complete'
        && currentBot.turns.at(-1).answer === 'Reply after reload';
    })()`) as boolean;
    if (!recovered) throw new Error("Reload lost task ownership, mixed session history, or blocked the next task.");
  } finally {
    release();
    if (taskStarted) await stopped;
    runtime.controller = originalController;
    await window.webContents.executeJavaScript(`(async () => {
      state = await bridge.state();
      bots = bots.filter((session) => !['${fixture.sourceId}', '${fixture.nextId}'].includes(session.id));
      await selectBot(bots.find((session) => session.id === '${fixture.originalId}'));
    })()`);
  }
}
