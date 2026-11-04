import { useServerConfigs } from "./entities";
import { Alert } from "react-native";
import {
  questionAttachmentDraftKey,
  questionAttachmentDraftPrefix,
  questionAttachmentPreparationAtom,
} from "./question-attachments";
import { composerDraftsAtom, clearComposerDraft } from "./use-composer-drafts";
import {
  composerAttachmentUploadsAtom,
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
} from "./composer-attachment-uploads";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type EnvironmentId,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
} from "@starkfuture/contracts";
import {
  describeRuntimeResponseFailure,
  resolveRuntimeRequestOutcome,
  runtimeResponseAttemptsAtom,
  type RuntimeResponse,
  type RuntimeResponseAttempt,
} from "@starkfuture/client-runtime/state/runtime-request-response";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@starkfuture/client-runtime/state/runtime";
import * as Option from "effect/Option";
import type { ApprovalResponseInput } from "@starkfuture/client-runtime/approvals/permission-presentation";
import {
  type PendingThreadRequests,
  type ThreadUserInputQuestion,
  seedUserInputDraftAnswers,
} from "@starkfuture/client-runtime/state/thread-requests";
import { AuthOrchestrationOperateScope } from "@starkfuture/contracts";
import { Atom } from "effect/reactivity";

import { threadEnvironment } from "../state/threads";
import { scopedRequestKey } from "../lib/scopedEntities";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../lib/threadActivity";
import { appAtomRegistry } from "./atom-registry";
import {
  useSelectedThreadLostRequests,
  useSelectedThreadDetailState,
  useSelectedThreadPendingRequests,
} from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { useAtomCommand } from "./use-atom-command";
import { readEnvironmentScope } from "./session";

const EMPTY_PENDING_REQUESTS: PendingThreadRequests = { approvals: [], userInputs: [] };

const NO_RUNTIME_RESPONSE_ATTEMPTS = Atom.make<
  ReadonlyMap<RuntimeRequestId, RuntimeResponseAttempt>
>(new Map()).pipe(Atom.withLabel("mobile:runtime-response-attempts:empty"));

function runtimeResponseAttemptsFor(environmentId: EnvironmentId | null) {
  return environmentId === null
    ? NO_RUNTIME_RESPONSE_ATTEMPTS
    : runtimeResponseAttemptsAtom(environmentId);
}

const userInputDraftsByRequestKeyAtom = Atom.make<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:user-input-drafts"));

function setUserInputDraftOption(
  requestKey: string,
  question: ThreadUserInputQuestion,
  value: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [question.id]: togglePendingUserInputOptionSelection(
        question,
        current[requestKey]?.[question.id],
        value,
      ),
    },
  });
}

function setUserInputDraftCustomAnswer(
  requestKey: string,
  question: ThreadUserInputQuestion,
  customAnswer: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [question.id]: setPendingUserInputCustomAnswer(
        question,
        current[requestKey]?.[question.id],
        customAnswer,
      ),
    },
  });
}

