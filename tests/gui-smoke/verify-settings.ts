import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { app, Menu, net, shell, type BrowserWindow } from "electron";
import { ModelConfig } from "../../dist/typescript/config";
import { accountCredentialPath, clearAccountCredential, loadAccountCredential } from "../../dist/typescript/credentials";
import type { Language } from "../../dist/typescript/gui/controller";
import { DesktopRuntime } from "../../dist/typescript/gui/main/runtime";
import { installApplicationMenu } from "../../dist/typescript/gui/menu";
import { verifyRenderer } from "./verify-workspace";

export async function verifyAccountLogin(runtime: DesktopRuntime, window: BrowserWindow): Promise<void> {
  const originalFetch = net.fetch;
  const originalOpen = shell.openExternal;
  let initialization: { redirect_uri: string; state: string } | undefined;
  let approve = true;
  let callback: Promise<Response> | undefined;
  const envelope = (value: unknown): Response => Response.json({ code: 0, data: { biz_code: 0, biz_data: value } });
  net.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://platform.deepseek.com") throw new Error("Unexpected account smoke-test destination.");
    if (url.pathname.endsWith("auth_init")) {
      initialization = JSON.parse(String(init?.body)) as typeof initialization;
      return envelope({ authorize_id: "smoke-attempt", authorize_url: "https://platform.deepseek.com/dsh/authorize", expires_in: 600 });
    }
    if (url.pathname.endsWith("auth_exchange")) return envelope({ token: "smoke-account-token", authorized_url: "https://platform.deepseek.com/dsh/authorized" });
    return envelope({});
  };
  shell.openExternal = async () => {
    if (approve && initialization) {
      callback = fetch(`${initialization.redirect_uri}?state=${initialization.state}&code=smoke-code`, { redirect: "manual" });
    }
  };
  try {
    const credentialFile = accountCredentialPath();
    mkdirSync(dirname(credentialFile), { recursive: true });
    writeFileSync(credentialFile, "{}");
    await window.loadFile(runtime.rendererFile);
    await verifyRenderer(window);
    const cleared = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-page="settings"]').click();
      document.querySelector('[data-settings-tab="providers"]').click();
      const recoverable = state.accountError && !state.accountSignedIn
        && !document.querySelector('#account-login').hidden && !document.querySelector('#account-logout').hidden
        && document.querySelector('#account-logout').textContent === t('accountClear')
        && document.querySelector('#account-state').textContent === t('accountInvalid');
      document.querySelector('#account-logout').click();
      const deadline = Date.now() + 5000;
      while (accountPending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      return recoverable && !state.accountError && !state.accountSignedIn && document.querySelector('#account-logout').hidden;
    })()`) as boolean;
    if (!cleared || loadAccountCredential()) throw new Error("Invalid account credentials blocked desktop startup or cleanup.");
    writeFileSync(credentialFile, "{");
    await window.loadFile(runtime.rendererFile);
    await verifyRenderer(window);
    const signedIn = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-page="settings"]').click();
      document.querySelector('[data-settings-tab="providers"]').click();
      document.querySelector('#image-detail').value = 'low';
      document.querySelector('#account-login').click();
      const deadline = Date.now() + 5000;
      while (accountPending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      return state.accountSignedIn && !state.accountError && document.querySelector('#account-login').hidden
        && document.querySelector('#image-detail-low').disabled && document.querySelector('#image-detail').value === 'low'
        && document.querySelector('#image-detail-low').textContent === t('lowApiKeyOnly')
        && !document.querySelector('#account-logout').hidden && !document.body.textContent.includes('smoke-account-token')
        && !JSON.stringify(localStorage).includes('smoke-account-token');
    })()`) as boolean;
    if (!signedIn || (await callback)?.status !== 302) throw new Error("Desktop account login did not settle safely.");
    const signedOut = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('#account-logout').click();
      const deadline = Date.now() + 5000;
      while (accountPending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      return !state.accountSignedIn && !document.querySelector('#account-login').hidden
        && !document.querySelector('#image-detail-low').disabled && document.querySelector('#image-detail-low').textContent === 'low'
        && document.querySelector('#account-logout').hidden;
    })()`) as boolean;
    if (!signedOut || loadAccountCredential()) throw new Error("Desktop account sign-out did not remove the local grant.");
    approve = false;
    const cancelled = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('#account-login').click();
      const waiting = !document.querySelector('#account-cancel').hidden && document.querySelector('#account-login').hidden;
      document.querySelector('#account-cancel').click();
      const deadline = Date.now() + 5000;
      while (accountPending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      return waiting && !accountPending && !state.accountSignedIn && document.querySelector('#account-cancel').hidden;
    })()`) as boolean;
    if (!cancelled || loadAccountCredential()) throw new Error("Desktop account sign-in cancellation failed.");
    await window.webContents.executeJavaScript(`document.querySelector('[data-page="workspace"]').click(); setStatus(t('ready'));`);
  } finally {
    runtime.activeLoginController?.abort(new Error("Account smoke test finished."));
    await runtime.activeLoginPromise?.catch(() => undefined);
    net.fetch = originalFetch;
    shell.openExternal = originalOpen;
    clearAccountCredential();
  }
}

