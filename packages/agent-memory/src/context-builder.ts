import type { AgentMessage } from "@agent-workbench/agent-core";
import { validateAgentMessages } from "@agent-workbench/agent-core";
import { failContext } from "./errors.js";
import {
  estimateContextBytes,
  parseBuildOptions,
  renderMemoryMessage,
} from "./context-validation.js";
import type { BuildContextOptions, BuildContextResult } from "./types.js";

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function messageHasToolResult(message: AgentMessage): boolean {
  return message.content.some((c) => c.type === "tool_result");
}

function messageHasToolCall(message: AgentMessage): boolean {
  return message.content.some((c) => c.type === "tool_call");
}

/**
 * Groups messages so an assistant tool_call and its contiguous tool results
 * form one indivisible unit. System messages and the last user message (and
 * everything after it) are protected.
 */
interface HistoryUnit {
  readonly index: number;
  readonly messages: readonly AgentMessage[];
  readonly protected: boolean;
}

function buildUnits(messages: readonly AgentMessage[]): HistoryUnit[] {
  const lastUserIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === "user") return i;
    }
    return -1;
  })();

  const units: HistoryUnit[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i] as AgentMessage;
    const isSystem = message.role === "system";
    const isProtected =
      isSystem ||
      (lastUserIndex >= 0 && i >= lastUserIndex) ||
      messageHasToolResult(message);

    if (messageHasToolCall(message) && message.role === "assistant") {
      const group: AgentMessage[] = [message];
      let j = i + 1;
      while (j < messages.length && messages[j]?.role === "tool") {
        group.push(messages[j] as AgentMessage);
        j += 1;
      }
      // A tool_call group that starts at or after the last user is protected.
      const groupProtected = isSystem || (lastUserIndex >= 0 && i >= lastUserIndex);
      units.push({ index: i, messages: group, protected: groupProtected });
      i = j;
      continue;
    }

    units.push({ index: i, messages: [message], protected: isProtected });
    i += 1;
  }
  return units;
}

function unitBytes(messages: readonly AgentMessage[]): number {
  return estimateContextBytes(messages);
}

async function runSummarizer(
  summarizer: BuildContextOptions["summarizer"],
  omitted: readonly AgentMessage[],
  signal: AbortSignal | undefined,
  maxSummaryBytes: number,
): Promise<string> {
  if (summarizer === undefined) {
    failContext("compressionRequired");
  }

  const pending = Promise.resolve(
    summarizer.summarize(
      { messages: structuredClone(omitted), omittedMessageCount: omitted.length },
      signal,
    ),
  );
  // Always consume so a late reject cannot become unhandled.
  pending.then(undefined, () => undefined);

  if (signal === undefined) {
    let text: string;
    try {
      text = await pending;
    } catch {
      failContext("compressionFailed");
    }
    return validateSummary(text, maxSummaryBytes);
  }

  const raced = await Promise.race([
    pending.then(
      (text) => ({ kind: "ok" as const, text }),
      () => ({ kind: "err" as const }),
    ),
    new Promise<{ kind: "abort" }>((resolve) => {
      if (signal.aborted) {
        resolve({ kind: "abort" });
        return;
      }
      signal.addEventListener("abort", () => resolve({ kind: "abort" }), {
        once: true,
      });
    }),
  ]);

  if (raced.kind === "abort") {
    failContext("aborted");
  }
  if (raced.kind === "err") {
    failContext("compressionFailed");
  }
  return validateSummary(raced.text, maxSummaryBytes);
}

function validateSummary(text: unknown, maxSummaryBytes: number): string {
  if (typeof text !== "string" || text.length === 0) {
    failContext("summaryInvalid");
  }
  if (Buffer.byteLength(text, "utf8") > maxSummaryBytes) {
    failContext("summaryTooLarge");
  }
  return text;
}

