import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { RefreshCw, SlidersHorizontal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import type { Connection } from "@/lib/pisaas-client";
import {
  changeSessionSetting,
  modelValue,
  readSessionSettings,
  sessionSettingsSelection,
  thinkingLabel,
  type SessionSettingChange,
  type SessionSettingsSnapshot,
} from "@/lib/pisaas-session-settings";
import { ICON_SIZE } from "@/styles/theme";

interface PisaasSessionSettingsProps {
  connection: Connection;
  sessionId: string;
}

const HEADER: SheetHeader = { title: "模型与思考" };
const ThemedSliders = withUnistyles(SlidersHorizontal, (theme) => ({
  color: theme.colors.foreground,
}));

export function PisaasSessionSettings({ connection, sessionId }: PisaasSessionSettingsProps) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <ToolbarButton label="模型与思考" onPress={show} selected={open} testID="session-settings">
        <ThemedSliders size={ICON_SIZE.md} />
      </ToolbarButton>
      {open ? (
        <SessionSettingsSheet
          key={sessionId}
          connection={connection}
          sessionId={sessionId}
          onClose={close}
        />
      ) : null}
    </>
  );
}

interface SessionSettingsSheetProps extends PisaasSessionSettingsProps {
  onClose: () => void;
}

function SessionSettingsSheet({ connection, sessionId, onClose }: SessionSettingsSheetProps) {
  const queryClient = useQueryClient();
  const [controller] = useState(() => new AbortController());
  useEffect(() => () => controller.abort(), [controller]);
  const queryKey = useMemo(
    () => ["pisaas-session-settings", connection.baseUrl, connection.user.email, sessionId],
    [connection.baseUrl, connection.user.email, sessionId],
  );
  const query = useFetchQuery({
    queryKey,
    queryFn: ({ signal }) => readSessionSettings(connection, sessionId, signal),
    dataShape: "value",
    staleTimeMs: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: "always",
    refetchInterval: 5000,
  });
  const mutation = useMutation({
    mutationFn: (change: SessionSettingChange) =>
      changeSessionSetting(connection, sessionId, change, controller.signal),
    gcTime: 0,
    retry: false,
    onMutate: () => queryClient.cancelQueries({ queryKey }),
    onSettled: async () => {
      if (!controller.signal.aborted) await query.refetch();
    },
  });
  const refresh = useCallback(() => {
    mutation.reset();
    void query.refetch();
  }, [mutation, query]);
  const save = useCallback(
    (change: SessionSettingChange) => {
      if (mutation.isPending || query.isError) return;
      mutation.mutate(change);
    },
    [mutation, query.isError],
  );

  return (
    <AdaptiveModalSheet visible onClose={onClose} header={HEADER} testID="session-settings-sheet">
      <View style={styles.content}>
        {query.isPending ? <ActivityIndicator accessibilityLabel="加载会话设置" /> : null}
        {query.data ? (
          <SessionSettingsFields
            snapshot={query.data}
            saving={mutation.isPending}
            disabled={mutation.isPending || query.isError}
            onChange={save}
          />
        ) : null}
        {mutation.isPending ? <Text style={styles.muted}>正在确认设置…</Text> : null}
        {mutation.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            修改未确认：{mutation.error.message}
          </Text>
        ) : null}
        {query.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            无法刷新设置：{query.error.message}
          </Text>
        ) : null}
        <Button
          variant="ghost"
          leftIcon={RefreshCw}
          accessibilityLabel="刷新会话设置"
          onPress={refresh}
          disabled={mutation.isPending}
          loading={query.isFetching}
        >
          刷新
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

interface SessionSettingsFieldsProps {
  snapshot: SessionSettingsSnapshot;
  saving: boolean;
  disabled: boolean;
  onChange: (change: SessionSettingChange) => void;
}

function SessionSettingsFields({
  snapshot,
  saving,
  disabled,
  onChange,
}: SessionSettingsFieldsProps) {
  const { catalog, session } = snapshot;
  const selection = sessionSettingsSelection(snapshot);
  const modelOptions = useMemo(
    () =>
      catalog.models.map((model) => ({
        id: modelValue(model),
        value: modelValue(model),
        label: model.name || model.id,
        description: model.provider,
      })),
    [catalog.models],
  );
  const modelDisplay = useMemo(() => ({ label: selection.modelLabel }), [selection.modelLabel]);
  const thinkingOptions = useMemo(
    () =>
      (selection.model?.thinkingLevels ?? []).map((level) => ({
        id: level,
        value: level,
        label: thinkingLabel(level),
      })),
    [selection.model],
  );
  const thinkingDisplay = useMemo(
    () => ({ label: thinkingLabel(selection.selectedThinking) }),
    [selection.selectedThinking],
  );
  const chooseModel = useCallback(
    (value: string) => {
      const model = catalog.models.find((item) => modelValue(item) === value);
      if (!model || value === selection.selectedModel) return;
      onChange({ kind: "model", provider: model.provider, id: model.id });
    },
    [catalog.models, onChange, selection.selectedModel],
  );
  const chooseThinking = useCallback(
    (level: string) => {
      if (level === selection.selectedThinking) return;
      onChange({ kind: "thinking", level });
    },
    [onChange, selection.selectedThinking],
  );
  return (
    <>
      <SelectField
        label="模型"
        value={selection.selectedModel}
        selectedDisplay={modelDisplay}
        options={modelOptions}
        onChange={chooseModel}
        placeholder="选择模型"
        emptyText="暂无可用模型"
        disabled={disabled || modelOptions.length === 0}
        loading={saving}
        searchable
        searchPlaceholder="搜索模型"
        triggerTestID="session-model"
      />
      <Text style={styles.muted}>当前模型：{selection.currentModelLabel}</Text>
      {selection.pendingModel ? (
        <Text style={styles.pending} testID="pending-model">
          下轮模型：{selection.modelLabel}
        </Text>
      ) : null}
      {thinkingOptions.length > 0 ? (
        <SelectField
          label="思考档位"
          value={selection.selectedThinking}
          selectedDisplay={thinkingDisplay}
          options={thinkingOptions}
          onChange={chooseThinking}
          placeholder="选择档位"
          emptyText="暂无档位"
          disabled={disabled}
          loading={saving}
          triggerTestID="session-thinking"
        />
      ) : null}
      <Text style={styles.muted}>当前思考：{thinkingLabel(session.thinkingLevel)}</Text>
      {selection.pendingThinking ? (
        <Text style={styles.pending} testID="pending-thinking">
          下轮思考：{thinkingLabel(session.pendingThinkingLevel)}
        </Text>
      ) : null}
      {catalog.error ? (
        <Text style={styles.error}>模型目录暂不可用，请检查服务端模型配置</Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[3], minWidth: 0 },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  pending: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
