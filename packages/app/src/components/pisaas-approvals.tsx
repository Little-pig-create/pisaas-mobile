import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, AppState, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Check, RefreshCw, ShieldCheck, X } from "lucide-react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { AdaptiveModalSheet, FULL_SHEET_SNAP_POINTS } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { request, type Connection, type Snapshot } from "@/lib/pisaas-client";
import {
  createApprovalForm,
  respondToUi,
  uiRequestsSchema,
  type Answer,
  type UiRequest,
  type UiResponse,
} from "@/lib/pisaas-approvals";

interface Props {
  connection: Connection;
  sessionId: string;
  phase: Snapshot["sessionPhase"] | undefined;
  onResolved: () => void;
}

const HEADER = { title: "待处理请求" };
const EMPTY_REQUESTS: UiRequest[] = [];

export function PisaasApprovals(props: Props) {
  return (
    <SessionApprovals
      key={`${props.connection.baseUrl}:${props.connection.user.email}:${props.sessionId}`}
      {...props}
    />
  );
}

function SessionApprovals({ connection, sessionId, phase, onResolved }: Props) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [controller] = useState(() => new AbortController());
  const writing = useRef(false);
  useEffect(() => () => controller.abort(), [controller]);
  const queryKey = useMemo(
    () => ["pisaas-approvals", connection.baseUrl, connection.user.email, sessionId],
    [connection.baseUrl, connection.user.email, sessionId],
  );
  const mutation = useMutation({
    mutationKey: queryKey,
    mutationFn: ({ prompt, response }: { prompt: UiRequest; response: UiResponse }) =>
      respondToUi(connection, sessionId, prompt, response, controller.signal),
    gcTime: 0,
    retry: false,
    onMutate: () => queryClient.cancelQueries({ queryKey, exact: true }),
    onSettled: async () => {
      try {
        if (controller.signal.aborted) return;
        await queryClient.refetchQueries({ queryKey, exact: true });
        if (!controller.signal.aborted) onResolved();
      } finally {
        writing.current = false;
      }
    },
  });
  const prefix = `/api/v1/sessions/${encodeURIComponent(sessionId)}/ui/requests`;
  const query = useFetchQuery({
    queryKey,
    queryFn: ({ signal }) => request(connection, prefix, uiRequestsSchema, { signal }),
    dataShape: "value",
    staleTimeMs: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: "always",
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    refetchInterval: mutation.isPending ? false : 5000,
  });
  const { refetch } = query;
  const { reset } = mutation;
  const reload = useCallback(() => {
    if (!writing.current) void refetch();
  }, [refetch]);
  useEffect(() => {
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") reload();
    });
    return () => appState.remove();
  }, [reload]);
  useEffect(() => {
    reload();
  }, [phase, reload]);
  const available = query.data !== undefined && !query.isError;
  const respond = useCallback(
    (prompt: UiRequest, response: UiResponse) => {
      if (controller.signal.aborted || writing.current || !available) return;
      writing.current = true;
      mutation.mutate({ prompt, response });
    },
    [available, controller, mutation],
  );
  const show = useCallback(() => {
    setOpen(true);
    reload();
  }, [reload]);
  const close = useCallback(() => setOpen(false), []);
  const refresh = useCallback(() => {
    reset();
    reload();
  }, [reset, reload]);
  const requests = query.data?.requests ?? EMPTY_REQUESTS;
  const prompt = requests[0];
  if (!prompt && !query.error && !mutation.error) return null;
  return (
    <View style={styles.banner}>
      <Button testID="approval-open" variant="outline" leftIcon={ShieldCheck} onPress={show}>
        {prompt ? `待处理 ${requests.length}` : "确认请求状态"}
      </Button>
      <AdaptiveModalSheet
        visible={open}
        onClose={close}
        header={HEADER}
        snapPoints={FULL_SHEET_SNAP_POINTS}
      >
        {mutation.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            提交未确认：{mutation.error.message}
          </Text>
        ) : null}
        {query.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            无法刷新请求：{query.error.message}
          </Text>
        ) : null}
        {!available || mutation.error ? (
          <Button
            leftIcon={RefreshCw}
            accessibilityLabel="刷新待处理请求"
            onPress={refresh}
            disabled={mutation.isPending}
            loading={query.isFetching}
          >
            刷新
          </Button>
        ) : null}
        {prompt ? (
          <ApprovalForm
            key={`${prompt.requestId}:${prompt.createdAt}`}
            prompt={prompt}
            disabled={mutation.isPending || !available}
            busy={mutation.isPending}
            onRespond={respond}
          />
        ) : (
          <Text style={styles.muted}>暂无待处理请求</Text>
        )}
      </AdaptiveModalSheet>
    </View>
  );
}

