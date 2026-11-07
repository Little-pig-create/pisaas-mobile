import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { randomUUID } from "expo-crypto";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  View,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { ArrowUp, LogOut, Plus, RefreshCw, Square } from "lucide-react-native";
import { z } from "zod";
import {
  createWebSocketTransportFactory,
  nativeWebSocketFactory,
} from "@getpaseo/client/internal/daemon-client-websocket-transport";
import type { DaemonTransport } from "@getpaseo/client/internal/daemon-client-transport-types";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import { ScreenTitle } from "@/components/headers/screen-title";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { PisaasApprovals } from "@/components/pisaas-approvals";
import { PisaasSessionSettings } from "@/components/pisaas-session-settings";
import {
  connectionSchema,
  normalizeServer,
  request,
  sessionSchema,
  snapshotSchema,
  workspaceSchema,
  type Connection,
  type Snapshot,
} from "@/lib/pisaas-client";

const STORAGE_KEY = "pisaas.session";
const accepted = z.unknown();
const workspaceListSchema = z.object({ workspaces: z.array(workspaceSchema) });
const sessionListSchema = z.object({ sessions: z.array(sessionSchema) });
const realtimeFrameSchema = z.object({ type: z.string(), message: z.string().optional() });
const createRealtimeTransport = createWebSocketTransportFactory(nativeWebSocketFactory);
type ConversationRow = Snapshot["rows"][number];

function message(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败，请重试";
}

export default function PisaasRoute() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    async function restore() {
      try {
        await AsyncStorage.removeItem("pisaas.mobile.connection");
        const raw = await SecureStore.getItemAsync(STORAGE_KEY);
        if (raw && active) {
          const saved = connectionSchema.parse(JSON.parse(raw));
          setConnection({ ...saved, baseUrl: normalizeServer(saved.baseUrl) });
        }
      } catch (caught) {
        if (active) setError(message(caught));
      } finally {
        if (active) setRestoring(false);
      }
    }
    void restore();
    return () => {
      active = false;
    };
  }, []);
  const onLogin = useCallback((value: Connection) => {
    setError("");
    setConnection(value);
  }, []);
  const logout = useCallback(async () => {
    if (!connection) return;
    setError("");
    try {
      await SecureStore.deleteItemAsync(STORAGE_KEY);
    } catch (caught) {
      setError(`无法删除本机登录凭证：${message(caught)}`);
      return;
    }
    setConnection(null);
    try {
      await request(connection, "/api/v1/auth/logout", accepted, { method: "POST" });
    } catch {
      setError("已退出本机；服务器会话可能未撤销，请在网络恢复后检查账户会话");
    }
  }, [connection]);

  let content;
  if (restoring) content = <ActivityIndicator accessibilityLabel="恢复登录" />;
  else if (connection)
    content = <Workspace key={connection.token} connection={connection} logout={logout} />;
  else content = <Login onLogin={onLogin} />;
  return (
    <SafeAreaView style={styles.screen}>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {content}
    </SafeAreaView>
  );
}

function Login({ onLogin }: { onLogin: (value: Connection) => void }) {
  const [baseUrl, setBaseUrl] = useState(process.env.EXPO_PUBLIC_PISAAS_URL ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const login = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const server = normalizeServer(baseUrl);
      const payload = await request(
        { baseUrl: server },
        "/api/v1/auth/login",
        connectionSchema.omit({ baseUrl: true }),
        {
          method: "POST",
          body: JSON.stringify({ email: email.trim(), password, remember: true }),
        },
      );
      const saved = { ...payload, baseUrl: server };
      await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(saved));
      onLogin(saved);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }, [baseUrl, busy, email, onLogin, password]);
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.login}>
        <Text style={styles.brand}>PiSaas</Text>
        <Field label="服务地址">
          <FormTextInput
            testID="server-url"
            accessibilityLabel="服务地址"
            initialValue={baseUrl}
            onChangeText={setBaseUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!busy}
            placeholder="https://pi.example.com"
          />
        </Field>
        <Field label="邮箱">
          <FormTextInput
            testID="email"
            accessibilityLabel="邮箱"
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            editable={!busy}
          />
        </Field>
        <Field label="密码">
          <FormTextInput
            testID="password"
            accessibilityLabel="密码"
            onChangeText={setPassword}
            secureTextEntry
            editable={!busy}
          />
        </Field>
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        <Button
          testID="login"
          onPress={login}
          loading={busy}
          disabled={!baseUrl || !email || !password || busy}
        >
          登录
        </Button>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function sessionLabel(session: z.infer<typeof sessionSchema>): string {
  return session.name || session.firstMessage || "新会话";
}

