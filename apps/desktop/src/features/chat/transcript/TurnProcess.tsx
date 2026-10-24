import type { SubagentOutcome } from "../../../lib/subagent-topology";
import { useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AssistantTurnPart } from "../../../lib/assistant-turns";
import { formatToolDuration } from "../../../lib/tool-display";
import { cachedActivitySummary, cachedVisibleProcessSteps } from "../../../lib/transcript-activity-summary";
import { TranscriptSearchContext } from "../../../lib/transcript-search-context";
import {
  isTurnThinking,
  processContainsMessage,
  turnProcessTiming,
} from "../../../lib/turn-process";
import { resolveShowThinking } from "../../../lib/thinking-visibility";
import { useAppStore } from "../../../stores/app-store";
import {
  IconChevronRight,
  IconCircleAlert,
  IconSparkles,
} from "../../../components/icons";
import { ActivityLabel } from "./ActivityLabel";
import { DisclosureCollapseRail } from "./shared";
import { useFoldOpening } from "./useFoldOpening";
import { DisclosureScope, disclosureKey, useAutomaticDisclosure } from "./disclosure";

export function TurnProcess({
  turnId,
  processParts,
  turnParts,
  delegationStatuses,
  isActive,
  turnRunning,
  children,
}: {
  turnId: string;
  processParts: readonly AssistantTurnPart[];
  turnParts: readonly AssistantTurnPart[];
  /** The process owns the turn's live tail: drives the header, timer and live thinking. */
  isActive: boolean;
  /** The turn is still running: drives the automatic open state. */
  turnRunning: boolean;
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const showThinking = useAppStore((state) => resolveShowThinking(state.settings));
  const search = useContext(TranscriptSearchContext);
  const revealRequest = useMemo(() => search && processContainsMessage(processParts, search.messageId)
    ? search.requestId : undefined, [processParts, search]);
  const summary = useMemo(() => cachedActivitySummary(
    processParts.flatMap((part) => part.kind === "activity" ? part.items : []), delegationStatuses,
  ), [processParts, delegationStatuses]);
  const thinkingNow = useMemo(() => isTurnThinking(turnParts, isActive), [turnParts, isActive]);
  const visibleSteps = useMemo(() => cachedVisibleProcessSteps(processParts, !showThinking, isActive), [processParts, showThinking, isActive]);
  // The process of a running turn stays open and an untouched one closes when
  // the turn ends; an explicit user choice stays authoritative. Openness
  // follows the turn rather than its tail, so text streamed between tool
  // calls does not fold the process and unfold it on the next call. This does
  // not depend on the thinking preference, and a recorded failure keeps an
  // untouched process open through recovery until the turn ends.
  const disclosure = useAutomaticDisclosure(
    turnRunning,
    revealRequest,
    disclosureKey("turn", turnId),
  );
  const detailsId = useId();
  const fold = useFoldOpening();
  const [now, setNow] = useState(Date.now);
  const { startedAt, endedAt } = useMemo(() => turnProcessTiming(turnParts), [turnParts]);
  useEffect(() => {
    if (!isActive) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive]);
  if (visibleSteps === 0) return null;
  const seconds = startedAt === undefined ? 0 : Math.max(
    0, Math.floor(((isActive ? now : (endedAt ?? startedAt)) - startedAt) / 1000),
  );
  return (
    <section
      className={`turn-process${disclosure.open ? " open" : ""}${isActive ? " active" : ""}`}
      data-fold-opening={fold.opening ? "" : undefined}
    >
      <button
        type="button"
        ref={disclosure.titleRef}
        className="tool-activity-header"
        aria-expanded={disclosure.open}
        aria-controls={detailsId}
        onClick={() => {
          if (!disclosure.open) fold.markOpening();
          disclosure.toggle();
        }}
      >
        <span className="tool-activity-icon" aria-hidden><IconSparkles size={14} /></span>
        <ActivityLabel
          running={isActive}
          text={t(isActive ? thinkingNow ? "chat.thinkingFor" : "chat.processingFor" : "chat.processedFor", {
            time: formatToolDuration(seconds),
          })}
        />
        {summary.issues > 0 ? (
          <span className="turn-process-error">
            <IconCircleAlert size={14} aria-hidden />
            {t("chat.activityFailures", { count: summary.issues })}
          </span>
        ) : null}
        {summary.tools > 0 ? (
          <span className="tool-activity-count">{t("chat.processTools", { count: summary.tools })}</span>
        ) : null}
        <span className="tool-activity-caret" aria-hidden><IconChevronRight size={12} /></span>
      </button>
      <div
        ref={disclosure.bodyRef}
        id={detailsId}
        className="turn-process-body"
        hidden={!disclosure.open}
        inert={!disclosure.open}
        {...disclosure.bodyEvents}
      >
        <DisclosureCollapseRail label={t("chat.collapseProcess")} onCollapse={disclosure.collapse} />
        <div className="turn-process-fold">
          <DisclosureScope disclosure={disclosure}>{children}</DisclosureScope>
        </div>
      </div>
    </section>
  );
}