type ApprovalFormModel = ReturnType<typeof createApprovalForm>;
type ApprovalFormState = ReturnType<ApprovalFormModel["getState"]>;

function ApprovalForm({
  prompt,
  disabled,
  busy,
  onRespond,
}: {
  prompt: UiRequest;
  disabled: boolean;
  busy: boolean;
  onRespond: (prompt: UiRequest, response: UiResponse) => void;
}) {
  const [model] = useState(() => createApprovalForm(prompt));
  const state = useSyncExternalStore(model.subscribe, model.getState);
  const response = model.response();
  const expired = prompt.timeoutAt !== undefined && prompt.timeoutAt <= Date.now();
  const unavailable = disabled || expired;
  return (
    <View style={styles.form}>
      <ApprovalDetails prompt={prompt} expired={expired} />
      <ApprovalFields prompt={prompt} model={model} state={state} disabled={unavailable} />
      {busy ? <ActivityIndicator accessibilityLabel="正在提交回答" /> : null}
      <ApprovalActions
        prompt={prompt}
        response={response}
        disabled={unavailable}
        onRespond={onRespond}
      />
    </View>
  );
}

function ApprovalDetails({ prompt, expired }: { prompt: UiRequest; expired: boolean }) {
  return (
    <>
      <Text style={styles.title}>{prompt.title}</Text>
      {prompt.message && prompt.kind !== "editor" && prompt.kind !== "input" ? (
        <MarkdownRenderer text={prompt.message} />
      ) : null}
      {prompt.planReview ? <MarkdownRenderer text={prompt.planReview.plan} /> : null}
      {prompt.approval?.toolName ? (
        <Text style={styles.muted}>工具：{prompt.approval.toolName}</Text>
      ) : null}
      {prompt.approval?.affectedPaths?.map((path) => (
        <Text key={path} selectable style={styles.body}>
          {path}
        </Text>
      ))}
      {prompt.approval?.sessionOption ? (
        <Text style={styles.muted}>{prompt.approval.sessionOption}</Text>
      ) : null}
      {prompt.timeoutAt !== undefined ? (
        <Text style={styles.muted}>
          {expired ? "请求已过期" : `截止 ${new Date(prompt.timeoutAt).toLocaleTimeString()}`}
        </Text>
      ) : null}
    </>
  );
}