function Workspace({ connection, logout }: { connection: Connection; logout: () => void }) {
  const [workspaces, setWorkspaces] = useState<z.infer<typeof workspaceSchema>[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<z.infer<typeof sessionSchema>[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const payload = await request(connection, "/api/v1/workspaces", workspaceListSchema, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setWorkspaces(payload.workspaces);
        setWorkspaceId((current) => current ?? payload.workspaces[0]?.id ?? null);
        setError("");
      } catch (caught) {
        if (!controller.signal.aborted) setError(message(caught));
      }
    }
    void load();
    return () => controller.abort();
  }, [connection, revision]);
  useEffect(() => {
    if (!workspaceId) return;
    const selectedWorkspaceId = workspaceId;
    const controller = new AbortController();
    async function load() {
      try {
        const payload = await request(
          connection,
          `/api/v1/workspaces/${encodeURIComponent(selectedWorkspaceId)}/sessions`,
          sessionListSchema,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setSessions(payload.sessions);
        const available = new Set(payload.sessions.map((item) => item.id));
        setSessionId((current) =>
          current && available.has(current) ? current : (payload.sessions[0]?.id ?? null),
        );
      } catch (caught) {
        if (!controller.signal.aborted) setError(message(caught));
      }
    }
    void load();
    return () => controller.abort();
  }, [connection, workspaceId, revision]);
  const createSession = useCallback(async () => {
    if (!workspaceId || busy) return;
    setBusy(true);
    setError("");
    try {
      const session = await request(
        connection,
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
        sessionSchema,
        { method: "POST", body: JSON.stringify({ reuse: true, clientCommandId: randomUUID() }) },
      );
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      setSessionId(session.id);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }, [busy, connection, workspaceId]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const chooseWorkspace = useCallback((id: string) => {
    setSessionId(null);
    setSessions([]);
    setWorkspaceId(id);
  }, []);
  const updateDraft = useCallback((id: string, value: string) => {
    setDrafts((current) => ({ ...current, [id]: value }));
  }, []);
  const workspaceOptions = useMemo(
    () => workspaces.map((item) => ({ id: item.id, value: item.id, label: item.name })),
    [workspaces],
  );
  const sessionOptions = useMemo(
    () => sessions.map((item) => ({ id: item.id, value: item.id, label: sessionLabel(item) })),
    [sessions],
  );
  const workspaceDisplay = workspaceOptions.find((item) => item.id === workspaceId) ?? null;
  const sessionDisplay = sessionOptions.find((item) => item.id === sessionId) ?? null;
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.grow}>
          <ScreenTitle>PiSaas</ScreenTitle>
          <Text numberOfLines={1} style={styles.muted}>
            {connection.user.name ?? connection.user.email}
          </Text>
        </View>
        <Button variant="ghost" leftIcon={RefreshCw} accessibilityLabel="刷新" onPress={refresh} />
        <Button variant="ghost" leftIcon={LogOut} accessibilityLabel="退出登录" onPress={logout} />
      </View>
      <View style={styles.selectors}>
        <SelectField
          label="工作区"
          field={false}
          value={workspaceId}
          selectedDisplay={workspaceDisplay}
          options={workspaceOptions}
          placeholder="选择工作区"
          emptyText="暂无工作区"
          disabled={busy}
          onChange={chooseWorkspace}
        />
        <View style={styles.row}>
          <View style={styles.grow}>
            <SelectField
              label="会话"
              field={false}
              triggerTestID="session-picker"
              value={sessionId}
              selectedDisplay={sessionDisplay}
              options={sessionOptions}
              placeholder="选择会话"
              emptyText="暂无会话"
              disabled={busy}
              onChange={setSessionId}
            />
          </View>
          <Button
            leftIcon={Plus}
            accessibilityLabel="新建会话"
            loading={busy}
            disabled={!workspaceId || busy}
            onPress={createSession}
          />
        </View>
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {sessionId ? (
        <Conversation
          key={sessionId}
          connection={connection}
          sessionId={sessionId}
          draft={drafts[sessionId] ?? ""}
          updateDraft={updateDraft}
        />
      ) : (
        <Text style={styles.empty}>选择工作区，新建会话</Text>
      )}
    </View>
  );
}

