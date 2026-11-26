import { mkdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dialog, nativeTheme, type BrowserWindow } from "electron";
import { createFileChange } from "../../dist/typescript/file-diff";
import { GuiController, LANGUAGES, type Language } from "../../dist/typescript/gui/controller";
import { DesktopRuntime } from "../../dist/typescript/gui/main/runtime";
import { validBotId } from "../../dist/typescript/gui/main/validators";

export async function verifyRenderer(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 5_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    ready = await window.webContents.executeJavaScript("document.body.dataset.ready === 'true'") as boolean;
    if (!ready) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  if (!ready) throw new Error("Renderer did not become ready within 5 seconds.");

  const pages = await window.webContents.executeJavaScript(`(() => {
    const memoryTab = document.querySelector('[data-page="memory"]');
    const settingsTab = document.querySelector('[data-page="settings"]');
    const workspaceTab = document.querySelector('[data-page="workspace"]');
    memoryTab?.click();
    const memoryActive = document.querySelector('#page-memory')?.classList.contains('active') === true;
    const formCard = document.querySelector('#page-memory .form-card');
    const cardBottom = formCard instanceof HTMLElement ? formCard.getBoundingClientRect().bottom : 0;
    const evidenceInput = document.querySelector('#candidate-evidence');
    const createButton = document.querySelector('#memory-create');
    const evidenceOverflow = evidenceInput instanceof HTMLElement
      ? Math.round(evidenceInput.getBoundingClientRect().bottom - cardBottom) : 0;
    const createOverflow = createButton instanceof HTMLElement
      ? Math.round(createButton.getBoundingClientRect().bottom - cardBottom) : 0;
    const formOverflow = Math.max(evidenceOverflow, createOverflow);
    settingsTab?.click();
    const settingsActive = document.querySelector('#page-settings')?.classList.contains('active') === true;
    document.querySelector('[data-settings-tab="providers"]')?.click();
    const keychainLabel = document.querySelector('#setting-keychain-label');
    const keychainVisible = keychainLabel instanceof HTMLElement && keychainLabel.getClientRects().length > 0;
    const legacySettingsModelControls = document.querySelector('#setting-model, #setting-reasoning') !== null;
    document.querySelector('[data-settings-tab="general"]')?.click();
    workspaceTab?.click();
    const workspaceActive = document.querySelector('#page-workspace')?.classList.contains('active') === true;
    const model = document.querySelector('#task-model');
    const reasoning = document.querySelector('#task-reasoning');
    const visionOption = document.querySelector('#task-model option[value="deepseek-flash"]')?.textContent === 'DeepSeek-V4.1-Flash-1017';
    const imagePicker = document.querySelector('#choose-images') !== null;
    const workspaceControls = model instanceof HTMLSelectElement && !model.disabled && model.value !== ''
      && reasoning instanceof HTMLSelectElement && !reasoning.disabled && reasoning.value !== ''
      && Array.from(reasoning.options, (option) => option.value).join(',') === 'low,high,max';
    const stop = document.querySelector('#stop-button');
    const stopControls = stop instanceof HTMLButtonElement && stop.hidden && typeof window.ya.cancelTask === 'function';
    const sidebar = document.querySelector('.app-sidebar');
    const settingsButton = document.querySelector('#settings-tab');
    const timeline = document.querySelector('#timeline');
    const composer = document.querySelector('.composer');
    const leftNavigation = sidebar instanceof HTMLElement && timeline instanceof HTMLElement
      && sidebar.getBoundingClientRect().right <= timeline.getBoundingClientRect().left;
    const bottomSettings = sidebar instanceof HTMLElement && settingsButton instanceof HTMLElement
      && sidebar.getBoundingClientRect().bottom - settingsButton.getBoundingClientRect().bottom < 32;
    const rightComposer = composer instanceof HTMLElement && timeline instanceof HTMLElement
      && composer.getBoundingClientRect().top + 1 >= timeline.getBoundingClientRect().bottom;
    // A long folder path must stay inside the header instead of widening the page.
    const pathLabel = document.querySelector('#workspace-path');
    const main = document.querySelector('main');
    const probeText = 'C:\\\\' + 'workspace-folder\\\\'.repeat(24) + 'final-folder';
    const restoreText = pathLabel ? pathLabel.textContent : null;
    if (pathLabel) pathLabel.textContent = probeText;
    void document.documentElement.offsetWidth; // Force a reflow so the probe is measured.
    const workspaceOverflow = main instanceof HTMLElement ? Math.round(main.getBoundingClientRect().width - window.innerWidth) : 0;
    if (pathLabel && restoreText !== null) pathLabel.textContent = restoreText;
    return {
      memoryActive, settingsActive, workspaceActive, legacySettingsModelControls, visionOption, imagePicker,
      workspaceControls, stopControls, leftNavigation, bottomSettings, rightComposer, workspaceOverflow, formOverflow, keychainVisible,
    };
  })()`) as {
    memoryActive?: boolean;
    settingsActive?: boolean;
    workspaceActive?: boolean;
    legacySettingsModelControls?: boolean;
    visionOption?: boolean;
    imagePicker?: boolean;
    workspaceControls?: boolean;
    stopControls?: boolean;
    leftNavigation?: boolean;
    bottomSettings?: boolean;
    rightComposer?: boolean;
    workspaceOverflow?: number;
    formOverflow?: number;
    keychainVisible?: boolean;
  };
  if (!pages.memoryActive || !pages.settingsActive || !pages.workspaceActive || pages.legacySettingsModelControls
    || !pages.visionOption || !pages.imagePicker || !pages.workspaceControls || !pages.stopControls) {
    throw new Error("Renderer navigation, vision or command controls failed.");
  }
  if (!pages.leftNavigation || !pages.bottomSettings || !pages.rightComposer) {
    throw new Error(`Desktop layout geometry failed: ${JSON.stringify({ leftNavigation: pages.leftNavigation,
      bottomSettings: pages.bottomSettings, rightComposer: pages.rightComposer })}.`);
  }
  if ((pages.workspaceOverflow ?? 0) > 0) {
    throw new Error(`A long workspace path overflows the window by ${pages.workspaceOverflow}px.`);
  }
  if ((pages.formOverflow ?? 0) > 0) {
    throw new Error(`The memory candidate form overflows its card by ${pages.formOverflow}px.`);
  }
  if ((pages.keychainVisible ?? false) !== (process.platform === "darwin")) {
    throw new Error(`The keychain setting must be visible only on macOS (visible=${pages.keychainVisible} on ${process.platform}).`);
  }

  const commandRendering = await window.webContents.executeJavaScript(`(() => {
    const turn = document.createElement('div');
    const priorAnswer = activeAnswer;
    activeAnswer = document.createElement('div');
    turn.append(activeAnswer);
    document.querySelector('#timeline').append(turn);
    try {
      setRunning(true);
      const stopVisible = !document.querySelector('#stop-button').hidden;
      renderCommand({ type: 'start', id: 'smoke-command', command: 'npm test', cwd: '.' });
      renderCommand({ type: 'output', id: 'smoke-command', stream: 'stdout', text: 'checking...' });
      const liveOutput = turn.querySelector('.command-run pre').textContent === 'checking...';
      const text = '<img src=x onerror=alert(1)> test failure';
      renderCommand({ type: 'finish', id: 'smoke-command', result: {
        status: 'failed', exitCode: 7, durationMs: 1234, stdout: text, stderr: 'expected true',
        stdoutTruncated: true, stderrTruncated: false,
      } });
      const plainOutput = turn.querySelector('.command-run pre').textContent.includes(text)
        && turn.querySelector('.command-run img') === null;
      const finalStatus = turn.querySelector('.command-run summary').textContent.includes('exit 7, 1.2s');
      const stderr = turn.querySelector('.command-stderr').textContent === 'expected true';
      setRunning(false);
      const stopHidden = document.querySelector('#stop-button').hidden;
      return stopVisible && liveOutput && plainOutput && finalStatus && stderr && stopHidden;
    } finally {
      setRunning(false);
      activeAnswer = priorAnswer;
      commandLogs.clear();
      turn.remove();
      document.querySelector('#timeline').scrollTop = 0;
      setStatus(t('ready'));
    }
  })()`) as boolean;
  if (!commandRendering) throw new Error("Command output, exit status or stop controls failed to render.");
}

