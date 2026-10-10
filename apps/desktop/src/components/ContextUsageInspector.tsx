import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { portalToBody } from "../lib/portal-visibility";
import { useTranslation } from "react-i18next";
import {
  formatCompactTokenCount,
  type MessageUsage,
  type UiMessage,
} from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { useHoverMenu } from "../hooks/use-hover-menu";
import {
  aggregateToolTokenUsage,
  calculateCacheRate,
  calculateContextUsage,
  calculateTokenRate,
  contextOccupancyTokens,
  contextUsageView,
  resolveContextUsageDisplay,
} from "../lib/context-usage";
import {
  placeContextInspector,
  type ContextInspectorPlacement,
} from "../lib/context-inspector-position";

const CONTEXT_RING_RADIUS = 9;
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS;

export function ContextUsageInspector({
  usage,
  turnUsage,
  contextWindow,
  compactionThreshold,
  tools,
  responseDurationMs,
  responseOutputTokens,
  responseOutputEstimated = false,
}: {
  usage: MessageUsage;
  turnUsage: MessageUsage;
  contextWindow: number;
  /** Context size at which the runtime compacts on its own; none to draw if absent. */
  compactionThreshold?: number;
  tools: UiMessage[];
  responseDurationMs?: number;
  responseOutputTokens?: number;
  responseOutputEstimated?: boolean;
}) {
  const { t } = useTranslation();
  const panelId = useId();
  // The transcript shows one row per compaction; the inspector adds what those
  // rows cannot — how much of the model context the newest summary occupies.
  const compaction = useAppStore((state) =>
    state.activeSessionId
      ? state.sessionCompactions[state.activeSessionId]?.at(-1)
      : undefined,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Resting on the ring shows the panel; a click pins it, for a reader who
  // wants it to stay while the pointer goes elsewhere, or has no pointer.
  const hover = useHoverMenu();
  const [pinned, setPinned] = useState(false);
  const open = hover.open || pinned;
  const [popoverPosition, setPopoverPosition] =
    useState<ContextInspectorPlacement | null>(null);
  const context = calculateContextUsage(usage, contextWindow);
  // The display preference flips the leading figure only; capacity colors
  // still follow remaining space so the warning state keeps one meaning.
  const usageDisplay = useAppStore((state) =>
    resolveContextUsageDisplay(state.settings?.contextUsageDisplay),
  );
  const display = contextUsageView(context, usageDisplay);
  // Occupancy, turn total, and provider cache/input/output are the last
  // model request. Summing every tool-loop call inflates cache read past
  // the window (OpenCode last-message accounting).
  const turnTotal = contextOccupancyTokens(usage);
  const throughput = calculateTokenRate(
    responseOutputTokens ?? turnUsage.outputTokens,
    responseDurationMs,
  );
  const cacheRate = calculateCacheRate(
    usage.inputTokens,
    usage.cacheReadTokens,
  );
  const toolRows = aggregateToolTokenUsage(tools);
  const toolTotal = toolRows.reduce(
    (total, row) => total + row.totalTokens,
    0,
  );
  // Shares for the bars, each a whole percent of the thing it sits in.
  const share = (part: number, whole: number) =>
    whole > 0 && part > 0 ? Math.min(100, Math.max(1, Math.round((part / whole) * 100))) : 0;
  const toolShare = share(toolTotal, context.usedTokens);
  const inputShare = share(usage.inputTokens, usage.inputTokens + usage.outputTokens);
  const compactionShare = compaction ? share(compaction.summaryTokens, contextWindow) : 0;
  // Where on the window the runtime compacts, and how far the context is
  // from it. A threshold at or past the window has nothing to mark.
  const threshold =
    compactionThreshold !== undefined &&
    compactionThreshold > 0 &&
    compactionThreshold < contextWindow
      ? compactionThreshold
      : undefined;
  const thresholdPercent =
    threshold !== undefined ? Math.round((threshold / contextWindow) * 1000) / 10 : 0;
  const untilCompaction = threshold !== undefined ? threshold - context.usedTokens : 0;
  const level =
    context.remainingPercent <= 10
      ? "critical"
      : context.remainingPercent <= 25
        ? "warning"
        : "comfortable";
  // One accessible sentence serves both display modes: the localized `state`
  // phrase carries "remaining"/"used", so the key stays literal for the
  // tooltip contract while `percent`/`count` stay numeric.
  const ariaArguments = {
    percent: display.percent,
    count: formatCompactTokenCount(display.tokens),
    state:
      display.display === "used"
        ? t("chat.usageContextAriaUsed")
        : t("chat.usageContextAriaRemaining"),
  };

  const closeInspector = useCallback(() => {
    setPinned(false);
    hover.close();
    setPopoverPosition(null);
  }, [hover.close]);

  const toggleInspector = useCallback(() => {
    setPinned((previous) => {
      if (previous) {
        hover.close();
        setPopoverPosition(null);
      }
      return !previous;
    });
  }, [hover.close]);

  // A panel that closed on its own must not reopen at its old position.
  useEffect(() => {
    if (!open) setPopoverPosition(null);
  }, [open]);

  const updatePopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;

    const triggerRect = trigger.getBoundingClientRect();
    const triggerVisible =
      triggerRect.bottom > 0 && triggerRect.top < window.innerHeight;
    if (!triggerVisible) {
      closeInspector();
      return;
    }
    const popoverRect = popover.getBoundingClientRect();
    // Clamp against the conversation pane rather than the viewport: the pane
    // ends where the work panel begins, and the panel's native browser/plugin
    // surfaces composite above every renderer layer, so whatever part of the
    // popover crosses that edge is covered whatever z-index it carries (D357).
    const paneRect = trigger.closest(".main-pane")?.getBoundingClientRect();
    const placement = placeContextInspector({
      trigger: {
        left: triggerRect.left,
        top: triggerRect.top,
        bottom: triggerRect.bottom,
      },
      popover: { width: popoverRect.width, height: popoverRect.height },
      pane: paneRect ? { left: paneRect.left, right: paneRect.right } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    if (!placement) {
      closeInspector();
      return;
    }

    setPopoverPosition((previous) =>
      previous?.top === placement.top &&
      previous.left === placement.left &&
      previous.maxWidth === placement.maxWidth
        ? previous
        : placement,
    );
  }, [closeInspector]);

  useLayoutEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(updatePopoverPosition);
    return () => window.cancelAnimationFrame(frame);
  }, [
    compaction,
    context.usedTokens,
    contextWindow,
    open,
    toolRows.length,
    toolTotal,
    turnTotal,
    throughput,
    updatePopoverPosition,
  ]);

  useEffect(() => {
    if (!open) return;
    const handleViewportChange = () => updatePopoverPosition();
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [open, updatePopoverPosition]);

  useEffect(() => {
    if (!open || !popoverRef.current || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updatePopoverPosition);
    observer.observe(popoverRef.current);
    return () => observer.disconnect();
  }, [open, updatePopoverPosition]);

  // Sidebar toggle/resize, work-panel open/resize, and the panel's entrance
  // animation all move the pane's right edge without emitting a window resize
  // or a scroll event (#246). A stale clamp would leave part of the popover
  // under the panel's native surfaces, so the open popover observes the pane
  // and re-runs placement whenever its box changes.
  useEffect(() => {
    if (!open || typeof ResizeObserver === "undefined") return;
    const pane = triggerRef.current?.closest(".main-pane");
    if (!pane) return;
    const observer = new ResizeObserver(updatePopoverPosition);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [open, updatePopoverPosition]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (
        triggerRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
      ) {
        return;
      }
      closeInspector();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeInspector();
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeInspector, open]);

  const popover = open ? (
    <div
      ref={popoverRef}
      className={`context-inspector-popover${popoverPosition ? " is-open" : ""}`}
      data-level={level}
      id={panelId}
      role="dialog"
      aria-label={t("chat.usageContextLabel")}
      style={
        popoverPosition
          ? {
              top: `${popoverPosition.top}px`,
              left: `${popoverPosition.left}px`,
              maxWidth: `${popoverPosition.maxWidth}px`,
            }
          : undefined
      }
    >
      <div className="context-inspector-heading">
        <strong className="context-inspector-heading-value">
          {t("chat.usageContextCapacity")}
        </strong>
        <span className="context-inspector-heading-percent">
          {t("chat.usageContextUsedRemaining", {
            used: context.usedPercent,
            remaining: context.remainingPercent,
          })}
        </span>
      </div>
      {/* One bar for the whole window, read like a storage meter: the filled
          part is what is used, its paler head the share tools put there. */}
      <div className="context-inspector-capacity" aria-hidden="true">
        <span
          className="context-inspector-capacity-used"
          style={{ width: `${Math.max(context.usedTokens > 0 ? 1 : 0, context.usedPercent)}%` }}
        >
          {toolShare > 0 ? (
            <span
              className="context-inspector-capacity-tools"
              style={{ width: `${toolShare}%` }}
            />
          ) : null}
        </span>
        {threshold !== undefined ? (
          <span
            className="context-inspector-capacity-threshold"
            style={{ insetInlineStart: `${thresholdPercent}%` }}
          />
        ) : null}
      </div>
      <div className="context-inspector-window">
        <span>
          <strong>{formatCompactTokenCount(context.usedTokens)}</strong>{" "}
          {t("chat.usageContextUsedLabel")}
        </span>
        <span className="context-inspector-window-percent">
          {t("chat.usageContextRemainingOfWindow", {
            remaining: formatCompactTokenCount(context.remainingTokens),
            window: formatCompactTokenCount(contextWindow),
          })}
        </span>
      </div>
      <div className="context-inspector-kpis">
        <div>
          <span>{t("chat.usageTurnTotal")}</span>
          <strong>{formatCompactTokenCount(turnTotal)}</strong>
        </div>
        <div data-kpi="throughput">
          <span>{t("chat.usageThroughputLabel")}</span>
          <strong>
            {throughput === undefined
              ? t("chat.usageThroughputUnavailable")
              : t(
                  responseOutputEstimated
                    ? "chat.usageThroughputEstimated"
                    : "chat.usageThroughput",
                  {
                    count: formatCompactTokenCount(throughput),
                  },
                )}
          </strong>
        </div>
      </div>
      <div className="context-inspector-summary">
        <div className="context-inspector-summary-row">
          <strong>{t("chat.usageProviderUsage")}</strong>
          <span className="context-inspector-bar" data-bar="model" aria-hidden="true">
            <span style={{ width: `${inputShare}%` }} />
          </span>
          <span className="context-inspector-summary-values">
            <span>
              {t("chat.usageInput")} {formatCompactTokenCount(usage.inputTokens)}
            </span>
            <span data-figure="output">
              {t("chat.usageOutput")} {formatCompactTokenCount(usage.outputTokens)}
            </span>
            {usage.cacheReadTokens !== undefined ? (
              <span>
                {t("chat.usageCacheRead")} {formatCompactTokenCount(usage.cacheReadTokens)}
              </span>
            ) : null}
            {cacheRate !== undefined ? (
              <span>
                {t("chat.usageCacheRate")} {cacheRate}%
              </span>
            ) : null}
            {usage.cacheWriteTokens !== undefined ? (
              <span>
                {t("chat.usageCacheWrite")} {formatCompactTokenCount(usage.cacheWriteTokens)}
              </span>
            ) : null}
            {usage.reasoningTokens !== undefined ? (
              <span>
                {t("chat.usageReasoning")} {formatCompactTokenCount(usage.reasoningTokens)}
              </span>
            ) : null}
          </span>
        </div>
        <div className="context-inspector-summary-row">
          <strong>{t("chat.usageTools")}</strong>
          <span className="context-inspector-bar" data-bar="tools" aria-hidden="true">
            <span style={{ width: `${toolShare}%` }} />
          </span>
          <span className="context-inspector-summary-values">
            {toolRows.length > 0
              ? t("chat.usageToolsSummary", {
                  count: toolRows.length,
                  calls: tools.length,
                  tokens: formatCompactTokenCount(toolTotal),
                })
              : t("chat.usageNoTools")}
          </span>
        </div>
        {threshold !== undefined ? (
          <div className="context-inspector-summary-row">
            <strong>{t("chat.usageAutoCompaction")}</strong>
            <span className="context-inspector-bar" data-bar="threshold" aria-hidden="true">
              <span style={{ width: `${Math.min(100, context.usedPercent)}%` }} />
              <i style={{ insetInlineStart: `${thresholdPercent}%` }} />
            </span>
            <span
              className="context-inspector-summary-values"
              data-over={untilCompaction <= 0 ? "true" : undefined}
            >
              <span>
                {t("chat.usageCompactionThreshold", {
                  count: formatCompactTokenCount(threshold),
                })}
              </span>
              <span>
                {untilCompaction > 0
                  ? t("chat.usageUntilCompaction", {
                      count: formatCompactTokenCount(untilCompaction),
                    })
                  : t("chat.usageCompactionDue")}
              </span>
            </span>
          </div>
        ) : null}
        {compaction ? (
          <div className="context-inspector-summary-row">
            <strong>{t("chat.usageCompaction", { times: compaction.generation })}</strong>
            <span className="context-inspector-bar" data-bar="compaction" aria-hidden="true">
              <span style={{ width: `${compactionShare}%` }} />
            </span>
            <span
              className="context-inspector-summary-values"
              title={compaction.summarized && !compaction.fallback && compaction.summary?.trim() ? compaction.summary : undefined}
            >
              ~{formatCompactTokenCount(compaction.summaryTokens)}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  ) : null;

  return (
    <div
      className="context-inspector"
      data-level={level}
      data-open={open ? "true" : "false"}
      {...hover.anchorProps}
    >
      {/* No tooltip: the panel is what resting on the ring shows. */}
      <button
        ref={triggerRef}
        type="button"
        className="context-inspector-trigger"
        aria-label={t("chat.usageContextAria", ariaArguments)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={toggleInspector}
      >
        <svg
          className="context-inspector-ring"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            className="context-inspector-ring-track"
            cx="12"
            cy="12"
            r={CONTEXT_RING_RADIUS}
          />
          <circle
            className="context-inspector-ring-progress"
            cx="12"
            cy="12"
            r={CONTEXT_RING_RADIUS}
            strokeDasharray={CONTEXT_RING_CIRCUMFERENCE}
            strokeDashoffset={
              CONTEXT_RING_CIRCUMFERENCE * (1 - display.ratio)
            }
          />
        </svg>
        <span className="context-inspector-ring-value">
          {display.percent}%
        </span>
      </button>
      {popover && typeof document !== "undefined"
        ? portalToBody(popover)
        : null}
    </div>
  );
}