function rowLabel(row: ConversationRow): string {
  switch (row.kind) {
    case "userInput":
      return "你";
    case "reasoning":
      return "思考";
    case "toolCall":
      return `${row.toolName} · ${row.status}`;
    case "assistantText":
      return "Pi";
    default:
      return row.kind;
  }
}

function rowKey(row: ConversationRow): string {
  return String(row.rowId);
}

function renderRow({ item }: ListRenderItemInfo<ConversationRow>) {
  return (
    <View style={item.kind === "userInput" ? styles.userMessage : styles.assistantMessage}>
      <Text style={styles.muted}>{rowLabel(item)}</Text>
      <MarkdownRenderer
        text={item.text ?? item.outputText ?? item.summaryText ?? item.path ?? ""}
        streaming={item.state === "streaming"}
      />
      {item.errorMessage ? <Text style={styles.error}>{item.errorMessage}</Text> : null}
    </View>
  );
}

interface ConversationProps {
  connection: Connection;
  sessionId: string;
  draft: string;
  updateDraft: (id: string, value: string) => void;
}

function Conversation({ connection, sessionId, draft, updateDraft }: ConversationProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const refresh = useRef<() => void>(() => {});
  const list = useRef<FlatList<ConversationRow> | null>(null);
  const nearBottom = useRef(true);
  const prefix = `/api/v1/sessions/${encodeURIComponent(sessionId)}`;
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    let pending = false;
    let dirty = false;
    let socket: DaemonTransport | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let coalesce: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      if (abort.signal.aborted) return;
      if (pending) {
        dirty = true;
        return;
      }
      pending = true;
      try {
        const next = await request(connection, `${prefix}/conversation/snapshot`, snapshotSchema, {
          signal: abort.signal,
        });
        if (!abort.signal.aborted) {
          setSnapshot(next);
          setError("");
        }
      } catch (caught) {
        if (!abort.signal.aborted) setError(message(caught));
      } finally {
        pending = false;
        if (dirty && !abort.signal.aborted) {
          dirty = false;
          void load();
        }
      }
    }
    function schedule() {
      if (coalesce) return;
      coalesce = setTimeout(() => {
        coalesce = undefined;
        void load();
      }, 250);
    }
    function connect() {
      if (abort.signal.aborted) return;
      socket = createRealtimeTransport({
        url: `${connection.baseUrl.replace(/^http/, "ws")}/api/v1/realtime`,
        headers: { Authorization: `Bearer ${connection.token}`, Origin: connection.baseUrl },
      });
      socket.onOpen(() => {
        if (abort.signal.aborted) return;
        setLive(true);
        void socket?.send(
          JSON.stringify({
            id: "conversation",
            type: "subscribe",
            path: `${prefix}/conversation/stream`,
          }),
        );
        void load();
      });
      // shortcut: stream events trigger snapshots; apply deltas when large histories require it.
      socket.onMessage((data) => {
        if (abort.signal.aborted) return;
        try {
          if (typeof data !== "string") throw new Error("实时响应格式无效");
          const frame = realtimeFrameSchema.parse(JSON.parse(data));
          if (frame.type === "data") schedule();
          if (frame.type === "error") {
            setLive(false);
            setError(frame.message || "实时连接失败");
          }
        } catch {
          setError("实时响应格式无效");
        }
      });
      socket.onError(() => {
        if (!abort.signal.aborted) setLive(false);
      });
      socket.onClose(() => {
        if (abort.signal.aborted) return;
        setLive(false);
        retry = setTimeout(connect, 3000);
      });
    }
    refresh.current = () => void load();
    void load();
    connect();
    const fallback = setInterval(() => void load(), 10000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    return () => {
      abort.abort();
      clearInterval(fallback);
      clearTimeout(retry);
      clearTimeout(coalesce);
      subscription.remove();
      socket?.close();
    };
  }, [connection, prefix]);
  const running = snapshot != null && snapshot.sessionPhase !== "idle";
  const command = useCallback(async () => {
    const text = draft.trim();
    if (busy || (!running && !text)) return;
    setBusy(true);
    setError("");
    const signal = controller.current?.signal;
    try {
      await request(connection, `${prefix}/${running ? "abort" : "messages"}`, accepted, {
        method: "POST",
        signal,
        body: JSON.stringify(running ? {} : { text, clientCommandId: randomUUID() }),
      });
      if (signal?.aborted) return;
      if (!running) {
        updateDraft(sessionId, "");
        setResetKey((value) => value + 1);
      }
      refresh.current();
    } catch (caught) {
      if (!signal?.aborted)
        setError(`${message(caught)}${running ? "" : "；草稿已保留，请确认会话后重试"}`);
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }, [busy, connection, draft, prefix, running, sessionId, updateDraft]);
  const changeDraft = useCallback(
    (value: string) => updateDraft(sessionId, value),
    [sessionId, updateDraft],
  );
  const rows = useMemo(
    () =>
      snapshot?.rows.filter((row) => row.kind !== "turnHeader" && row.kind !== "timelineMarker") ??
      [],
    [snapshot],
  );
  const loading = snapshot == null;
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
  }, []);
  const scrollToLatest = useCallback(() => {
    if (nearBottom.current) list.current?.scrollToEnd({ animated: false });
  }, []);
  const onApprovalResolved = useCallback(() => refresh.current(), []);
  const empty = useMemo(
    () => <Text style={styles.empty}>{loading ? "加载对话…" : "开始一个新任务"}</Text>,
    [loading],
  );
  let status = "就绪";
  if (snapshot?.sessionPhase === "awaiting_ui") status = "等待你的确认";
  else if (running) status = "运行中";
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.status}>
        <Text style={[styles.muted, styles.grow]}>
          {status}
          {live ? " · 实时连接" : " · 正在重连"}
        </Text>
        <PisaasSessionSettings connection={connection} sessionId={sessionId} />
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <PisaasApprovals
        connection={connection}
        sessionId={sessionId}
        phase={snapshot?.sessionPhase}
        onResolved={onApprovalResolved}
      />
      <FlatList
        ref={list}
        style={styles.screen}
        contentContainerStyle={styles.messages}
        data={rows}
        keyExtractor={rowKey}
        renderItem={renderRow}
        ListEmptyComponent={empty}
        onScroll={onScroll}
        onContentSizeChange={scrollToLatest}
        scrollEventThrottle={16}
      />
      <View style={styles.composer}>
        <View style={styles.grow}>
          <FormTextInput
            testID="message"
            accessibilityLabel="消息"
            initialValue={draft}
            resetKey={resetKey}
            onChangeText={changeDraft}
            multiline
            editable={!busy}
            placeholder="输入消息…"
            style={styles.composerInput}
          />
        </View>
        <Button
          testID={running ? "stop" : "send"}
          leftIcon={running ? Square : ArrowUp}
          accessibilityLabel={running ? "停止任务" : "发送消息"}
          loading={busy}
          disabled={busy || !snapshot || (!running && !draft.trim())}
          onPress={command}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surface0 },
  grow: { flex: 1, minWidth: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  login: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 24,
    gap: 18,
    maxWidth: 520,
    width: "100%",
    alignSelf: "center",
  },
  brand: { fontSize: 30, fontWeight: "600", color: theme.colors.foreground, marginBottom: 12 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 8,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  selectors: { padding: 12, gap: 8 },
  muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
  error: { color: theme.colors.destructive, padding: 12 },
  status: {
    paddingHorizontal: 14,
    paddingBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  messages: { padding: 14, gap: 20, flexGrow: 1 },
  empty: { color: theme.colors.foregroundMuted, textAlign: "center", marginTop: 48 },
  userMessage: {
    padding: 12,
    gap: 6,
    backgroundColor: theme.colors.surface2,
    borderRadius: 8,
    alignSelf: "flex-end",
    maxWidth: "94%",
  },
  assistantMessage: { gap: 6, alignSelf: "stretch" },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
  },
  composerInput: { maxHeight: 120, minHeight: 44 },
}));