export async function verifyFileDiffRendering(window: BrowserWindow): Promise<void> {
  const before = Array.from({ length: 40 }, (_, index) => `line ${index + 1}${index === 4 ? ` ${"wide ".repeat(250)}` : ""}\n`).join("");
  const after = before.replace("line 8\n", "<img src=x onerror=alert(1)>\n").replace("line 30\n", "updated 30\n");
  const change = createFileChange("src/example.ts", before, after, "edit");
  const limited = createFileChange("large.txt", undefined, "added\n".repeat(2_100), "write");
  const checks = await window.webContents.executeJavaScript(`(async () => {
    const change = ${JSON.stringify(change)};
    const limited = ${JSON.stringify(limited)};
    const priorTurns = currentBot.turns;
    const language = state.language;
    try {
      currentBot.turns = [{ task: 'Review file changes', images: [], answer: 'Updated two lines.',
        status: 'complete', commands: [], changes: [change] }];
      renderBot();
      setDrawer('changes');
      const card = document.querySelector('#timeline .file-change');
      const expand = card.querySelector('.diff-expand');
      const collapsed = card.querySelectorAll('.diff-row').length === 16 && expand.getAttribute('aria-expanded') === 'false';
      expand.click();
      const expanded = card.querySelectorAll('.diff-row').length === 18
        && card.querySelector('.diff-expand').getAttribute('aria-expanded') === 'true';
      const removed = Array.from(card.querySelectorAll('.deletion')).find((row) => row.querySelector('.diff-code').textContent === 'line 8');
      const added = Array.from(card.querySelectorAll('.addition')).find((row) => row.querySelector('.diff-code').textContent.includes('<img'));
      const lineNumbers = removed.querySelectorAll('.diff-number')[0].textContent === '8'
        && removed.querySelectorAll('.diff-number')[1].textContent === ''
        && added.querySelectorAll('.diff-number')[0].textContent === ''
        && added.querySelectorAll('.diff-number')[1].textContent === '8';
      const context = card.querySelectorAll('.context').length === 12
        && card.querySelectorAll('.addition').length === 2 && card.querySelectorAll('.deletion').length === 2
        && card.querySelector('.change-stats').textContent === '+2−2';
      const safeText = card.querySelector('img, script') === null && added.querySelector('.diff-code').textContent === '<img src=x onerror=alert(1)>';
      const copiedText = fileChangeText(change).includes('--- src/example.ts')
        && fileChangeText(change).includes('-line 8\\n+<img src=x onerror=alert(1)>');
      const clipboard = navigator.clipboard;
      const writeText = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
      let copied = '';
      let copyAction = false;
      try {
        Object.defineProperty(clipboard, 'writeText', { configurable: true, value: async (text) => { copied = text; } });
        card.querySelector('.diff-copy').click();
        await Promise.resolve();
        copyAction = copied === fileChangeText(change) && card.querySelector('.diff-copy').textContent === t('copiedDiff');
        Object.defineProperty(clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('Clipboard unavailable'); } });
        card.querySelector('.diff-copy').click();
        await Promise.resolve();
        copyAction = copyAction && card.querySelector('.diff-copy').textContent === t('copyDiffFailed');
      } finally {
        if (writeText) Object.defineProperty(clipboard, 'writeText', writeText);
        else delete clipboard.writeText;
      }
      const scroll = card.querySelector('.diff-lines');
      const scrollable = scroll.scrollWidth > scroll.clientWidth && document.documentElement.scrollWidth <= innerWidth;
      card.querySelector('.diff-expand').click();
      const recollapsed = card.querySelectorAll('.diff-row').length === 16;
      const drawerCard = document.querySelector('#change-list .file-change');
      drawerCard.querySelector('summary').click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const drawer = !document.querySelector('#drawer-changes').hidden && drawerCard.open
        && drawerCard.querySelector('.diff-body') !== null && !document.querySelector('#changes-count').hidden;
      const truncatedCard = fileChangeCard(limited, true);
      const truncated = truncatedCard.querySelector('.diff-notice').textContent === t('diffTruncated')
        && truncatedCard.querySelector('.diff-additions').textContent === '+2100';
      const compatible = validSavedFileChange(change) && !validSavedFileChange({ ...change, hunks: [{ ...change.hunks[0], lines: [42] }] })
        && !validSavedFileChange({ ...change, additions: -1 });
      state.language = 'zh-CN';
      applyLanguage();
      const localized = document.querySelector('#drawer-changes-tab').textContent === '变更'
        && document.querySelector('#timeline .change-operation').textContent === '编辑'
        && document.querySelector('#change-list .file-change').open;
      return { collapsed, expanded, recollapsed, lineNumbers, context, safeText, copiedText, copyAction, scrollable, drawer, truncated, compatible, localized };
    } finally {
      state.language = language;
      currentBot.turns = priorTurns;
      renderBot();
      applyLanguage();
      setDrawer(undefined);
    }
  })()`) as Record<string, boolean>;
  for (const [name, passed] of Object.entries(checks)) {
    if (!passed) throw new Error(`File diff rendering check failed: ${name}.`);
  }
}

