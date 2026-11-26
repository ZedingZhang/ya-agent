import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { DesktopRuntime } from "../../dist/typescript/gui/main/runtime";
import { memoryPath } from "../../dist/typescript/memory";

async function verifyMemoryUnavailable(runtime: DesktopRuntime, window: BrowserWindow, root: string, cardId: string): Promise<void> {
  await window.webContents.executeJavaScript(`(() => {
    currentBot.turns.push({ task: 'PostgreSQL 索引', images: [], answer: 'Saved memory-outage answer',
      status: 'complete', commands: [], changes: [] });
    persistSessions();
  })()`);
  const originalPython = process.env.YA_MEMORY_PYTHON;
  try {
    process.env.YA_MEMORY_PYTHON = join(root, "missing-python");
    await window.loadFile(runtime.rendererFile);
    const available = await window.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && document.body.dataset.ready !== 'true' && !document.body.dataset.startupError) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (document.body.dataset.ready !== 'true' || !document.querySelector('#timeline').textContent.includes('Saved memory-outage answer')) {
        return false;
      }
      document.querySelector('#settings-tab').click();
      if (!document.querySelector('#page-settings').classList.contains('active')) return false;

      document.querySelector('#memory-tab').click();
      while (Date.now() < deadline && document.querySelector('#memory-retry').hidden) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return !document.querySelector('#memory-retry').hidden && document.querySelector('#memory-create').disabled
        && document.querySelector('#memory-prune').disabled && document.querySelector('#memory-empty').hidden
        && document.querySelector('#memory-status').textContent.includes('Octop Memory failed');
    })()`);
    if (!available) throw new Error("Unavailable memory blocked startup or did not offer a retry.");
  } finally {
    if (originalPython === undefined) delete process.env.YA_MEMORY_PYTHON;
    else process.env.YA_MEMORY_PYTHON = originalPython;
  }

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(memoryPath());
  try {
    db.exec("BEGIN IMMEDIATE");
    const responsive = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('#memory-retry').click();
      document.querySelector('#settings-tab').click();
      const state = await window.ya.state();
      return Boolean(state.config.model) && document.querySelector('#page-settings').classList.contains('active')
        && document.querySelector('#memory-create').disabled && document.querySelector('#memory-retry').hidden;
    })()`);
    if (!responsive) throw new Error("Settings IPC did not respond while the memory read was pending.");
  } finally {
    db.close();
  }
  const recovered = await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && document.querySelector('#memory-create').disabled) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return document.querySelector('#memory-body').textContent.includes(${JSON.stringify(cardId)})
      && document.querySelector('#memory-status').hidden && document.querySelector('#memory-retry').hidden;
  })()`);
  if (!recovered) throw new Error("Memory retry did not show the saved card.");
}

export async function verifyMemory(runtime: DesktopRuntime, window: BrowserWindow, root: string): Promise<void> {
  const cardId = await window.webContents.executeJavaScript(`(async () =>
    (await window.ya.createMemory('PostgreSQL 索引优化关注查询计划', 'GUI smoke evidence', 'knowledge')).id)()`) as string;
  await verifyMemoryUnavailable(runtime, window, root, cardId);
  const passed = await window.webContents.executeJavaScript(`(async () => {
    const cardId = ${JSON.stringify(cardId)};
    async function waitFor(condition) {
      const deadline = Date.now() + 5000;
      while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      return Boolean(condition());
    }
    if ((await window.ya.relevantCards('PostgreSQL 索引')).length !== 0) return false;
    await window.ya.setMemoryStatus(cardId, 'approved');
    const matches = await window.ya.relevantCards('PostgreSQL 索引');
    if (matches.length !== 1 || matches[0].card.id !== cardId) return false;
    document.querySelector('[data-page="workspace"]').click();
    document.querySelector('#toggle-activity').click();
    const relevant = document.querySelector('#relevant-list');
    if (!await waitFor(() => relevant.querySelector('.memory-chip')?.textContent.includes(matches[0].card.text))) return false;

    document.querySelector('#memory-tab').click();
    const cardRow = () => Array.from(document.querySelectorAll('#memory-body tr')).find(row => row.cells[0].textContent === cardId);
    if (!await waitFor(() => cardRow()?.cells[1].textContent === 'approved')) return false;
    cardRow().querySelector('button').click();
    if (!await waitFor(() => cardRow()?.cells[1].textContent === 'revoked')) return false;
    document.querySelector('#workspace-tab').click();
    if (document.querySelector('#drawer-activity').hidden || !await waitFor(() => relevant.textContent === t('noRelevant'))) {
      throw new Error("Activity still shows the revoked card after returning to Workspace.");
    }
    if ((await window.ya.relevantCards('PostgreSQL 索引')).length !== 0) return false;
    await window.ya.prunePreview(false);
    const removed = await window.ya.pruneMemory(false);
    return removed.length === 1 && removed[0].id === cardId
      && (await window.ya.memoryCards()).length === 0;
  })()`);
  if (!passed) throw new Error("Octop Memory desktop lifecycle verification failed.");
}
