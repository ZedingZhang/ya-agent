import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginDeepSeek, logoutDeepSeek } from "../src/account";
import { DEEPSEEK_PLATFORM, loadAccountCredential, saveAccountCredential } from "../src/credentials";
import type { FetchLike } from "../src/deepseek";
import { tempHome, type TempHome } from "./helpers";

function envelope(value: unknown): Response {
  return Response.json({ code: 0, data: { biz_code: 0, biz_data: value } });
}

function platform(overrides: { authorizeUrl?: string; expiresIn?: number; exchange?: unknown } = {}) {
  const fetcher = vi.fn<FetchLike>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("auth_init")) return envelope({
      authorize_id: "attempt", authorize_url: overrides.authorizeUrl ?? `${DEEPSEEK_PLATFORM}/dsh/authorize?id=attempt`,
      expires_in: overrides.expiresIn ?? 600,
    });
    if (path.endsWith("auth_exchange")) return envelope(overrides.exchange ?? {
      token: "account-test-token", authorized_url: `${DEEPSEEK_PLATFORM}/dsh/authorized?keep=value`,
    });
    return envelope({});
  });
  const body = (suffix: string): Record<string, any> => {
    const call = fetcher.mock.calls.find(([url]) => String(url).endsWith(suffix));
    return JSON.parse(String(call?.[1]?.body));
  };
  const callbackUrl = (extra = "code=test-code"): string => {
    const init = body("auth_init");
    return `${init.redirect_uri}?state=${init.state}&${extra}`;
  };
  return { fetcher, body, callbackUrl };
}