export async function verifyBotNavigation(runtime: DesktopRuntime, window: BrowserWindow, root: string): Promise<void> {
  const first = join(root, "ya-agent");
  mkdirSync(first);
  const originalPicker = dialog.showOpenDialog;
  const originalCards = runtime.controller.cards;
  try {
    runtime.controller.cards = () => { throw new Error("Memory store unavailable during folder selection."); };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [first] });
    const attached = await window.webContents.executeJavaScript(`(async () => {
      const reviewer = createBot({ title: 'Desktop reviewer', instructions: '' });
      await selectBot(reviewer);
      const count = bots.length;
      const input = document.querySelector('#task-input');
      input.value = 'A draft for the first bot';
      input.dispatchEvent(new Event('input'));
      document.querySelector('#toggle-files').click();
      document.querySelector('#drawer-files #choose-workspace').click();
      const deadline = Date.now() + 3000;
      while (navigationPending && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      if (navigationPending || !state.validWorkspace || document.querySelector('#revoke-folder').hidden) return false;
      await updateFolderAccess(true);
      if (state.workspace || !document.querySelector('#revoke-folder').hidden || !document.querySelector('#local-enabled').disabled) return false;
      await updateFolderAccess(false);
      return currentBot === reviewer && bots.length === count && state.validWorkspace
        && state.validWorkspace === (await bridge.selectBot(reviewer.id)).validWorkspace && input.value === reviewer.draft;
    })()`);
    if (!attached) throw new Error("Choosing a local folder lost the bot or its draft.");
  } finally {
    dialog.showOpenDialog = originalPicker;
    runtime.controller.cards = originalCards;
  }
  const historyChange = createFileChange("src/gui/layout.ts", "const width = 860;\n", "const width = 920;\n", "edit");
  const navigation = await window.webContents.executeJavaScript(`(async () => {
    state = await bridge.state();
    const first = state.validWorkspace;
    const firstId = currentBot.id;
    const writer = createBot({ title: 'Writer', instructions: '' });
    writer.workspace = first; // A path in legacy renderer history is not a grant.
    const input = document.querySelector('#task-input');
    await selectBot(writer);
    const draftsIsolated = input.value === '' && !state.validWorkspace && document.querySelector('#local-enabled').disabled;
    await selectBot(bots.find((session) => session.id === firstId));
    const draftRestored = input.value === 'A draft for the first bot';
    const folderRestored = (await bridge.state()).validWorkspace === first;
    const attachmentsAvailable = !document.querySelector('#choose-images').disabled;
    await selectBot(createBot({ title: 'Research', instructions: '' }));
    const newBot = currentBot.id !== firstId && input.value === '' && !(await bridge.state()).validWorkspace;
    const flatList = document.querySelectorAll('#bot-list > .bot-button').length === bots.length;
    const source = bots.find((session) => session.id === firstId);
    source.turns.push({ task: 'Summarize the YA desktop layout', images: [],
      answer: '## Desktop workspace\\nBot navigation stays on the left.\\n\\n- Conversations and the composer fill the right side.\\n- Settings stays at the bottom of the sidebar.',
      status: 'complete', changes: [${JSON.stringify(historyChange)}], commands: [{ id: 'history-command', command: 'npm run check', cwd: first,
        stdout: 'Checks passed', stderr: '', result: { status: 'success', exitCode: 0, durationMs: 500,
          stdout: 'Checks passed', stderr: '', stdoutTruncated: false, stderrTruncated: false } }] });
    delete source.instructions; // Legacy v1 records have no bot profile instructions.
    source.draft = '';
    source.activities = [{ operation: 'read', paths: ['src/gui/index.html'], status: 'success' }];
    await selectBot(source);
    const transcriptRestored = document.querySelector('#timeline').textContent.includes('Bot navigation')
      && document.querySelector('#timeline .command-run').textContent.includes('Checks passed')
      && document.querySelector('#timeline .file-change .addition .diff-code').textContent === 'const width = 920;';
    setRunning(true);
    const locked = document.querySelector('#new-bot').disabled && document.querySelector('#choose-workspace').disabled
      && Array.from(document.querySelectorAll('.bot-button')).every((button) => button.disabled);
    const runningId = currentBot.id;
    await selectBot(writer);
    const runningSessionStable = currentBot.id === runningId;
    setRunning(false);
    pendingAction = { id: 'approval-preview', action: { operation: 'edit', paths: ['README.md'], summary: 'Update desktop documentation', diff: '+ New desktop layout' } };
    renderPendingAction();
    switchPage('workspace');
    setDrawer('activity');
    const approvalVisible = !document.querySelector('#details-drawer').hidden && !document.querySelector('#action-content').hidden
      && document.querySelector('#toggle-activity').classList.contains('has-pending');
    pendingAction = undefined;
    renderPendingAction();
    setDrawer(undefined);
    document.querySelector('#sidebar-toggle').click();
    const collapsed = document.body.classList.contains('sidebar-collapsed')
      && document.querySelector('#settings-tab').getBoundingClientRect().width > 0;
    document.querySelector('#sidebar-toggle').click();
    input.value = 'A draft that survives reload';
    input.dispatchEvent(new Event('input'));
    persistSessions();
    return { draftsIsolated, draftRestored, folderRestored, attachmentsAvailable, newBot, flatList, transcriptRestored,
      locked, runningSessionStable, approvalVisible, collapsed, activeId: currentBot.id };
  })()`) as Record<string, boolean | string>;
  for (const [name, value] of Object.entries(navigation)) {
    if (name !== "activeId" && value !== true) throw new Error(`Desktop navigation check failed: ${name}.`);
  }
  await window.loadFile(runtime.rendererFile);
  await verifyRenderer(window);
  const restored = await window.webContents.executeJavaScript(`(() => ({
    id: currentBot.id, draft: document.querySelector('#task-input').value,
    transcript: currentBot.title === 'Desktop reviewer' && currentBot.instructions === ''
      && document.querySelector('#timeline').textContent.includes('Bot navigation'),
    commands: document.querySelector('#timeline .command-run').textContent.includes('Checks passed'),
    changes: document.querySelector('#timeline .file-change .addition .diff-code')?.textContent === 'const width = 920;'
      && currentBot.turns[0].changes[0].hunks[0].lines.includes('-const width = 860;')
      && document.querySelector('#changes-count').textContent === '1',
  }))()`) as { id: string; draft: string; transcript: boolean; commands: boolean; changes: boolean };
  if (restored.id !== navigation.activeId || restored.draft !== "A draft that survives reload" || !restored.transcript || !restored.commands || !restored.changes) {
    throw new Error("Session transcripts, commands, file changes or drafts did not survive renderer reload.");
  }
  await window.webContents.executeJavaScript("document.querySelector('#task-input').value = ''; currentBot.draft = ''; persistSessions(); setStatus(t('ready'));");
}