export async function buildContext(
  options: BuildContextOptions,
): Promise<BuildContextResult> {
  const parsed = parseBuildOptions(options);

  if (isAborted(parsed.signal)) {
    failContext("aborted");
  }

  const memoryMessage =
    parsed.memoryEntries.length > 0 ? [renderMemoryMessage(parsed.memoryEntries)] : [];

  const assembled: AgentMessage[] = [...memoryMessage, ...parsed.messages];
  const fullBytes = estimateContextBytes(assembled);

  if (fullBytes <= parsed.maxContextBytes) {
    return {
      messages: structuredClone(assembled),
      compressed: false,
      summaryIncluded: false,
      omittedMessageCount: 0,
      includedMemoryIds: parsed.memoryEntries.map((e) => e.id),
      contextBytes: fullBytes,
    };
  }

  const units = buildUnits(parsed.messages);
  const protectedUnits = units.filter((u) => u.protected);
  const compressible = units.filter((u) => !u.protected);

  // Protected region (system + last user + tool groups that touch the tail)
  // must fit on its own, otherwise the budget cannot be met.
  const protectedMessages = protectedUnits.flatMap((u) => u.messages);
  const summaryOverheadEstimate = estimateContextBytes([
    {
      role: "system",
      content: [{ type: "text", text: `[Context summary]\n` }],
    } as AgentMessage,
  ]);
  const protectedBytes =
    estimateContextBytes([...memoryMessage, ...protectedMessages]) +
    summaryOverheadEstimate;
  if (protectedBytes > parsed.maxContextBytes) {
    failContext("contextBudgetExceeded");
  }

  if (compressible.length === 0) {
    // Only protected messages exist and they exceed budget (already checked),
    // or everything is protected but still over â€?cannot compress further.
    failContext("contextBudgetExceeded");
  }

  // Keep most recent compressible units first; drop oldest until we fit.
  // Reserve space for the summary system message that will be inserted.
  const summaryOverhead = estimateContextBytes([
    {
      role: "system",
      content: [{ type: "text", text: `[Context summary]\n` }],
    } as AgentMessage,
  ]);
  const budgetForHistory = parsed.maxContextBytes - summaryOverhead;
  const keptCompressible: HistoryUnit[] = [];
  const omittedUnits: HistoryUnit[] = [];
  for (let i = compressible.length - 1; i >= 0; i -= 1) {
    const unit = compressible[i] as HistoryUnit;
    const ordered = [...units]
      .filter(
        (u) =>
          u.protected ||
          keptCompressible.includes(u) ||
          u === unit,
      )
      .flatMap((u) => u.messages);
    const withMemory = [...memoryMessage, ...ordered];
    if (estimateContextBytes(withMemory) <= budgetForHistory) {
      keptCompressible.unshift(unit);
    } else {
      omittedUnits.unshift(unit);
    }
  }

  if (omittedUnits.length === 0) {
    // Should not happen if fullBytes exceeded, but stay safe.
    failContext("contextBudgetExceeded");
  }

  const omittedMessages = omittedUnits.flatMap((u) => u.messages);
  const summary = await runSummarizer(
    parsed.summarizer,
    omittedMessages,
    parsed.signal,
    parsed.maxSummaryBytes,
  );

  const summaryMessage: AgentMessage = {
    role: "system",
    content: [{ type: "text", text: `[Context summary]\n${summary}` }],
  };

  const finalOrdered = [...units]
    .filter((u) => u.protected || keptCompressible.includes(u))
    .flatMap((u) => u.messages);

  const finalMessages: AgentMessage[] = [
    ...memoryMessage,
    summaryMessage,
    ...finalOrdered,
  ];

  try {
    validateAgentMessages(finalMessages);
  } catch {
    failContext("invalidMessages");
  }

  const finalBytes = estimateContextBytes(finalMessages);
  if (finalBytes > parsed.maxContextBytes) {
    failContext("contextBudgetExceeded");
  }

  return {
    messages: structuredClone(finalMessages),
    compressed: true,
    summaryIncluded: true,
    omittedMessageCount: omittedMessages.length,
    includedMemoryIds: parsed.memoryEntries.map((e) => e.id),
    contextBytes: finalBytes,
  };
}