export async function verifySettingsExperience(runtime: DesktopRuntime, window: BrowserWindow): Promise<void> {
  const originalConfig = new ModelConfig({
    model: runtime.controller.config.model,
    reasoningEffort: runtime.controller.config.reasoningEffort,
    thinkingEnabled: runtime.controller.config.thinkingEnabled,
    toaTokenBudget: runtime.controller.config.toaTokenBudget,
    toaTimeout: runtime.controller.config.toaTimeout,
  });
  const originalLanguage = runtime.controller.language;
  const originalStream = runtime.controller.stream;
  const originalSessionKey = (runtime.controller as unknown as { sessionApiKey?: string }).sessionApiKey;
  const originalSaveMacosApiKey = runtime.controller.saveMacosApiKey.bind(runtime.controller);
  let keychainKeyCaptured = "";
  runtime.controller.saveMacosApiKey = (apiKey: string) => {
    keychainKeyCaptured = apiKey.trim();
    runtime.controller.setSessionApiKey(apiKey);
  };
  try {
    const passed = await window.webContents.executeJavaScript(`(async () => {
      const modProp = state.platform === 'darwin' ? 'metaKey' : 'ctrlKey';
      const initialStream = state.stream;
      const initialThinking = state.config.thinkingEnabled;
      switchPage('memory');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', [modProp]: true, bubbles: true, cancelable: true }));
      if (!document.querySelector('#page-settings').classList.contains('active')
        || !document.body.classList.contains('settings-open')) return 'shortcut-open';
      document.querySelector('#settings-back').click();
      if (!document.querySelector('#page-memory').classList.contains('active')
        || document.body.classList.contains('settings-open')) return 'back-to-memory';

      switchPage('workspace');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', [modProp]: true, bubbles: true, cancelable: true }));
      if (!document.querySelector('#page-settings').classList.contains('active')) return 'shortcut-from-workspace';

      const nav = document.querySelector('.settings-nav-groups');
      document.querySelector('[data-settings-tab="general"]').focus();
      nav.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      if (activeSettingsTab !== 'providers' || document.querySelector('#settings-panel-providers').hidden) return 'arrow-down-tab';
      nav.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      if (activeSettingsTab !== 'general' || document.querySelector('#settings-panel-general').hidden) return 'arrow-up-tab';

      element('setting-language').value = 'zh-CN';
      element('setting-language').dispatchEvent(new Event('change'));
      await settingsSaveQueue;
      if ((await bridge.state()).language !== 'zh-CN' || element('settings-back').textContent.trim() !== '返回应用') return 'autosave-language';

      element('setting-stream').click();
      await settingsSaveQueue;
      if ((await bridge.state()).stream !== !initialStream) return 'autosave-stream';

      element('setting-thinking').click();
      await settingsSaveQueue;
      if ((await bridge.state()).config.thinkingEnabled !== !initialThinking) return 'autosave-thinking';

      element('setting-budget').value = '500';
      element('setting-budget').dispatchEvent(new Event('change'));
      await settingsSaveQueue;
      if (element('setting-budget').getAttribute('aria-invalid') !== 'true'
        || element('setting-budget-error').hidden
        || (await bridge.state()).config.toaTokenBudget === 500) return 'invalid-budget';

      element('setting-stream').click();
      await settingsSaveQueue;
      if ((await bridge.state()).stream !== initialStream || element('setting-budget').getAttribute('aria-invalid') !== 'true') {
        return 'unrelated-save-with-invalid-budget';
      }

      element('setting-budget').value = '6000';
      element('setting-budget').dispatchEvent(new Event('input'));
      element('setting-budget').dispatchEvent(new Event('change'));
      await settingsSaveQueue;
      if (element('setting-budget').getAttribute('aria-invalid') !== 'false'
        || !element('setting-budget-error').hidden
        || (await bridge.state()).config.toaTokenBudget !== 6000) return 'valid-budget';

      element('setting-timeout').value = '999';
      element('setting-timeout').dispatchEvent(new Event('change'));
      await settingsSaveQueue;
      if (element('setting-timeout').getAttribute('aria-invalid') !== 'true' || element('setting-timeout-error').hidden) {
        return 'invalid-timeout';
      }
      element('setting-timeout').value = '120';
      element('setting-timeout').dispatchEvent(new Event('input'));
      element('setting-timeout').dispatchEvent(new Event('change'));
      await settingsSaveQueue;
      if ((await bridge.state()).config.toaTimeout !== 120) return 'valid-timeout';

      selectSettingsTab('providers');
      const keyInput = element('setting-api-key');
      const saveBtn = element('settings-save');
      if (!saveBtn.disabled) return 'save-key-should-start-disabled';
      keyInput.value = 'sk-unsaved-draft';
      keyInput.dispatchEvent(new Event('input'));
      if (saveBtn.disabled) return 'save-key-should-enable';

      element('toggle-api-key-visibility').click();
      if (keyInput.type !== 'text') return 'toggle-key-show';
      element('toggle-api-key-visibility').click();
      if (keyInput.type !== 'password') return 'toggle-key-hide';

      element('setting-thinking').click();
      await settingsSaveQueue;
      if (keyInput.value !== 'sk-unsaved-draft') return 'unrelated-toggle-consumed-api-key';

      saveBtn.click();
      await settingsSaveQueue;
      if (keyInput.value !== '' || !saveBtn.disabled || !(await bridge.state()).hasApiKey) return 'explicit-key-save';

      const search = element('settings-search');
      search.value = '超时';
      search.dispatchEvent(new Event('input'));
      if (element('settings-search-results').hidden || !element('settings-search-results').textContent.includes('ToA')) {
        return 'search-zh';
      }
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      if (activeSettingsTab !== 'general'
        || document.querySelector('[data-setting-id="timeout"]').getAttribute('data-search-target') !== 'row') {
        return 'search-reveal';
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      if (search.value !== '' || !element('settings-search-results').hidden || document.activeElement !== search) {
        return 'escape-clears-search';
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      if (document.activeElement === search || !document.querySelector('#page-settings').classList.contains('active')) {
        return 'escape-blurs-empty-search';
      }

      selectSettingsTab('about');
      const clipboard = navigator.clipboard;
      const writeText = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
      let copied = '';
      try {
        Object.defineProperty(clipboard, 'writeText', { configurable: true, value: async (text) => { copied = text; } });
        element('about-version').focus();
        element('about-version').click();
        await Promise.resolve();
      } finally {
        if (writeText) Object.defineProperty(clipboard, 'writeText', writeText);
        else delete clipboard.writeText;
      }
      if (copied !== 'Ya ' + state.version || !element('about-version').textContent.includes(t('copiedVersion'))) {
        return 'about-copy';
      }

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      if (document.querySelector('#page-settings').classList.contains('active')
        || document.body.classList.contains('settings-open')) return 'escape-closes-settings';
      return 'ok';
    })()`) as string;
    if (passed !== "ok") throw new Error(`Settings experience check failed at: ${passed}.`);
    if (process.platform === "darwin" && keychainKeyCaptured !== "sk-unsaved-draft") {
      throw new Error("macOS Keychain API key save path was not exercised.");
    }
  } finally {
    runtime.controller.saveMacosApiKey = originalSaveMacosApiKey;
    runtime.controller.saveModelConfig(originalConfig);
    runtime.controller.setLanguage(originalLanguage);
    installApplicationMenu(originalLanguage);
    runtime.controller.setStream(originalStream);
    (runtime.controller as unknown as { sessionApiKey?: string }).sessionApiKey = originalSessionKey;
    await window.webContents.executeJavaScript(`(async () => {
      state = await bridge.state();
      selectSettingsTab('general');
      applyLanguage();
      fillSettings();
      switchPage('workspace');
      setStatus(t('ready'));
    })()`);
  }
}