describe("DeepSeek platform browser authorization", () => {
  let home: TempHome;
  beforeEach(() => { home = tempHome(); });
  afterEach(() => home.cleanup());

  it("exchanges an S256-bound callback, stores the grant, then redirects to the platform completion page", async () => {
    const mock = platform();
    let callback!: Promise<Response>;
    await loginDeepSeek({ fetcher: mock.fetcher, locale: "zh-CN", openBrowser: async (url) => {
      expect(url).toBe(`${DEEPSEEK_PLATFORM}/dsh/authorize?id=attempt`);
      callback = fetch(mock.callbackUrl(), { redirect: "manual" });
    } });
    const response = await callback;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${DEEPSEEK_PLATFORM}/dsh/authorized?keep=value&login_source=desktop`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(loadAccountCredential()).toEqual({ kind: "account", token: "account-test-token" });
    const init = mock.body("auth_init");
    const exchange = mock.body("auth_exchange");
    expect(init.code_challenge_method).toBe("S256");
    expect(init.code_challenge).toBe(createHash("sha256").update(exchange.code_verifier).digest("base64url"));
    expect(init.locale).toBe("zh_CN");
    expect(exchange).toMatchObject({ code: "test-code", redirect_uri: init.redirect_uri });
    expect(exchange.device_id).toMatch(/^[\da-f-]{36}$/u);
    expect(mock.fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", headers: { "x-client-locale": "zh_CN" } });
  });

  it("rejects wrong state and duplicate parameters while allowing the legitimate callback to finish", async () => {
    const mock = platform();
    let callback!: Promise<Response>;
    await loginDeepSeek({ fetcher: mock.fetcher, openBrowser: async () => {
      const init = mock.body("auth_init");
      const wrongState = await fetch(`${init.redirect_uri}?state=wrong&code=wrong`);
      expect(wrongState.status).toBe(400);
      const duplicate = await fetch(`${mock.callbackUrl()}&state=${init.state}`);
      expect(duplicate.status).toBe(400);
      const duplicateCode = await fetch(`${mock.callbackUrl()}&code=second`);
      expect(duplicateCode.status).toBe(400);
      expect(mock.fetcher).toHaveBeenCalledTimes(1);
      callback = fetch(mock.callbackUrl(), { redirect: "manual" });
    } });
    expect((await callback).status).toBe(302);
    expect(mock.fetcher.mock.calls.filter(([url]) => String(url).endsWith("auth_exchange"))).toHaveLength(1);
  });

  it.each([
    "https://attacker.example/dsh/authorize", "https://platform.deepseek.com.attacker.example/dsh/authorize",
    `${DEEPSEEK_PLATFORM}/unexpected`, "http://platform.deepseek.com/dsh/authorize",
    "https://user:password@platform.deepseek.com/dsh/authorize", `${DEEPSEEK_PLATFORM}/dsh/authorize#fragment`,
  ])("does not open an untrusted authorization URL %s", async (authorizeUrl) => {
    const mock = platform({ authorizeUrl });
    const openBrowser = vi.fn();
    await expect(loginDeepSeek({ fetcher: mock.fetcher, openBrowser })).rejects.toThrow("invalid authorization URL");
    expect(openBrowser).not.toHaveBeenCalled();
    expect(loadAccountCredential()).toBeUndefined();
    expect(mock.body("auth_cancel").authorize_id).toBe("attempt");
  });

  it("cancels a pending browser attempt promptly and closes its callback listener", async () => {
    const mock = platform();
    const cancellation = new AbortController();
    const saveCredential = vi.fn();
    await expect(loginDeepSeek({ fetcher: mock.fetcher, signal: cancellation.signal, saveCredential,
      openBrowser: async () => { cancellation.abort(new Error("User cancelled")); },
    })).rejects.toThrow("User cancelled");
    expect(saveCredential).not.toHaveBeenCalled();
    await expect(fetch(mock.callbackUrl())).rejects.toThrow();
    expect(mock.body("auth_cancel")).toMatchObject({ authorize_id: "attempt" });
    expect(mock.body("auth_cancel").code_verifier).toHaveLength(43);
  });

  it("ignores an exchange response arriving after cancellation", async () => {
    const mock = platform();
    const original = mock.fetcher.getMockImplementation()!;
    const cancellation = new AbortController();
    let release!: (response: Response) => void;
    mock.fetcher.mockImplementation((url, init) => {
      if (String(url).endsWith("auth_exchange")) return new Promise((resolve) => { release = resolve; });
      return original(url, init);
    });
    let callback!: Promise<Response>;
    const saveCredential = vi.fn();
    const login = loginDeepSeek({ fetcher: mock.fetcher, signal: cancellation.signal, saveCredential,
      openBrowser: async () => { callback = fetch(mock.callbackUrl(), { redirect: "manual" }); },
    });
    const rejected = expect(login).rejects.toThrow("Cancel exchange");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    cancellation.abort(new Error("Cancel exchange"));
    await rejected;
    release(envelope({ token: "late-token", authorized_url: `${DEEPSEEK_PLATFORM}/dsh/authorized` }));
    await Promise.resolve();
    expect(saveCredential).not.toHaveBeenCalled();
    expect(loadAccountCredential()).toBeUndefined();
    expect((await callback).status).toBe(200);
  });

  it("honors the server expiry while waiting for the browser", async () => {
    const mock = platform({ expiresIn: 0.05 });
    await expect(loginDeepSeek({ fetcher: mock.fetcher, openBrowser: async () => undefined })).rejects.toThrow("expired");
    expect(loadAccountCredential()).toBeUndefined();
  });

  it("does not claim browser success when credential persistence fails", async () => {
    const mock = platform();
    let callback!: Promise<Response>;
    await expect(loginDeepSeek({ fetcher: mock.fetcher,
      openBrowser: async () => { callback = fetch(mock.callbackUrl(), { redirect: "manual" }); },
      saveCredential: () => { throw new Error("Storage unavailable"); },
    })).rejects.toThrow("Storage unavailable");
    const response = await callback;
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("did not complete");
    expect(loadAccountCredential()).toBeUndefined();
  });

  it("handles a browser refusal without exchanging or saving a code", async () => {
    const mock = platform();
    let callback!: Promise<Response>;
    await expect(loginDeepSeek({ fetcher: mock.fetcher,
      openBrowser: async () => { callback = fetch(mock.callbackUrl("error=access_denied")); },
    })).rejects.toThrow("declined");
    expect((await callback).status).toBe(200);
    expect(mock.fetcher.mock.calls.some(([url]) => String(url).endsWith("auth_exchange"))).toBe(false);
  });

  it("does not expose platform response bodies or raw transport errors", async () => {
    const fetcher: FetchLike = async () => Response.json({ token: "private-token", message: "private-body" }, { status: 400 });
    await expect(loginDeepSeek({ fetcher, openBrowser: vi.fn() })).rejects.toThrow("HTTP 400");
    await expect(loginDeepSeek({ fetcher: async () => { throw new Error("private-transport-token"); }, openBrowser: vi.fn() }))
      .rejects.toThrow("Could not reach DeepSeek. Try signing in again.");
  });

  it("removes the local credential before logout, including when remote revocation fails", async () => {
    saveAccountCredential({ kind: "account", token: "logout-token" });
    const fetcher = vi.fn<FetchLike>(async (url, init) => {
      expect(loadAccountCredential()).toBeUndefined();
      expect(String(url)).toBe(`${DEEPSEEK_PLATFORM}/auth-api/v0/users/logout`);
      expect(init).toMatchObject({ redirect: "error", headers: { "x-dsh-auth-token": "logout-token" } });
      throw new Error("offline");
    });
    expect(await logoutDeepSeek(fetcher)).toBe(false);
    expect(loadAccountCredential()).toBeUndefined();
    expect(await logoutDeepSeek(fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
