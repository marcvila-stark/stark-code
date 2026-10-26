import { parseScopedThreadKey } from "@starkfuture/client-runtime/environment";
import { AuthOrchestrationOperateScope } from "@starkfuture/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useServerConfigs, useThreadShells } from "../../state/entities";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { forgetLegacySideWorkRecord, readSideWorkRecords } from "./sideWork.logic";

const LEGACY_PREFIX = "stark-code:side-work:";

function legacyKeys() {
  try {
    return Object.keys(localStorage).filter(
      (key) =>
        key.startsWith(LEGACY_PREFIX) &&
        readSideWorkRecords(localStorage.getItem(key)).some((record) => record.kind === "question"),
    );
  } catch {
    return [];
  }
}

/** Upgrade exact legacy links, never infer a parent from a similar chat title. */
export function SideChatMigration() {
  const threads = useThreadShells();
  const configs = useServerConfigs();
  const [keys, setKeys] = useState(legacyKeys);
  const connected = useConnectedEnvironmentIds();
  const environments = useMemo(
    () => connected.map((environmentId) => ({ environmentId })),
    [connected],
  );
  const permitted = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const attempted = useRef(new Map<string, string>());

  useEffect(() => {
    const refresh = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(LEGACY_PREFIX)) setKeys(legacyKeys());
    };
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, []);

  useEffect(() => {
    for (const [key, environmentId] of attempted.current) {
      if (!connected.some((id) => id === environmentId)) attempted.current.delete(key);
    }
    for (const key of keys) {
      const parent = parseScopedThreadKey(key.slice(LEGACY_PREFIX.length));
      if (
        !parent ||
        !threads.some(
          (thread) =>
            thread.environmentId === parent.environmentId && thread.id === parent.threadId,
        ) ||
        !permitted.has(parent.environmentId) ||
        configs.get(parent.environmentId)?.environment.capabilities.threadSideChats !== true
      )
        continue;
      const records = readSideWorkRecords(localStorage.getItem(key));
      for (const record of records) {
        if (record.kind !== "question") continue;
        const child = threads.find(
          (thread) =>
            thread.environmentId === parent.environmentId && thread.id === record.threadId,
        );
        if (
          child?.lineage.relationshipToParent === "side_chat" &&
          child.lineage.parentThreadId === parent.threadId
        ) {
          // A successful command alone is not proof: an older server can strip unknown fields.
          forgetLegacySideWorkRecord(localStorage, key, record.threadId);
          continue;
        }
        if (
          child &&
          child.lineage.relationshipToParent !== null &&
          !(
            child.lineage.relationshipToParent === "side_chat" &&
            child.lineage.parentThreadId === parent.threadId
          )
        )
          continue;
        const attemptKey = `${key}:${record.threadId}`;
        if (attempted.current.has(attemptKey)) continue;
        attempted.current.set(attemptKey, parent.environmentId);
        void updateMetadata({
          environmentId: parent.environmentId,
          input: { threadId: record.threadId, sideChatParentThreadId: parent.threadId },
        });
      }
      if (
        !readSideWorkRecords(localStorage.getItem(key)).some((record) => record.kind === "question")
      ) {
        setKeys((current) => current.filter((entry) => entry !== key));
      }
    }
  }, [threads, connected, permitted, updateMetadata, configs, keys]);
  return null;
}
