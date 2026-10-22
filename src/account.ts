import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { arch, release } from "node:os";
import { finished } from "node:stream/promises";
import { abortable } from "./cancellation";
import { clearAccountCredential, DEEPSEEK_PLATFORM, loadAccountCredential, saveAccountCredential,
  type AccountCredential } from "./credentials";
import type { FetchLike } from "./deepseek";
import { VERSION } from "./version";

export interface AccountLoginOptions {
  openBrowser: (url: string) => Promise<void>;
  signal?: AbortSignal;
  locale?: string;
  fetcher?: FetchLike;
  timeoutMs?: number;
  saveCredential?: (credential: AccountCredential) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clientHeaders(locale = "en"): Record<string, string> {
  return {
    "x-client-bundle-id": "",
    "x-client-platform": process.platform === "win32" ? "desktop-win" : process.platform === "darwin" ? "desktop-mac" : "web",
    "x-client-version": VERSION,
    "x-client-locale": locale.toLowerCase().startsWith("zh") ? "zh_CN" : "en_US",
    "x-client-timezone-offset": String(-new Date().getTimezoneOffset() * 60),
  };
}

/** Only the official platform may receive grants or supply browser destinations. */
function browserUrl(value: unknown, path: string): string {
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      if (url.origin === DEEPSEEK_PLATFORM && url.pathname === path && !url.username && !url.password && !url.hash) return url.href;
    } catch { /* Report a fixed message without exposing response contents. */ }
  }
  throw new Error("DeepSeek returned an invalid authorization URL.");
}