export function useSelectedThreadRequests() {
  const respondToApproval = useAtomCommand(
    threadEnvironment.respondToApproval,
    "thread approval response",
  );
  const respondToUserInput = useAtomCommand(
    threadEnvironment.respondToUserInput,
    "thread user input response",
  );
  const dismissUserInput = useAtomCommand(
    threadEnvironment.dismissUserInput,
    "thread user input dismissal",
  );
  const askAgainLostRequests = useAtomCommand(
    threadEnvironment.askAgainLostRequests,
    "ask again for lost decisions",
  );
  const dismissLostRequests = useAtomCommand(
    threadEnvironment.dismissLostRequests,
    "lost decision dismissal",
  );
  const lostRequests = useSelectedThreadLostRequests();
  const [lostRequestsBusy, setLostRequestsBusy] = useState(false);
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const pendingRequests = useSelectedThreadPendingRequests();
  const runtimeResponseAttempts = useAtomValue(
    runtimeResponseAttemptsFor(selectedThreadShell?.environmentId ?? null),
  );
  // A failed answer is explained by the thread as it is when the failure arrives: only a live
  // projection that still holds the request says what became of it.
  const selectedThreadDetailState = useSelectedThreadDetailState();
  const requestTruthRef = useRef({
    threadStatus: selectedThreadDetailState.status,
    runtimeRequests: Option.getOrNull(selectedThreadDetailState.data)?.runtimeRequests ?? null,
  });
  useEffect(() => {
    requestTruthRef.current = {
      threadStatus: selectedThreadDetailState.status,
      runtimeRequests: Option.getOrNull(selectedThreadDetailState.data)?.runtimeRequests ?? null,
    };
  }, [selectedThreadDetailState.data, selectedThreadDetailState.status]);
  const alertResponseFailure = useCallback(
    (
      result: AtomCommandResult<unknown, unknown>,
      requestId: RuntimeRequestId,
      kind: RuntimeResponse["kind"],
    ) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const notice = describeRuntimeResponseFailure({
        error: squashAtomCommandFailure(result),
        kind,
        outcome: resolveRuntimeRequestOutcome({ ...requestTruthRef.current, requestId }),
      });
      Alert.alert(notice.title, notice.message);
    },
    [],
  );
  const userInputDraftsByRequestKey = useAtomValue(userInputDraftsByRequestKeyAtom);
  const userInputResponsesInFlight = useRef(new Set<string>());
  const [respondingApprovalId, setRespondingApprovalId] = useState<RuntimeRequestId | null>(null);
  const [respondingUserInputId, setRespondingUserInputId] = useState<RuntimeRequestId | null>(null);

  const activePendingApprovals = pendingRequests?.approvals ?? EMPTY_PENDING_REQUESTS.approvals;
  const activePendingApproval = activePendingApprovals[0] ?? null;
  const activePendingUserInputs = pendingRequests?.userInputs ?? EMPTY_PENDING_REQUESTS.userInputs;
  const activePendingUserInput = activePendingUserInputs[0] ?? null;
  useEffect(() => {
    if (!activePendingUserInput || !selectedThreadShell) return;
    const requestKey = scopedRequestKey(
      selectedThreadShell.environmentId,
      activePendingUserInput.requestId,
    );
    const existing = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
    const drafts = existing[requestKey] ?? {};
    const seeded = seedUserInputDraftAnswers(activePendingUserInput.questions, drafts);
    if (seeded !== drafts) {
      appAtomRegistry.set(userInputDraftsByRequestKeyAtom, { ...existing, [requestKey]: seeded });
    }
  }, [activePendingUserInput, selectedThreadShell]);
  const questionServerConfigs = useServerConfigs();
  const attachmentDrafts = useAtomValue(composerDraftsAtom);
  const preparationCounts = useAtomValue(questionAttachmentPreparationAtom);
  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  useEffect(() => {
    if (!selectedThreadShell || !pendingRequests) return;
    const prefix = questionAttachmentDraftPrefix(
      selectedThreadShell.environmentId,
      selectedThreadShell.id,
    );
    const retained = new Set(
      activePendingUserInputs.flatMap((request) =>
        request.questions.map((question) =>
          questionAttachmentDraftKey(
            selectedThreadShell.environmentId,
            selectedThreadShell.id,
            request.requestId,
            question.id,
          ),
        ),
      ),
    );
    const counts = { ...appAtomRegistry.get(questionAttachmentPreparationAtom) };
    let changed = false;
    for (const key of new Set([...Object.keys(attachmentDrafts), ...Object.keys(counts)])) {
      if (!key.startsWith(prefix) || retained.has(key)) continue;
      if (attachmentDrafts[key]) clearComposerDraft(key);
      if (key in counts) {
        delete counts[key];
        changed = true;
      }
    }
    if (changed) appAtomRegistry.set(questionAttachmentPreparationAtom, counts);
  }, [activePendingUserInputs, attachmentDrafts, pendingRequests, selectedThreadShell]);
  const activePendingUserInputDrafts =
    activePendingUserInput && selectedThreadShell
      ? Object.fromEntries(
          activePendingUserInput.questions.map((question) => {
            const key = questionAttachmentDraftKey(
              selectedThreadShell.environmentId,
              selectedThreadShell.id,
              activePendingUserInput.requestId,
              question.id,
            );
            const attachments = attachmentDrafts[key]?.attachments ?? [];
            const uploadInput = {
              environmentId: selectedThreadShell.environmentId,
              attachments,
              serverConfig: questionServerConfigs.get(selectedThreadShell.environmentId) ?? null,
              states: uploadStates,
            };
            return [
              question.id,
              {
                ...userInputDraftsByRequestKey[
                  scopedRequestKey(
                    selectedThreadShell.environmentId,
                    activePendingUserInput.requestId,
                  )
                ]?.[question.id],
                attachmentCount: attachments.length,
                attachmentsBlocked:
                  (attachments.length > 0 &&
                    questionServerConfigs.get(selectedThreadShell.environmentId)?.environment
                      .capabilities.questionAttachments !== true) ||
                  (preparationCounts[key] ?? 0) > 0 ||
                  composerAttachmentsStillUploading(uploadInput) ||
                  composerAttachmentUploadBlockReason({
                    ...uploadInput,
                    connected: true,
                  }) !== null,
              },
            ];
          }),
        )
      : {};
  const activePendingUserInputAnswers = activePendingUserInput
    ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingUserInputDrafts)
    : null;

  const onSelectUserInputOption = useCallback(
    (requestId: RuntimeRequestId, question: ThreadUserInputQuestion, value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      setUserInputDraftOption(requestKey, question, value);
    },
    [selectedThreadShell],
  );

  const onChangeUserInputCustomAnswer = useCallback(
    (requestId: RuntimeRequestId, questionId: string, customAnswer: string) => {
      const question = activePendingUserInputs
        .find((request) => request.requestId === requestId)
        ?.questions.find((entry) => entry.id === questionId);
      if (!selectedThreadShell || !question) {
        return;
      }

      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      setUserInputDraftCustomAnswer(requestKey, question, customAnswer);
    },
    [activePendingUserInputs, selectedThreadShell],
  );

  const onRespondToApproval = useCallback(
    async (
      requestId: RuntimeRequestId,
      decision: ProviderApprovalDecision,
      // The chosen option's id and any reason; the server refuses a decision it can't match.
      response?: ApprovalResponseInput,
    ) => {
      if (
        !selectedThreadShell ||
        !readEnvironmentScope(selectedThreadShell.environmentId, AuthOrchestrationOperateScope)
      ) {
        return;
      }
      if (
        activePendingApprovals.find((approval) => approval.requestId === requestId)
          ?.responseCapability !== "live"
      ) {
        return;
      }

      setRespondingApprovalId(requestId);
      const result = await respondToApproval({
        environmentId: selectedThreadShell.environmentId,
        input: {
          threadId: selectedThreadShell.id,
          requestId,
          decision,
          ...response,
        },
      });
      alertResponseFailure(result, requestId, "approval");
      setRespondingApprovalId((current) => (current === requestId ? null : current));
      return result;
    },
    [activePendingApprovals, alertResponseFailure, respondToApproval, selectedThreadShell],
  );

  const onSubmitUserInput = useCallback(async () => {
    if (
      !selectedThreadShell ||
      !activePendingUserInput ||
      activePendingUserInput.responseCapability === "not_resumable" ||
      !activePendingUserInputAnswers ||
      !readEnvironmentScope(selectedThreadShell.environmentId, AuthOrchestrationOperateScope)
    ) {
      return;
    }

    const responseKey = questionAttachmentDraftKey(
      selectedThreadShell.environmentId,
      selectedThreadShell.id,
      activePendingUserInput.requestId,
      "",
    );
    if (userInputResponsesInFlight.current.has(responseKey)) return;
    const attachmentsByQuestionId = new Map<
      string,
      import("@starkfuture/contracts").UserInputAttachments[string]
    >();
    for (const question of activePendingUserInput.questions) {
      const key = questionAttachmentDraftKey(
        selectedThreadShell.environmentId,
        selectedThreadShell.id,
        activePendingUserInput.requestId,
        question.id,
      );
      if ((appAtomRegistry.get(questionAttachmentPreparationAtom)[key] ?? 0) > 0) return;
      const attachments = appAtomRegistry.get(composerDraftsAtom)[key]?.attachments ?? [];
      if (attachments.length === 0) continue;
      if (
        attachments.some(
          (attachment) =>
            !attachment.uploadedAttachmentId ||
            attachment.uploadEnvironmentId !== selectedThreadShell.environmentId,
        )
      ) {
        Alert.alert(
          "Attachments are not ready",
          "Wait for uploads to finish, or retry failed uploads.",
        );
        return;
      }
      attachmentsByQuestionId.set(
        question.id,
        attachments.map((attachment) => ({
          type: attachment.type,
          id: attachment.uploadedAttachmentId!,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        })),
      );
    }
    userInputResponsesInFlight.current.add(responseKey);
    setRespondingUserInputId(activePendingUserInput.requestId);
    const result = await respondToUserInput({
      environmentId: selectedThreadShell.environmentId,
      input: {
        threadId: selectedThreadShell.id,
        requestId: activePendingUserInput.requestId,
        answers: activePendingUserInputAnswers,
        ...(attachmentsByQuestionId.size > 0
          ? { attachmentsByQuestionId: Object.fromEntries(attachmentsByQuestionId) }
          : {}),
      },
    });
    alertResponseFailure(result, activePendingUserInput.requestId, "user-input");
    userInputResponsesInFlight.current.delete(responseKey);
    setRespondingUserInputId((current) =>
      current === activePendingUserInput.requestId ? null : current,
    );
    return result;
  }, [
    activePendingUserInput,
    activePendingUserInputAnswers,
    alertResponseFailure,
    respondToUserInput,
    selectedThreadShell,
  ]);

  // Closes an async question without messaging the agent.
  const onDismissUserInput = useCallback(async () => {
    if (
      !selectedThreadShell ||
      !activePendingUserInput ||
      !readEnvironmentScope(selectedThreadShell.environmentId, AuthOrchestrationOperateScope)
    ) {
      return;
    }

    setRespondingUserInputId(activePendingUserInput.requestId);
    const result = await dismissUserInput({
      environmentId: selectedThreadShell.environmentId,
      input: {
        threadId: selectedThreadShell.id,
        requestId: activePendingUserInput.requestId,
      },
    });
    alertResponseFailure(result, activePendingUserInput.requestId, "dismiss");
    setRespondingUserInputId((current) =>
      current === activePendingUserInput.requestId ? null : current,
    );
    return result;
  }, [activePendingUserInput, alertResponseFailure, dismissUserInput, selectedThreadShell]);

  // Sends an answer that could not be confirmed again under its original command, so an answer
  // that already landed is confirmed instead of rejected as answered.
  const onRetryRuntimeResponse = useCallback(
    async (requestId: RuntimeRequestId) => {
      const attempt = runtimeResponseAttempts.get(requestId);
      if (
        !selectedThreadShell ||
        attempt?.phase !== "unconfirmed" ||
        !readEnvironmentScope(selectedThreadShell.environmentId, AuthOrchestrationOperateScope)
      ) {
        return;
      }
      const environmentId = selectedThreadShell.environmentId;
      const setResponding =
        attempt.kind === "approval" ? setRespondingApprovalId : setRespondingUserInputId;
      setResponding(requestId);
      const result =
        attempt.kind === "approval"
          ? await respondToApproval({
              environmentId,
              input: { ...attempt.input, commandId: attempt.commandId },
            })
          : attempt.kind === "user-input"
            ? await respondToUserInput({
                environmentId,
                input: { ...attempt.input, commandId: attempt.commandId },
              })
            : await dismissUserInput({
                environmentId,
                input: { ...attempt.input, commandId: attempt.commandId },
              });
      alertResponseFailure(result, requestId, attempt.kind);
      setResponding((current) => (current === requestId ? null : current));
    },
    [
      alertResponseFailure,
      dismissUserInput,
      respondToApproval,
      respondToUserInput,
      runtimeResponseAttempts,
      selectedThreadShell,
    ],
  );

  // Ask again and Dismiss act only on the requests named; a single card button names one.
  const onLostRequests = useCallback(
    async (
      action: "ask-again" | "dismiss",
      requestIds: readonly [RuntimeRequestId, ...RuntimeRequestId[]],
    ) => {
      if (
        !selectedThreadShell ||
        !readEnvironmentScope(selectedThreadShell.environmentId, AuthOrchestrationOperateScope)
      ) {
        return;
      }
      setLostRequestsBusy(true);
      const run = action === "ask-again" ? askAgainLostRequests : dismissLostRequests;
      const result = await run({
        environmentId: selectedThreadShell.environmentId,
        input: { threadId: selectedThreadShell.id, requestIds },
      });
      setLostRequestsBusy(false);
      return result;
    },
    [askAgainLostRequests, dismissLostRequests, selectedThreadShell],
  );
  const onAskAgainLostRequests = useCallback(
    (requestIds: readonly [RuntimeRequestId, ...RuntimeRequestId[]]) =>
      onLostRequests("ask-again", requestIds),
    [onLostRequests],
  );
  const onDismissLostRequests = useCallback(
    (requestIds: readonly [RuntimeRequestId, ...RuntimeRequestId[]]) =>
      onLostRequests("dismiss", requestIds),
    [onLostRequests],
  );

  return {
    activePendingApproval,
    activePendingUserInput,
    activePendingUserInputDrafts,
    activePendingUserInputAnswers,
    respondingApprovalId,
    respondingUserInputId,
    runtimeResponseAttempts,
    onRespondToApproval,
    onRetryRuntimeResponse,
    onSelectUserInputOption,
    onChangeUserInputCustomAnswer,
    onSubmitUserInput,
    onDismissUserInput,
    lostRequests,
    lostRequestsBusy,
    onAskAgainLostRequests,
    onDismissLostRequests,
  };
}