export async function verifyResponsiveLayout(runtime: DesktopRuntime, window: BrowserWindow): Promise<void> {
  const originalSize = window.getBounds();
  const originalTheme = nativeTheme.themeSource;
  const originalLanguage = runtime.controller.language;
  for (const language of ["en", "zh-CN"]) {
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      for (const [width, height] of [[920, 680], [1440, 900]] as const) {
        window.setSize(width, height);
        await window.webContents.executeJavaScript(`state.language = '${language}'; applyLanguage(); switchPage('workspace'); setDrawer(undefined);`);
        await new Promise((resolve) => setTimeout(resolve, 60));
        const fits = await window.webContents.executeJavaScript(`(() => {
          const sidebar = document.querySelector('.app-sidebar').getBoundingClientRect();
          const settings = document.querySelector('#settings-tab').getBoundingClientRect();
          const composer = document.querySelector('.composer').getBoundingClientRect();
          const options = document.querySelector('#task-options');
          options.open = true;
          const popup = options.querySelector('.task-controls').getBoundingClientRect();
          options.open = false;
          setDrawer('changes');
          const drawer = document.querySelector('#details-drawer').getBoundingClientRect();
          const tabs = document.querySelector('.drawer-tabs').getBoundingClientRect();
          const close = document.querySelector('#close-drawer').getBoundingClientRect();
          const changesFit = drawer.right <= innerWidth + 1 && drawer.left >= sidebar.right
            && tabs.right <= close.left && document.documentElement.scrollWidth <= innerWidth;
          setDrawer(undefined);
          return changesFit && document.documentElement.scrollWidth <= innerWidth && composer.right <= innerWidth
            && composer.left >= sidebar.right && composer.bottom <= innerHeight
            && sidebar.bottom - settings.bottom < 32 && popup.left >= sidebar.right
            && popup.right <= innerWidth && popup.top >= 0;
        })()`) as boolean;
        if (!fits) throw new Error(`Desktop layout overflows at ${width}x${height}, ${language}, ${theme}.`);
        const settingsFit = await window.webContents.executeJavaScript(`(() => {
          switchPage('settings');
          const shell = document.querySelector('.settings-shell');
          const sidebar = document.querySelector('.settings-sidebar');
          const content = document.querySelector('.settings-content');
          const hiddenShellChrome = document.body.classList.contains('settings-open')
            && document.querySelector('.app-sidebar').getClientRects().length === 0;
          let allTabsFit = hiddenShellChrome && document.documentElement.scrollWidth <= innerWidth;
          if (innerWidth >= 800 && sidebar && content) {
            const sRect = sidebar.getBoundingClientRect();
            const cRect = content.getBoundingClientRect();
            allTabsFit = allTabsFit && sRect.right <= cRect.left + 1;
          }
          const period = element('storage-period');
          const priorPeriod = period.value;
          for (const tab of ['general', 'providers', 'storage', 'shortcuts', 'about']) {
            selectSettingsTab(tab);
            const panel = document.querySelector('[data-settings-panel="' + tab + '"]');
            if (!panel || panel.hidden) { allTabsFit = false; break; }
            if (tab === 'storage') {
              period.value = 'custom';
              renderStorage();
            }
            const lists = Array.from(panel.querySelectorAll('[data-component="settings-list"]'));
            for (const list of lists) {
              const listRect = list.getBoundingClientRect();
              const controls = Array.from(list.querySelectorAll('input, select, button, [data-component="switch"]'))
                .filter((field) => !field.hidden && field.getClientRects().length > 0);
              for (const field of controls) {
                const rect = field.getBoundingClientRect();
                if (rect.right > listRect.right + 1 || rect.left < listRect.left - 1 || rect.bottom > listRect.bottom + 1) {
                  allTabsFit = false;
                }
              }
            }
            if (document.documentElement.scrollWidth > innerWidth || shell.scrollWidth > shell.clientWidth + 1) {
              allTabsFit = false;
            }
            if (tab === 'storage') {
              period.value = priorPeriod;
              renderStorage();
            }
          }
          selectSettingsTab('general');
          document.querySelector('#settings-back').click();
          const returnedToWorkspace = !document.body.classList.contains('settings-open')
            && document.querySelector('#page-workspace').classList.contains('active')
            && document.querySelector('.app-sidebar').getClientRects().length > 0;
          return allTabsFit && returnedToWorkspace;
        })()`) as boolean;
        if (!settingsFit) throw new Error(`Settings fields are clipped at ${width}x${height}, ${language}, ${theme}.`);
      }
    }
  }
  nativeTheme.themeSource = originalTheme;
  window.setSize(originalSize.width, originalSize.height);
  await window.webContents.executeJavaScript(`state.language = '${originalLanguage}'; applyLanguage(); fillSettings();`);
}