function ApprovalFields({
  prompt,
  model,
  state,
  disabled,
}: {
  prompt: UiRequest;
  model: ApprovalFormModel;
  state: ApprovalFormState;
  disabled: boolean;
}) {
  const selectionDisplay = useMemo(
    () => (state.selection !== null ? { label: state.selection } : null),
    [state.selection],
  );
  const options = useMemo(
    () =>
      (prompt.options ?? []).map((label, index) => ({
        id: `${prompt.requestId}:option:${index}`,
        value: label,
        label,
      })),
    [prompt.options, prompt.requestId],
  );
  const questions = useMemo(
    () =>
      (prompt.questions ?? []).map((question, index) => ({
        id: `${prompt.requestId}:question:${index}`,
        question,
        index,
      })),
    [prompt.questions, prompt.requestId],
  );
  return (
    <>
      {prompt.kind === "select" ? (
        <SelectField
          label="选择回答"
          triggerTestID="approval-select"
          value={state.selection}
          selectedDisplay={selectionDisplay}
          options={options}
          onChange={model.setSelection}
          placeholder="选择回答"
          emptyText="暂无选项"
          disabled={disabled}
        />
      ) : null}
      {prompt.kind === "input" || prompt.kind === "editor" ? (
        <Field label="回答">
          <FormTextInput
            testID="approval-input"
            accessibilityLabel="回答"
            initialValue={state.text}
            onChangeText={model.setText}
            multiline={prompt.kind === "editor"}
            placeholder={prompt.kind === "input" ? prompt.message : undefined}
            editable={!disabled}
          />
        </Field>
      ) : null}
      {questions.map((item) => (
        <QuestionField
          key={item.id}
          id={item.id}
          question={item.question}
          index={item.index}
          answer={state.answers[item.index]}
          disabled={disabled}
          model={model}
        />
      ))}
    </>
  );
}

function ApprovalActions({
  prompt,
  response,
  disabled,
  onRespond,
}: {
  prompt: UiRequest;
  response: UiResponse | null;
  disabled: boolean;
  onRespond: (prompt: UiRequest, response: UiResponse) => void;
}) {
  const allow = useCallback(
    () => onRespond(prompt, { requestId: prompt.requestId, value: true }),
    [onRespond, prompt],
  );
  const allowSession = useCallback(
    () => onRespond(prompt, { requestId: prompt.requestId, value: "allow-session" }),
    [onRespond, prompt],
  );
  const reject = useCallback(
    () => onRespond(prompt, { requestId: prompt.requestId, value: false }),
    [onRespond, prompt],
  );
  const submit = useCallback(() => {
    if (response) onRespond(prompt, response);
  }, [onRespond, prompt, response]);
  const skip = useCallback(() => {
    onRespond(
      prompt,
      prompt.kind === "questionnaire"
        ? { requestId: prompt.requestId, cancelQuestionnaire: true }
        : { requestId: prompt.requestId, skip: true },
    );
  }, [onRespond, prompt]);
  return (
    <View style={styles.actions}>
      {prompt.kind === "confirm" ? (
        <>
          <Button
            testID="approval-once"
            variant="default"
            leftIcon={Check}
            disabled={disabled}
            onPress={allow}
          >
            {prompt.approval ? "允许一次" : "确认"}
          </Button>
          {prompt.approval?.sessionOption ? (
            <Button
              testID="approval-session"
              variant="outline"
              disabled={disabled}
              onPress={allowSession}
            >
              本会话允许
            </Button>
          ) : null}
          <Button
            testID="approval-reject"
            variant="outline"
            leftIcon={X}
            disabled={disabled}
            onPress={reject}
          >
            {prompt.approval ? "拒绝" : "取消"}
          </Button>
        </>
      ) : (
        <>
          <Button
            testID="approval-submit"
            variant="default"
            leftIcon={Check}
            disabled={disabled || !response}
            onPress={submit}
          >
            提交
          </Button>
          <Button
            testID="approval-skip"
            variant="outline"
            leftIcon={X}
            disabled={disabled}
            onPress={skip}
          >
            {prompt.kind === "questionnaire" ? "取消问卷" : "跳过"}
          </Button>
        </>
      )}
    </View>
  );
}

