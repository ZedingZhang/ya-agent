import { errorText } from "./dom";
import { installSmokeBridge } from "./smoke-bridge";
import { createRendererStore } from "./state";
import { createWorkspaceActions, initializeRenderer } from "./workspace";

const store = createRendererStore();
const actions = createWorkspaceActions(store);

if (typeof window !== "undefined" && (window as { __yaSmokeEnabled?: boolean }).__yaSmokeEnabled === true) {
  installSmokeBridge(store, actions);
}

if (typeof document !== "undefined") {
  void initializeRenderer(store, actions).catch((error: unknown) => {
    document.body.inert = false;
    document.body.dataset.startupError = "true";
    document.body.textContent = `Ya failed to start: ${errorText(error)}`;
  });
}
