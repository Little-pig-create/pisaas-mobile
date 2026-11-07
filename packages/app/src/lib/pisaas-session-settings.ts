import { z } from "zod";
import { request, type Connection } from "./pisaas-client";

export const modelCapabilitySchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  name: z.string(),
  thinking: z.boolean(),
  thinkingLevels: z.array(z.string().min(1)),
});

export const modelsCatalogSchema = z.object({
  models: z.array(modelCapabilitySchema),
  error: z.string().nullable().optional(),
});

export const sessionSettingsSchema = z.object({
  id: z.string(),
  active: z.boolean(),
  model: z.string().nullable().optional(),
  thinkingLevel: z.string().nullable().optional(),
  pendingModel: z.string().min(1).optional(),
  pendingThinkingLevel: z.string().min(1).optional(),
});

const selectionResponseSchema = z.object({
  model: z.string().nullable().optional(),
  thinkingLevel: z.string().nullable().optional(),
  pending: z.boolean(),
});

export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export type ModelsCatalog = z.infer<typeof modelsCatalogSchema>;
export type SessionSettings = z.infer<typeof sessionSettingsSchema>;

export interface SessionSettingsSnapshot {
  catalog: ModelsCatalog;
  session: SessionSettings;
}

export type SessionSettingChange =
  | { kind: "model"; provider: string; id: string }
  | { kind: "thinking"; level: string };

export function modelValue(model: Pick<ModelCapability, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function thinkingLabel(level: string | null | undefined): string {
  switch (level) {
    case "off":
    case "none":
      return "关闭";
    case "minimal":
      return "最低";
    case "low":
      return "较低";
    case "medium":
      return "标准";
    case "high":
      return "较高";
    case "xhigh":
      return "极高";
    case "max":
      return "最高";
    case null:
    case undefined:
      return "尚未确定";
    default:
      return level;
  }
}

export function sessionSettingsSelection({ catalog, session }: SessionSettingsSnapshot) {
  const selectedModel = session.pendingModel ?? session.model ?? null;
  const selectedThinking = session.pendingThinkingLevel ?? session.thinkingLevel ?? null;
  const model = catalog.models.find((item) => modelValue(item) === selectedModel);
  const currentModel = catalog.models.find((item) => modelValue(item) === session.model);
  return {
    model,
    selectedModel,
    selectedThinking,
    modelLabel: model?.name || selectedModel || "尚未确定",
    currentModelLabel: currentModel?.name || session.model || "尚未确定",
    pendingModel: session.pendingModel !== undefined,
    pendingThinking: session.pendingThinkingLevel !== undefined,
  };
}

export async function readSessionSettings(
  connection: Connection,
  sessionId: string,
  signal: AbortSignal,
): Promise<SessionSettingsSnapshot> {
  const [catalog, session] = await Promise.all([
    request(connection, "/api/v1/models", modelsCatalogSchema, { signal }),
    request(
      connection,
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      sessionSettingsSchema,
      { signal },
    ),
  ]);
  return { catalog, session };
}

export async function changeSessionSetting(
  connection: Connection,
  sessionId: string,
  change: SessionSettingChange,
  signal: AbortSignal,
) {
  const prefix = `/api/v1/sessions/${encodeURIComponent(sessionId)}`;
  if (change.kind === "model") {
    return request(connection, `${prefix}/model`, selectionResponseSchema, {
      method: "PATCH",
      signal,
      body: JSON.stringify({ provider: change.provider, id: change.id }),
    });
  }
  return request(connection, `${prefix}/thinking`, selectionResponseSchema, {
    method: "PATCH",
    signal,
    body: JSON.stringify({ level: change.level }),
  });
}
