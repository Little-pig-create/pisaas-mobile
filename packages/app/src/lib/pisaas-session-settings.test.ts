import { afterEach, describe, expect, it, vi } from "vitest";
import {
  changeSessionSetting,
  modelValue,
  readSessionSettings,
  sessionSettingsSchema,
  sessionSettingsSelection,
  thinkingLabel,
  type SessionSettingsSnapshot,
} from "./pisaas-session-settings";

const connection = {
  baseUrl: "https://pi.example.com",
  token: "a".repeat(43),
  user: { email: "user@example.com" },
};

const snapshot: SessionSettingsSnapshot = {
  catalog: {
    models: [
      {
        provider: "configured",
        id: "current",
        name: "当前模型",
        thinking: true,
        thinkingLevels: ["off", "low", "high"],
      },
      {
        provider: "configured",
        id: "family/next",
        name: "下一模型",
        thinking: true,
        thinkingLevels: ["off", "medium", "xhigh"],
      },
    ],
  },
  session: {
    id: "session/1",
    active: true,
    model: "configured/current",
    thinkingLevel: "low",
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("authoritative session selections", () => {
  it("keeps current and pending model/thinking separate", () => {
    const running = {
      ...snapshot,
      session: {
        ...snapshot.session,
        pendingModel: "configured/family/next",
        pendingThinkingLevel: "xhigh",
      },
    };
    const selection = sessionSettingsSelection(running);

    expect(selection).toMatchObject({
      selectedModel: "configured/family/next",
      modelLabel: "下一模型",
      currentModelLabel: "当前模型",
      selectedThinking: "xhigh",
      pendingModel: true,
      pendingThinking: true,
    });
    expect(selection.model?.thinkingLevels).toEqual(["off", "medium", "xhigh"]);
    expect(running.session.model).toBe("configured/current");
    expect(running.session.thinkingLevel).toBe("low");
  });

  it("does not infer a pending selection or a default from the catalog", () => {
    expect(sessionSettingsSelection(snapshot)).toMatchObject({
      selectedModel: "configured/current",
      selectedThinking: "low",
      pendingModel: false,
      pendingThinking: false,
    });
    expect(
      sessionSettingsSelection({ ...snapshot, session: { id: "unopened", active: false } }),
    ).toMatchObject({
      selectedModel: null,
      selectedThinking: null,
      modelLabel: "尚未确定",
      pendingModel: false,
    });
  });

  it("marks pending slots even when they equal the current value", () => {
    expect(
      sessionSettingsSelection({
        ...snapshot,
        session: {
          ...snapshot.session,
          pendingModel: "configured/current",
          pendingThinkingLevel: "low",
        },
      }),
    ).toMatchObject({ pendingModel: true, pendingThinking: true });
  });

  it("preserves an unavailable selection label without inventing a model", () => {
    expect(
      sessionSettingsSelection({
        ...snapshot,
        session: { ...snapshot.session, model: "removed/model", pendingModel: "removed/next" },
      }),
    ).toMatchObject({
      model: undefined,
      modelLabel: "removed/next",
      currentModelLabel: "removed/model",
    });
  });

  it("keeps slash-containing model IDs intact and labels catalog thinking levels", () => {
    expect(modelValue(snapshot.catalog.models[1])).toBe("configured/family/next");
    expect(thinkingLabel("off")).toBe("关闭");
    expect(thinkingLabel("xhigh")).toBe("极高");
    expect(thinkingLabel("vendor-specific")).toBe("vendor-specific");
    expect(thinkingLabel(undefined)).toBe("尚未确定");
  });

  it("validates nullable current state and nonempty pending slots", () => {
    expect(
      sessionSettingsSchema.safeParse({ id: "x", active: true, model: null, thinkingLevel: null })
        .success,
    ).toBe(true);
    expect(
      sessionSettingsSchema.safeParse({ ...snapshot.session, pendingThinkingLevel: "" }).success,
    ).toBe(false);
  });
});

describe("PiSaas session settings API", () => {
  it("reads the configured models and the named session", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(snapshot.catalog))
      .mockResolvedValueOnce(Response.json(snapshot.session));
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await readSessionSettings(connection, "session/1", new AbortController().signal),
    ).toEqual(snapshot);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://pi.example.com/api/v1/models",
      "https://pi.example.com/api/v1/sessions/session%2F1",
    ]);
  });

  it("sends one model PATCH and preserves the server's pending receipt", async () => {
    const receipt = { model: "configured/current", thinkingLevel: "low", pending: true };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(receipt));
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await changeSessionSetting(
        connection,
        "session/1",
        { kind: "model", provider: "configured", id: "family/next" },
        new AbortController().signal,
      ),
    ).toEqual(receipt);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://pi.example.com/api/v1/sessions/session%2F1/model",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ provider: "configured", id: "family/next" }),
      }),
    );
  });

  it("preserves a clamped thinking response instead of reporting the requested value", async () => {
    const receipt = { model: "configured/current", thinkingLevel: "off", pending: false };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(receipt));
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await changeSessionSetting(
        connection,
        "session/1",
        { kind: "thinking", level: "high" },
        new AbortController().signal,
      ),
    ).toEqual(receipt);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://pi.example.com/api/v1/sessions/session%2F1/thinking",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ level: "high" }),
      }),
    );
  });

  it("does not retry a failed write", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network failed"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      changeSessionSetting(
        connection,
        "session/1",
        { kind: "thinking", level: "high" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("无法连接服务");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects receipts missing the pending contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ model: "configured/current", thinkingLevel: "high" })),
    );

    await expect(
      changeSessionSetting(
        connection,
        "session/1",
        { kind: "thinking", level: "high" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("服务端响应格式不兼容");
  });

  it("cancels both catalog and detail reads when the sheet closes", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(abortableFetch);
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const rejected = expect(
      readSessionSettings(connection, "session/1", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;

    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it("cancels an in-flight write without resending it", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(abortableFetch);
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const rejected = expect(
      changeSessionSetting(
        connection,
        "session/1",
        { kind: "thinking", level: "high" },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
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