type Question = NonNullable<UiRequest["questions"]>[number];
type QuestionMode = "options" | "custom" | "skipped";
type QuestionOption = Question["options"][number] & { id: string; value: number };
function QuestionField({
  id,
  question,
  index,
  answer,
  disabled,
  model,
}: {
  id: string;
  question: Question;
  index: number;
  answer: Answer | undefined;
  disabled: boolean;
  model: ApprovalFormModel;
}) {
  const mode = answer?.kind === "custom" || answer?.kind === "skipped" ? answer.kind : "options";
  const modes = useMemo(
    () => [
      { value: "options" as const, label: "选项", disabled },
      { value: "custom" as const, label: "自填", disabled },
      { value: "skipped" as const, label: "跳过", disabled },
    ],
    [disabled],
  );
  const options = useMemo(
    () =>
      question.options.map((option, optionIndex) => ({
        ...option,
        id: `${id}:option:${optionIndex}`,
        value: optionIndex,
      })),
    [id, question.options],
  );
  const onChange = useCallback(
    (next: Answer | undefined) => model.setAnswer(index, next),
    [index, model],
  );
  const changeMode = useCallback(
    (next: QuestionMode) => {
      if (next === "custom") onChange({ kind: "custom", value: "" });
      else if (next === "skipped") onChange({ kind: "skipped" });
      else onChange(undefined);
    },
    [onChange],
  );
  const changeText = useCallback(
    (value: string) => onChange({ kind: "custom", value }),
    [onChange],
  );
  const chooseOption = useCallback(
    (optionIndex: number) => onChange({ kind: "option", optionIndex }),
    [onChange],
  );
  return (
    <View style={styles.question}>
      <Text style={styles.title}>{question.header}</Text>
      <MarkdownRenderer text={question.question} />
      <SegmentedControl value={mode} options={modes} onValueChange={changeMode} />
      {mode === "custom" ? (
        <Field label="自填回答">
          <FormTextInput
            testID={`question-${index}-custom`}
            accessibilityLabel={`${question.header} 自填回答`}
            initialValue={answer?.kind === "custom" ? answer.value : ""}
            onChangeText={changeText}
            multiline
            editable={!disabled}
          />
        </Field>
      ) : null}
      {mode === "options" && !question.multiSelect ? (
        <SelectField
          label="选择回答"
          triggerTestID={`question-${index}-select`}
          value={answer?.kind === "option" ? answer.optionIndex : null}
          selectedDisplay={
            answer?.kind === "option" ? (question.options[answer.optionIndex] ?? null) : null
          }
          options={options}
          onChange={chooseOption}
          placeholder="选择回答"
          emptyText="暂无选项"
          disabled={disabled}
        />
      ) : null}
      {mode === "options" && question.multiSelect
        ? options.map((option) => (
            <QuestionMultiOption
              key={option.id}
              option={option}
              questionIndex={index}
              answer={answer}
              disabled={disabled}
              onChange={onChange}
            />
          ))
        : null}
    </View>
  );
}

function QuestionMultiOption({
  option,
  questionIndex,
  answer,
  disabled,
  onChange,
}: {
  option: QuestionOption;
  questionIndex: number;
  answer: Answer | undefined;
  disabled: boolean;
  onChange: (answer: Answer) => void;
}) {
  const toggle = useCallback(
    (selected: boolean) => {
      const indexes =
        answer?.kind === "multi"
          ? answer.optionIndexes.filter((item) => item !== option.value)
          : [];
      onChange({
        kind: "multi",
        optionIndexes: selected ? [...indexes, option.value] : indexes,
      });
    },
    [answer, onChange, option.value],
  );
  return (
    <View style={styles.option}>
      <View style={styles.grow}>
        <Text style={styles.body}>{option.label}</Text>
        {option.description ? <Text style={styles.muted}>{option.description}</Text> : null}
      </View>
      <Switch
        testID={`question-${questionIndex}-option-${option.value}`}
        accessibilityLabel={option.label}
        value={answer?.kind === "multi" && answer.optionIndexes.includes(option.value)}
        disabled={disabled}
        onValueChange={toggle}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  banner: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    alignItems: "flex-start",
  },
  form: { gap: theme.spacing[4] },
  question: {
    gap: theme.spacing[3],
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    paddingTop: theme.spacing[4],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  body: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  option: { flexDirection: "row", gap: theme.spacing[3], alignItems: "center" },
  grow: { flex: 1, minWidth: 0 },
}));
