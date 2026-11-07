import { z } from "zod";

export const connectionSchema = z.object({
  baseUrl: z.string().url(),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  user: z.object({ email: z.string(), name: z.string().nullable().optional() }),
});
export type Connection = z.infer<typeof connectionSchema>;
export const workspaceSchema = z.object({ id: z.string(), name: z.string() });
export const sessionSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  firstMessage: z.string().optional(),
});
export const snapshotSchema = z.object({
  sessionPhase: z.enum(["idle", "running", "awaiting_ui", "cancelling"]),
  rows: z.array(
    z.object({
      rowId: z.number(),
      kind: z.string(),
      text: z.string().optional(),
      state: z.string().optional(),
      toolName: z.string().optional(),
      status: z.string().optional(),
      outputText: z.string().optional(),
      errorMessage: z.string().optional(),
      summaryText: z.string().optional(),
      path: z.string().optional(),
    }),
  ),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

const errorSchema = z.object({
  error: z.union([z.string(), z.object({ message: z.string() })]),
});

function responseError(status: number, payload: unknown, token?: string): Error {
  if (status === 401 && token) return new Error("登录已过期，请退出后重新登录");
  const error = errorSchema.safeParse(payload);
  if (!error.success) {
    return new Error(status === 401 ? "登录失败，请检查账号和密码" : `请求失败 (${status})`);
  }
  return new Error(
    typeof error.data.error === "string" ? error.data.error : error.data.error.message,
  );
}

export function normalizeServer(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入 PiSaas 服务地址，例如 https://pi.example.com");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("请输入 PiSaas 服务地址，例如 https://pi.example.com");
  }
  // shortcut: HTTP supports local networks only; use HTTPS for public access.
  if (
    url.protocol === "http:" &&
    !/^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])$/.test(
      url.hostname,
    )
  ) {
    throw new Error("公网访问请使用 HTTPS 地址");
  }
  return url.origin;
}

export async function request<T>(
  connection: { baseUrl: string; token?: string },
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const baseUrl = normalizeServer(connection.baseUrl);
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort);
  if (init.signal?.aborted) controller.abort();
  const timeout = setTimeout(() => {
    timedOut = true;
    abort();
  }, 20000);
  try {
    let response: Response;
    let payload: unknown;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        credentials: "omit",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Origin: baseUrl,
          "X-PiSaas-Client": "mobile",
          ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}),
        },
      });
      payload = await response.json();
    } catch (caught) {
      if (timedOut) throw new Error("请求超时，请检查网络后重试", { cause: caught });
      if (init.signal?.aborted) {
        if (caught instanceof Error && caught.name === "AbortError") throw caught;
        const cancelled = new Error("请求已取消", { cause: caught });
        cancelled.name = "AbortError";
        throw cancelled;
      }
      if (caught instanceof SyntaxError) {
        throw new Error("服务端响应格式不兼容，请检查版本", { cause: caught });
      }
      throw new Error("无法连接服务，请检查网络和服务地址", { cause: caught });
    }
    if (!response.ok) {
      throw responseError(response.status, payload, connection.token);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new Error("服务端响应格式不兼容，请检查版本");
    return parsed.data;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abort);
  }
}