async function platformRequest(path: string, body: unknown, fetcher: FetchLike, signal: AbortSignal,
  headers: Record<string, string>): Promise<unknown> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let response: Response;
  try {
    response = await abortable(fetcher(`${DEEPSEEK_PLATFORM}${path}`, {
      method: "POST", redirect: "error", signal: requestSignal,
      headers: { ...headers, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), requestSignal);
  } catch {
    signal.throwIfAborted();
    throw new Error("Could not reach DeepSeek. Try signing in again.");
  }
  if (!response.ok || !response.body) {
    void response.body?.cancel();
    throw new Error(`DeepSeek account request failed (HTTP ${response.status}).`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), requestSignal);
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) throw new Error("Response too large.");
      chunks.push(value);
    }
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.data) || payload.data.biz_code !== 0) {
      throw new Error("Invalid envelope.");
    }
    return payload.data.biz_data;
  } catch {
    signal.throwIfAborted();
    throw new Error("DeepSeek account authorization failed. Try signing in again.");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Browser authorization follows the official Harness PKCE protocol; passwords never enter Ya. */
export async function loginDeepSeek(options: AccountLoginOptions): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const timeout = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  const expired = (): void => timeout.abort(new Error("DeepSeek sign-in expired. Try again."));
  const timeoutMs = options.timeoutMs ?? 600_000;
  let timer = setTimeout(expired, timeoutMs);
  let expiresAt = Date.now() + timeoutMs;
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const headers = clientHeaders(options.locale);
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  void code.catch(() => undefined);
  const onAbort = (): void => rejectCode(new Error("DeepSeek sign-in cancelled."));
  signal.addEventListener("abort", onAbort, { once: true });
  let callback: ServerResponse | undefined;
  let waiting = false;
  let authorizeId: string | undefined;
  let committed = false;
  let callbackHost = "";
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    let url: URL;
    try { url = new URL(request.url ?? "/", `http://${callbackHost}`); }
    catch { response.writeHead(400).end("Invalid authorization callback."); return; }
    const receivedState = url.searchParams.get("state") ?? "";
    if (request.headers.host !== callbackHost || url.origin !== `http://${callbackHost}`
      || request.method !== "GET" || url.pathname !== "/oauth/callback" || url.searchParams.getAll("state").length !== 1
      || Buffer.byteLength(receivedState) !== Buffer.byteLength(state)
      || !timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))) {
      response.writeHead(400).end("Invalid authorization callback.");
      return;
    }
    if (!waiting || callback || signal.aborted) {
      response.writeHead(410).end("This sign-in attempt is no longer available.");
      return;
    }
    if (url.searchParams.has("error")) {
      callback = response;
      rejectCode(new Error("DeepSeek authorization was declined. Try signing in again."));
    } else if (url.searchParams.getAll("code").length === 1 && url.searchParams.get("code")) {
      callback = response;
      resolveCode(url.searchParams.get("code")!);
    } else {
      response.writeHead(400).end("Missing authorization code.");
    }
  });
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start the local sign-in callback.");
    callbackHost = `127.0.0.1:${address.port}`;
    const redirectUri = `http://${callbackHost}/oauth/callback`;
    const init = await platformRequest("/auth-api/v0/dsh/auth_init", {
      code_challenge: challenge, code_challenge_method: "S256", state, redirect_uri: redirectUri,
      locale: headers["x-client-locale"], login_source: "desktop",
    }, fetcher, signal, headers);
    if (!isRecord(init) || typeof init.authorize_id !== "string" || !init.authorize_id
      || typeof init.expires_in !== "number" || !Number.isFinite(init.expires_in) || init.expires_in <= 0) {
      throw new Error("DeepSeek returned an invalid authorization response.");
    }
    authorizeId = init.authorize_id;
    const authorizeUrl = browserUrl(init.authorize_url, "/dsh/authorize");
    clearTimeout(timer);
    expiresAt = Math.min(expiresAt, Date.now() + init.expires_in * 1_000);
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) expired();
    else timer = setTimeout(expired, remaining);
    signal.throwIfAborted();
    waiting = true;
    await abortable(options.openBrowser(authorizeUrl), signal);
    const receivedCode = await abortable(code, signal);
    const result = await platformRequest("/auth-api/v0/dsh/auth_exchange", {
      code: receivedCode, code_verifier: verifier, redirect_uri: redirectUri,
      device_id: randomUUID(), device_model: `${process.platform}-${arch()}`, os_version: `${process.platform} ${release()}`,
    }, fetcher, signal, headers);
    if (!isRecord(result) || typeof result.token !== "string" || !/^[\x21-\x7e]+$/u.test(result.token)) {
      throw new Error("DeepSeek returned an invalid account credential.");
    }
    const completion = new URL(browserUrl(result.authorized_url, "/dsh/authorized"));
    completion.searchParams.set("login_source", "desktop");
    if (Date.now() >= expiresAt) expired();
    signal.throwIfAborted();
    (options.saveCredential ?? saveAccountCredential)({ kind: "account", token: result.token });
    committed = true;
    callback?.writeHead(302, { Location: completion.href }).end();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    if (!committed) {
      callback?.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
        .end("DeepSeek sign-in did not complete. Close this tab and try again in Ya.");
      if (authorizeId) {
        // Best effort revocation never delays local cancellation or saves a late result.
        void platformRequest("/auth-api/v0/dsh/auth_cancel", { authorize_id: authorizeId, code_verifier: verifier },
          fetcher, AbortSignal.timeout(5_000), headers).catch(() => undefined);
      }
    }
    if (callback) await finished(callback, { cleanup: true }).catch(() => undefined);
    server.close();
    server.closeAllConnections();
  }
}

/** Local removal succeeds before attempting remote revocation. API keys remain separately stored. */
export async function logoutDeepSeek(fetcher: FetchLike = fetch, locale?: string): Promise<boolean> {
  let token: string | undefined;
  try { token = loadAccountCredential()?.token; }
  catch { /* A corrupt local record must still be removable through sign-out. */ }
  clearAccountCredential();
  if (!token) return true;
  try {
    await platformRequest("/auth-api/v0/users/logout", undefined, fetcher, AbortSignal.timeout(5_000),
      { ...clientHeaders(locale), "x-dsh-auth-token": token });
    return true;
  } catch {
    return false;
  }
}
