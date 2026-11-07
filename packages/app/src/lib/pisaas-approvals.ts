import { z } from "zod";
import { request, type Connection } from "./pisaas-client";

const questionSchema = z.object({
  question: z.string(),
  header: z.string(),
  multiSelect: z.boolean(),
  options: z
    .array(z.object({ label: z.string(), description: z.string(), hasPreview: z.boolean() }))
    .min(2)
    .max(4),
});
export const uiRequestSchema = z
  .object({
    requestId: z.string().min(1),
    kind: z.enum(["confirm", "select", "input", "editor", "questionnaire"]),
    title: z.string(),
    message: z.string().optional(),
    options: z.array(z.string()).optional(),
    questions: z.array(questionSchema).min(1).max(4).optional(),
    createdAt: z.number(),
    timeoutAt: z.number().optional(),
    planReview: z.object({ plan: z.string(), callId: z.string() }).optional(),
    approval: z
      .object({
        source: z.literal("pi-extension-ui"),
        action: z.string(),
        toolName: z.string().optional(),
        affectedPaths: z.array(z.string()).optional(),
        sessionOption: z.string().min(1).optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "questionnaire" && !value.questions) {
      ctx.addIssue({ code: "custom", message: "问卷缺少问题" });
    }
    if (value.kind === "select" && !value.options?.length) {
      ctx.addIssue({ code: "custom", message: "选择请求缺少选项" });
    }
  });
export const uiRequestsSchema = z.object({ requests: z.array(uiRequestSchema) });
export type UiRequest = z.infer<typeof uiRequestSchema>;
type Question = z.infer<typeof questionSchema>;
export type Answer =
  | { kind: "option"; optionIndex: number }
  | { kind: "multi"; optionIndexes: number[] }
  | { kind: "custom"; value: string }
  | { kind: "skipped" };
export type UiResponse = { requestId: string } & (
  | { value: string | boolean }
  | { skip: true }
  | { questionnaire: true; answers: Answer[] }
  | { cancelQuestionnaire: true }
);

export function answerValid(question: Question, answer: Answer | undefined): boolean {
  if (!answer) return false;
  const indexValid = (index: number) =>
    Number.isInteger(index) && index >= 0 && index < question.options.length;
  if (answer.kind === "skipped") return true;
  if (answer.kind === "custom") return answer.value.trim().length > 0;
  if (answer.kind === "option") return !question.multiSelect && indexValid(answer.optionIndex);
  return (
    question.multiSelect &&
    answer.optionIndexes.length > 0 &&
    answer.optionIndexes.every(indexValid)
  );
}

export function createApprovalForm(prompt: UiRequest) {
  const listeners = new Set<() => void>();
  const initialAnswers: (Answer | undefined)[] = (prompt.questions ?? []).map(() => undefined);
  let state = {
    text: prompt.kind === "editor" ? (prompt.message ?? "") : "",
    selection: null as string | null,
    answers: initialAnswers,
  };
  function publish(next: typeof state) {
    state = next;
    for (const listener of listeners) listener();
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    setText: (text: string) => publish({ ...state, text }),
    setSelection: (selection: string) => publish({ ...state, selection }),
    setAnswer(index: number, answer: Answer | undefined) {
      if (!prompt.questions?.[index]) return;
      const answers = [...state.answers];
      answers[index] = answer;
      publish({ ...state, answers });
    },
    response(): UiResponse | null {
      const requestId = prompt.requestId;
      if (prompt.kind === "questionnaire") {
        if (!prompt.questions?.every((q, i) => answerValid(q, state.answers[i]))) return null;
        return { requestId, questionnaire: true, answers: state.answers as Answer[] };
      }
      if (prompt.kind === "select") {
        return state.selection !== null && prompt.options?.includes(state.selection)
          ? { requestId, value: state.selection }
          : null;
      }
      if (prompt.kind === "input" || prompt.kind === "editor")
        return { requestId, value: state.text };
      return null;
    },
  };
}

function responseValid(prompt: UiRequest, response: UiResponse): boolean {
  if (prompt.requestId !== response.requestId) return false;
  if ("cancelQuestionnaire" in response) return prompt.kind === "questionnaire";
  if ("skip" in response) return prompt.kind !== "questionnaire";
  if ("questionnaire" in response)
    return (
      prompt.kind === "questionnaire" &&
      response.answers.length === prompt.questions?.length &&
      prompt.questions.every((q, i) => answerValid(q, response.answers[i]))
    );
  if (prompt.kind === "confirm")
    return (
      typeof response.value === "boolean" ||
      (response.value === "allow-session" && Boolean(prompt.approval?.sessionOption))
    );
  if (prompt.kind === "select")
    return typeof response.value === "string" && Boolean(prompt.options?.includes(response.value));
  return (
    (prompt.kind === "input" || prompt.kind === "editor") && typeof response.value === "string"
  );
}

export async function respondToUi(
  connection: Connection,
  sessionId: string,
  expected: UiRequest,
  response: UiResponse,
  signal: AbortSignal,
): Promise<void> {
  const prefix = `/api/v1/sessions/${encodeURIComponent(sessionId)}/ui`;
  const { requests } = await request(connection, `${prefix}/requests`, uiRequestsSchema, {
    signal,
  });
  const prompt = requests.find((item) => item.requestId === response.requestId);
  if (
    !prompt ||
    prompt.createdAt !== expected.createdAt ||
    expected.requestId !== response.requestId ||
    (prompt.timeoutAt !== undefined && prompt.timeoutAt <= Date.now())
  )
    throw new Error("请求已过期或已在其他设备处理");
  if (!responseValid(expected, response) || !responseValid(prompt, response))
    throw new Error("回答与当前请求不匹配，请重新检查");
  await request(connection, `${prefix}/responses`, z.object({ resolved: z.literal(true) }), {
    method: "POST",
    signal,
    body: JSON.stringify(response),
  });
}