export async function verifyUnavailableHistory(runtime: DesktopRuntime, window: BrowserWindow, root: string): Promise<void> {
  const directory = join(root, "archived-folder");
  mkdirSync(directory);
  const fixture = await window.webContents.executeJavaScript(`(async () => {
    const originalId = currentBot.id;
    state = await bridge.state();
    const archived = createBot({ title: 'Archived history', instructions: '' });
    await selectBot(archived);
    currentBot.turns.push({ task: 'Saved task', images: [], answer: 'Saved answer', status: 'complete', commands: [] });
    renderBot();
    document.querySelector('#task-input').value = 'Saved draft';
    document.querySelector('#task-input').dispatchEvent(new Event('input'));
    persistSessions();
    return { originalId, archivedId: currentBot.id };
  })()`) as { originalId: string; archivedId: string };
  const originalController = runtime.controller;
  const originalPicker = dialog.showOpenDialog;
  let chatCalls = 0;
  runtime.controller = new GuiController(async (_key, _task, _config, options) => {
    if (options?.localWorkspace || options?.images?.length !== 1) throw new Error("Expected ordinary chat with the attached image.");
    chatCalls++;
    return { content: "Ordinary chat reply", mode: "single", usage: {} };
  });
  runtime.controller.activeBotId = fixture.archivedId;
  runtime.controller.setSessionApiKey("smoke-only-key");
  const replacement = join(root, "replacement-folder");
  const note = join(replacement, "new-root.txt");
  const picture = join(root, "fixture.png");
  writeFileSync(picture, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64"));
  try {
    mkdirSync(join(directory, "nested"));
    mkdirSync(replacement);
    writeFileSync(note, "new root");
    await runtime.controller.grantFolder(fixture.archivedId, directory);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picture] });
    await window.webContents.executeJavaScript(`(async () => {
      await selectBot(currentBot);
      currentDirectory = 'nested';
      await renderFiles();
      await chooseImages();
    })()`);
    const grant = await runtime.controller.grantFolder(fixture.archivedId, replacement);
    const held = await window.webContents.executeJavaScript(`(async () => {
      const before = currentBot.turns.length;
      // A background state refresh can see the new grant before the folder label does.
      state = await bridge.state();
      await runTask();
      if (currentDirectory !== '.') return false;
      // Opening Files enumerates the newly selected folder independently of the composer.
      await renderFiles();
      return currentBot.turns.length === before && currentBot.draft === 'Saved draft'
        && document.querySelector('#task-input').value === 'Saved draft' && selectedImages.length === 1
        && state.validWorkspace === ${JSON.stringify(grant.validWorkspace)} && currentDirectory === '.'
        && document.querySelector('#file-list').textContent.includes('new-root.txt');
    })()`);
    if (!held) throw new Error("A changed grant used the wrong folder, consumed the draft, or stranded the file browser.");
    rmSync(note);
    rmdirSync(replacement);
    const refreshed = await window.webContents.executeJavaScript(`(async () => {
      const local = document.querySelector('#local-enabled');
      if (!local.checked) return false;
      const before = currentBot.turns.length;
      const confirm = window.confirm;
      let asked = false;
      try {
        window.confirm = (message) => { asked = message === t('chatWithoutFolder'); return asked; };
        await runTask();
      } finally { window.confirm = confirm; }
      if (!asked || currentBot.turns.length !== before + 1 || currentBot.turns.at(-1)?.answer !== 'Ordinary chat reply') return false;
      if (state.validWorkspace || !document.querySelector('#file-list').textContent.includes(t('folderMissing'))) return false;
      await saveWorkspaceModelSelection();
      if (!local.disabled || local.checked || document.querySelector('#send-button').disabled) return false;
      const input = document.querySelector('#task-input');
      input.value = 'Saved draft';
      input.dispatchEvent(new Event('input'));
      return true;
    })()`);
    if (!refreshed || chatCalls !== 1) throw new Error("An offline directory blocked the ordinary chat or consumed the attachment.");
    await window.loadFile(runtime.rendererFile);
    await verifyRenderer(window);
    const startup = await window.webContents.executeJavaScript(`currentBot.id === '${fixture.archivedId}'
      && document.querySelector('#timeline').textContent.includes('Saved answer')
      && document.querySelector('#task-input').value === 'Saved draft'`) as boolean;
    if (!startup) throw new Error("Unavailable-folder history did not restore at startup.");
    const restored = await window.webContents.executeJavaScript(`(async () => {
      const archived = bots.find((session) => session.id === '${fixture.archivedId}');
      await selectBot(bots.find((session) => session.id === '${fixture.originalId}'));
      await selectBot(archived);
      const main = await bridge.state();
      return currentBot.id === archived.id && document.querySelector('#timeline').textContent.includes('Saved answer')
        && document.querySelector('#task-input').value === 'Saved draft'
        && main.validWorkspace === undefined
        && !document.querySelector('#local-enabled').checked && document.querySelector('#local-enabled').disabled
        && document.querySelectorAll('#file-list .file-row').length === 0;
    })()`) as boolean;
    if (!restored) throw new Error("Unavailable-folder history cannot open independently of the previous bot's files.");
    await window.loadFile(runtime.rendererFile);
    await verifyRenderer(window);
    const reopened = await window.webContents.executeJavaScript(`currentBot.id === '${fixture.archivedId}'
      && currentBot.draft === 'Saved draft' && !state.validWorkspace`) as boolean;
    if (!reopened) throw new Error("Unavailable-folder selection or draft was lost after reload.");
  } finally {
    dialog.showOpenDialog = originalPicker;
    runtime.controller.revokeFolder(fixture.archivedId);
    runtime.controller = originalController;
    await window.webContents.executeJavaScript(`(async () => {
      state = await bridge.state();
      bots = bots.filter((session) => session.id !== '${fixture.archivedId}');
      await selectBot(bots.find((session) => session.id === '${fixture.originalId}'));
    })()`);
  }
}