export async function verifyApplicationMenu(runtime: DesktopRuntime, window: BrowserWindow): Promise<void> {
  if (app.getName() !== "Ya") throw new Error(`Unexpected application name: ${app.getName()}`);
  if (process.platform !== "darwin") return;
  if (basename(app.getPath("exe")) !== "Ya") throw new Error("The macOS executable must be named Ya.");

  const originalLanguage = runtime.controller.language;
  const saveLanguage = (language: Language): Promise<unknown> => window.webContents.executeJavaScript(`(async () => {
    const current = await window.ya.state();
    return window.ya.saveSettings({ ...current.config, language: '${language}', stream: current.stream });
  })()`);
  const verifyLabels = (language: Language): void => {
    const menu = Menu.getApplicationMenu();
    const labels = menu?.items.map((item) => item.label).join("|");
    const expected = language === "zh-CN" ? "Ya|文件|编辑|视图|窗口" : "Ya|File|Edit|View|Window";
    const appLabels = menu?.items[0]?.submenu?.items.map((item) => item.label) ?? [];
    const editLabels = menu?.items[2]?.submenu?.items.map((item) => item.label) ?? [];
    const quit = language === "zh-CN" ? "退出 Ya" : "Quit Ya";
    const paste = language === "zh-CN" ? "粘贴" : "Paste";
    if (labels !== expected || !appLabels.includes(quit) || !editLabels.includes(paste)) {
      throw new Error(`Native menu localization failed for ${language}: ${JSON.stringify({ labels, appLabels, editLabels })}`);
    }
  };
  verifyLabels(originalLanguage);
  try {
    for (const language of ["zh-CN", "en"] as const) {
      await saveLanguage(language);
      verifyLabels(language);
    }
  } finally {
    await saveLanguage(originalLanguage);
  }
}
