import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answerValid,
  createApprovalForm,
  respondToUi,
  uiRequestSchema,
  type UiRequest,
  type UiResponse,
} from "./pisaas-approvals";

const connection = {
  baseUrl: "https://pi.example.com",
  token: "a".repeat(43),
  user: { email: "test@example.test" },
};
const confirm: UiRequest = {
  requestId: "confirm-1",
  kind: "confirm",
  title: "Confirm action",
  createdAt: 1,
};
const question = {
  header: "Mode",
  question: "Choose",
  multiSelect: false,
  options: [
    { label: "same, label", description: "First", hasPreview: false },
    { label: "same, label", description: "Second", hasPreview: false },
  ],
};
const questionnaire: UiRequest = {
  ...confirm,
  requestId: "questions-1",
  kind: "questionnaire",
  questions: [question, { ...question, multiSelect: true }],
};
afterEach(() => vi.unstubAllGlobals());

describe("PiSaas native approval forms", () => {
  it("rejects incomplete prompts instead of rendering an executable fallback", () => {
    expect(uiRequestSchema.safeParse({ ...confirm, kind: "questionnaire" }).success).toBe(false);
    expect(uiRequestSchema.safeParse({ ...confirm, kind: "select", options: [] }).success).toBe(
      false,
    );
    expect(uiRequestSchema.safeParse({ ...confirm, kind: "unknown" }).success).toBe(false);
  });
  it("keeps each opened form independent and publishes text edits", () => {
    const first = createApprovalForm({ ...confirm, kind: "editor", message: "original" });
    const listener = vi.fn();
    const unsubscribe = first.subscribe(listener);
    expect(first.getState().text).toBe("original");
    first.setText("edited");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(first.response()).toEqual({ requestId: confirm.requestId, value: "edited" });
    expect(
      createApprovalForm({ ...confirm, kind: "editor", message: "original" }).getState().text,
    ).toBe("original");
    unsubscribe();
    first.setText("");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(first.response()).toEqual({ requestId: confirm.requestId, value: "" });
  });
  it("requires an explicit listed selection", () => {
    const model = createApprovalForm({ ...confirm, kind: "select", options: ["Yes", "No"] });
    expect(model.response()).toBeNull();
    model.setSelection("unlisted");
    expect(model.response()).toBeNull();
    model.setSelection("No");
    expect(model.response()).toEqual({ requestId: confirm.requestId, value: "No" });
  });
  it("preserves questionnaire indexes despite duplicate labels or commas", () => {
    const model = createApprovalForm(questionnaire);
    expect(model.response()).toBeNull();
    model.setAnswer(0, { kind: "option", optionIndex: 1 });
    expect(model.response()).toBeNull();
    model.setAnswer(1, { kind: "multi", optionIndexes: [0, 1] });
    expect(model.response()).toEqual({
      requestId: questionnaire.requestId,
      questionnaire: true,
      answers: [
        { kind: "option", optionIndex: 1 },
        { kind: "multi", optionIndexes: [0, 1] },
      ],
    });
    model.setAnswer(0, { kind: "custom", value: " " });
    expect(model.response()).toBeNull();
    model.setAnswer(0, { kind: "skipped" });
    expect(model.response()).not.toBeNull();
  });
  it("validates answer modes and bounds before enabling submit", () => {
    expect(answerValid(question, { kind: "option", optionIndex: -1 })).toBe(false);
    expect(answerValid(question, { kind: "option", optionIndex: 2 })).toBe(false);
    expect(answerValid(question, { kind: "option", optionIndex: 0.5 })).toBe(false);
    expect(answerValid(question, { kind: "multi", optionIndexes: [0] })).toBe(false);
    expect(
      answerValid({ ...question, multiSelect: true }, { kind: "multi", optionIndexes: [] }),
    ).toBe(false);
    expect(
      answerValid({ ...question, multiSelect: true }, { kind: "multi", optionIndexes: [0, 2] }),
    ).toBe(false);
    expect(
      answerValid({ ...question, multiSelect: true }, { kind: "option", optionIndex: 0 }),
    ).toBe(false);
    expect(answerValid(question, { kind: "custom", value: "answer" })).toBe(true);
  });
});

