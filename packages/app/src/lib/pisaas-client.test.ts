import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { connectionSchema, normalizeServer, request, snapshotSchema } from "./pisaas-client";

const token = "a".repeat(43);
const connection = { baseUrl: "https://pi.example.com", token };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PiSaas server URLs", () => {
  it.each(["", "pi.example.com", "https://", "http://[bad]"])(
    "explains malformed server %s",
    (input) => {
      expect(() => normalizeServer(input)).toThrow(
        "请输入 PiSaas 服务地址，例如 https://pi.example.com",
      );
    },
  );
  it.each([
    [" https://pi.example.com/ ", "https://pi.example.com"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://10.0.2.2:3000/", "http://10.0.2.2:3000"],
    ["http://192.168.1.20", "http://192.168.1.20"],
    ["http://172.16.0.1", "http://172.16.0.1"],
    ["http://[::1]:3000", "http://[::1]:3000"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeServer(input)).toBe(expected);
  });

  it.each([
    "http://pi.example.com",
    "http://172.15.0.1",
    "http://172.32.0.1",
    "https://name:password@pi.example.com",
    "https://pi.example.com/api",
    "https://pi.example.com?token=secret",
    "https://pi.example.com#secret",
    "ftp://pi.example.com",
  ])("rejects unsafe or ambiguous server %s", (input) => {
    expect(() => normalizeServer(input)).toThrow();
  });
});

describe("PiSaas request boundary", () => {
  it("sends the native bearer headers without cookies and refuses redirects", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await request(connection, "/api/v1/auth/session", z.object({ ok: z.boolean() })),
    ).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://pi.example.com/api/v1/auth/session",
      expect.objectContaining({
        credentials: "omit",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Origin: connection.baseUrl,
          "X-PiSaas-Client": "mobile",
          Authorization: `Bearer ${token}`,
        },
      }),
    );
  });

  it("omits authorization during login and validates successful payloads", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: "invalid" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      request({ baseUrl: connection.baseUrl }, "/api/v1/auth/login", z.object({ ok: z.boolean() })),
    ).rejects.toThrow("服务端响应格式不兼容，请检查版本");
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.has("Authorization")).toBe(false);
  });

  it.each([
    [401, { error: "private details" }, "登录已过期"],
    [409, { error: "会话正在执行" }, "会话正在执行"],
    [400, { error: { message: "字段无效" } }, "字段无效"],
    [500, {}, "请求失败 (500)"],
  ])("surfaces the %s response without retry", async (status, payload, expected) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload, { status }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(request(connection, "/api/v1/test", z.unknown())).rejects.toThrow(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ error: { code: "INVALID_CREDENTIALS", message: "账号或密码不正确" } }, "账号或密码不正确"],
    [{ error: "账号已停用" }, "账号已停用"],
    [{}, "登录失败，请检查账号和密码"],
  ])("explains a login rejection without an existing session", async (payload, expected) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(payload, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      request({ baseUrl: connection.baseUrl }, "/api/v1/auth/login", z.unknown(), {
        method: "POST",
        body: JSON.stringify({ email: "user@example.test", password: "incorrect" }),
      }),
    ).rejects.toThrow(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates cancellation and releases its timeout", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(abortableFetch);
    vi.stubGlobal("fetch", fetchMock);
    const pending = request(connection, "/api/v1/test", z.unknown(), { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    await rejected;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards a signal already cancelled before sending", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("Cancelled", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      request(connection, "/api/v1/test", z.unknown(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("cancels requests after twenty seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", abortableFetch);
    const rejected = expect(request(connection, "/api/v1/test", z.unknown())).rejects.toThrow(
      "请求超时，请检查网络后重试",
    );

    await vi.advanceTimersByTimeAsync(20000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    new TypeError("Network request failed"),
    new Error("fetch failed java.net.ConnectException /192.168.1.10:8000"),
    new Error("fetch failed", { cause: new Error("ECONNREFUSED 192.168.1.10:8000") }),
    { message: "java.net.ConnectException /192.168.1.10:8000" },
  ])("hides native network exception details", async (failure) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(failure));

    await expect(request(connection, "/api/v1/test", z.unknown())).rejects.toThrow(
      "无法连接服务，请检查网络和服务地址",
    );
  });

  it("explains invalid JSON without exposing the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>internal proxy error</html>")),
    );

    await expect(request(connection, "/api/v1/test", z.unknown())).rejects.toThrow(
      "服务端响应格式不兼容，请检查版本",
    );
  });

  it("keeps external cancellation distinct when native fetch rejects with TypeError", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("cancelled native request")),
    );

    await expect(
      request(connection, "/api/v1/test", z.unknown(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError", message: "请求已取消" });
  });
});

function abortableFetch(_url: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener(
      "abort",
      () => reject(new DOMException("Cancelled", "AbortError")),
      { once: true },
    );
  });
}

describe("PiSaas payload validation", () => {
  it("rejects malformed credentials and conversation phases", () => {
    expect(
      connectionSchema.safeParse({
        ...connection,
        token: "invalid",
        user: { email: "test@example.com" },
      }).success,
    ).toBe(false);
    expect(snapshotSchema.safeParse({ sessionPhase: "unknown", rows: [] }).success).toBe(false);
    expect(
      snapshotSchema.safeParse({
        sessionPhase: "idle",
        rows: [{ rowId: "1", kind: "assistantText" }],
      }).success,
    ).toBe(false);
  });
});