export async function verifyPendingFolderChat(runtime: DesktopRuntime, window: BrowserWindow, root: string): Promise<void> {
  const original = runtime.controller;
  runtime.controller = new GuiController(async (_key, _task, _config, options) => {
    if (options?.localWorkspace) throw new Error("Expected an ordinary chat.");
    return { content: "Reply while folder is pending", mode: "single", usage: {} };
  });
  runtime.controller.setSessionApiKey("smoke-only-key");
  const { originalId, slowId } = await window.webContents.executeJavaScript(`(async () => {
    const originalId = currentBot.id;
    await selectBot(createBot({ title: 'Slow folder', instructions: '' }));
    return { originalId, slowId: currentBot.id };
  })()`) as { originalId: string; slowId: string };
  const requests = new Map<string, AbortSignal>();
  const waitForCancellation = (kind: string, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
    if (!signal) throw new Error("Missing folder browser cancellation.");
    requests.set(kind, signal);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  try {
    await runtime.controller.grantFolder(slowId, root);
    runtime.controller.folderAccess = (signal) => waitForCancellation("probe", signal);
    runtime.controller.workspaceEntries = (_id, _path, _version, signal) => waitForCancellation("listing", signal);
    await window.loadFile(runtime.rendererFile);
    const replied = await window.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 5000;
      while (document.body.dataset.ready !== 'true' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      if (document.body.inert || document.querySelector('#send-button').disabled) return false;
      document.querySelector('#local-enabled').checked = false;
      document.querySelector('#task-input').value = 'Chat with the folder disconnected';
      await runTask();
      return currentBot.turns.at(-1)?.answer === 'Reply while folder is pending';
    })()`);
    const probe = requests.get("probe");
    if (!replied || !probe || probe.aborted || requests.has("listing")) throw new Error("Startup or ordinary chat waited for folder I/O.");
    await window.webContents.executeJavaScript("setDrawer('files'); bridge.state()");
    const listing = requests.get("listing");
    if (!listing || listing.aborted || !probe.aborted) throw new Error("Opening Files did not start an independent listing.");
    const switched = await window.webContents.executeJavaScript(`(async () => {
      await selectBot(bots.find((bot) => bot.id === ${JSON.stringify(originalId)}));
      return currentBot.id === ${JSON.stringify(originalId)} && !navigationPending && !document.querySelector('#send-button').disabled;
    })()`);
    if (!switched || !listing.aborted) throw new Error("A pending listing blocked bot navigation.");
  } finally {
    runtime.folderBrowserRequest?.abort();
    runtime.controller.activeBotId = slowId;
    runtime.controller.revokeFolder(slowId);
    runtime.controller = original;
    await window.webContents.executeJavaScript(`(async () => {
      await selectBot(bots.find((bot) => bot.id === ${JSON.stringify(originalId)}));
      bots = bots.filter((bot) => bot.id !== ${JSON.stringify(slowId)});
      persistSessions();
    })()`);
  }
}

export async function verifyBotIdRecovery(runtime: DesktopRuntime, window: BrowserWindow, root: string): Promise<void> {
  const originalId = await window.webContents.executeJavaScript(`(() => {
    const original = currentBot.id;
    currentBot = createBot({ title: 'Recovered bot', instructions: 'Keep the draft' });
    currentBot.id = '';
    document.querySelector('#task-input').value = 'Draft to recover';
    return original;
  })()`) as string;
  await window.loadFile(runtime.rendererFile);
  await verifyRenderer(window);
  const repaired = await window.webContents.executeJavaScript(`currentBot.title === 'Recovered bot'
    && currentBot.instructions === 'Keep the draft' && currentBot.draft === 'Draft to recover'
    && !state.workspace && currentBot.id`) as string;
  if (!validBotId(repaired)) throw new Error("The active bot's invalid ID prevented history recovery.");
  await window.loadFile(runtime.rendererFile);
  await verifyRenderer(window);
  if (await window.webContents.executeJavaScript("currentBot.id") !== repaired) throw new Error("The repaired ID was not saved.");
  await runtime.controller.grantFolder(repaired, root);
  const damagedId = await window.webContents.executeJavaScript(`(async () => {
    const copy = createBot({ title: 'Second recovered bot', instructions: '' });
    copy.id = currentBot.id;
    copy.draft = 'Second draft';
    const owner = createBot({ title: 'Damaged owner', instructions: '' });
    await selectBot(owner);
    const survivor = createBot({ title: 'Surviving bot', instructions: '' });
    survivor.id = owner.id;
    survivor.draft = 'Surviving draft';
    delete owner.turns;
    persistSessions();
    return owner.id;
  })()`) as string;
  await runtime.controller.grantFolder(damagedId, root);
  await window.loadFile(runtime.rendererFile);
  await verifyRenderer(window);
  const recovered = await window.webContents.executeJavaScript(`(async () => {
    if (currentBot.title !== 'Surviving bot' || bots.some((bot) => bot.title === 'Damaged owner')) return false;
    for (const [title, draft] of [['Recovered bot', 'Draft to recover'], ['Second recovered bot', 'Second draft'], ['Surviving bot', 'Surviving draft']]) {
      const bot = bots.find((entry) => entry.title === title);
      if (!bot || [${JSON.stringify(repaired)}, ${JSON.stringify(damagedId)}].includes(bot.id)) return false;
      await selectBot(bot);
      if (state.workspace || document.querySelector('#task-input').value !== draft) return false;
    }
    const original = bots.find((bot) => bot.id === ${JSON.stringify(originalId)});
    await selectBot(original);
    bots = bots.filter((bot) => !['Recovered bot', 'Second recovered bot', 'Surviving bot'].includes(bot.title));
    persistSessions();
    return currentBot === original;
  })()`);
  if (!recovered) throw new Error("Restoring duplicate IDs lost a draft or assigned the old folder grant.");
}

/** YA_SMOKE_CAPTURE=<file> writes a PNG; YA_SMOKE_CAPTURE_PAGE=changes also opens the diff drawer. */
export async function captureGuiPage(window: BrowserWindow, target: string): Promise<void> {
  const page = process.env.YA_SMOKE_CAPTURE_PAGE ?? "memory";
  if (!["workspace", "changes", "files", "memory", "settings"].includes(page)) {
    throw new Error("YA_SMOKE_CAPTURE_PAGE must be workspace, changes, files, memory, or settings.");
  }
  const language = process.env.YA_SMOKE_LANGUAGE;
  if (language && LANGUAGES.includes(language as Language)) {
    await window.webContents.executeJavaScript(`state.language = '${language}'; applyLanguage(); fillSettings(); renderBot();`);
  }
  const theme = process.env.YA_SMOKE_THEME;
  if (theme === "light" || theme === "dark") nativeTheme.themeSource = theme;
  const size = process.env.YA_SMOKE_SIZE?.match(/^(\d+)x(\d+)$/u);
  if (size) window.setSize(Number(size[1]), Number(size[2]));
  const settingsTab = process.env.YA_SMOKE_SETTINGS_TAB ?? "general";
  await window.webContents.executeJavaScript(`${page === "settings" ? `selectSettingsTab('${settingsTab}');` : ""}
    switchPage('${page === "changes" || page === "files" ? "workspace" : page}');
    ${page === "files" ? "setDrawer('files');" : ""}
    ${page === "changes" ? "setDrawer('changes'); document.querySelector('#change-list .file-change')?.setAttribute('open', '');" : ""}`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  writeFileSync(target, (await window.webContents.capturePage()).toPNG());
}