function mockServer(prompt: UiRequest | null, status = 200) {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ requests: prompt ? [prompt] : [] }))
    .mockResolvedValueOnce(Response.json({ resolved: status === 200 }, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const signal = () => new AbortController().signal;

describe("PiSaas native approval submission", () => {
  it.each([true, false])("reads authoritative pending state before answering %s", async (value) => {
    const fetchMock = mockServer(confirm);
    await respondToUi(
      connection,
      "session/id",
      confirm,
      { requestId: confirm.requestId, value },
      signal(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://pi.example.com/api/v1/sessions/session%2Fid/ui/requests",
    );
    expect(fetchMock.mock.calls[1][1]?.body).toBe(
      JSON.stringify({ requestId: confirm.requestId, value }),
    );
  });
  it("never answers a removed request", async () => {
    const fetchMock = mockServer(null);
    await expect(
      respondToUi(
        connection,
        "session",
        confirm,
        { requestId: confirm.requestId, value: true },
        signal(),
      ),
    ).rejects.toThrow("其他设备处理");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("never answers an expired request", async () => {
    const fetchMock = mockServer({ ...confirm, timeoutAt: Date.now() - 1 });
    await expect(
      respondToUi(
        connection,
        "session",
        confirm,
        { requestId: confirm.requestId, value: true },
        signal(),
      ),
    ).rejects.toThrow("已过期");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("offers session permission only when the current structured request grants that scope", async () => {
    let fetchMock = mockServer(confirm);
    await expect(
      respondToUi(
        connection,
        "session",
        confirm,
        { requestId: confirm.requestId, value: "allow-session" },
        signal(),
      ),
    ).rejects.toThrow("不匹配");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const scoped: UiRequest = {
      ...confirm,
      approval: {
        source: "pi-extension-ui",
        action: "write",
        sessionOption: "Yes, allow writes to /tmp/test for this session",
      },
    };
    fetchMock = mockServer(scoped);
    await respondToUi(
      connection,
      "session",
      scoped,
      { requestId: confirm.requestId, value: "allow-session" },
      signal(),
    );
    expect(fetchMock.mock.calls[1][1]?.body).toContain('"value":"allow-session"');
  });
  it.each([
    { requestId: confirm.requestId, value: "made up" },
    { requestId: confirm.requestId, cancelQuestionnaire: true },
  ] satisfies UiResponse[])("rejects mismatched answers without a write", async (response) => {
    const fetchMock = mockServer(confirm);
    await expect(respondToUi(connection, "session", confirm, response, signal())).rejects.toThrow(
      "不匹配",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not retry a raced 409 or treat an unresolved response as success", async () => {
    const fetchMock = mockServer(confirm, 409);
    await expect(
      respondToUi(
        connection,
        "session",
        confirm,
        { requestId: confirm.requestId, value: true },
        signal(),
      ),
    ).rejects.toThrow("409");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("does not replay a decision after an ambiguous network failure", async () => {
    const fetchMock = mockServer(confirm);
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(Response.json({ requests: [confirm] }))
      .mockRejectedValueOnce(new TypeError("network failed"));
    await expect(
      respondToUi(
        connection,
        "session",
        confirm,
        { requestId: confirm.requestId, value: false },
        signal(),
      ),
    ).rejects.toThrow("无法连接服务");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([
    {
      requestId: questionnaire.requestId,
      questionnaire: true,
      answers: [{ kind: "custom", value: "typed" }, { kind: "skipped" }],
    },
    { requestId: questionnaire.requestId, cancelQuestionnaire: true },
  ] satisfies UiResponse[])(
    "uses the native questionnaire submission/cancellation contract",
    async (response) => {
      const fetchMock = mockServer(questionnaire);
      await respondToUi(connection, "session", questionnaire, response, signal());
      expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify(response));
    },
  );
  it("refuses a reused request id from a new bridge lifetime", async () => {
    const fetchMock = mockServer({ ...confirm, createdAt: confirm.createdAt + 1 });
    await expect(
      respondToUi(
        connection,
        "session",
        confirm,
        { requestId: confirm.requestId, value: true },
        signal(),
      ),
    ).rejects.toThrow("其他设备处理");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
