import { useTranslation } from "react-i18next";
import {
  type DelegationActivityItem,
  type SubagentOutcome,
  type SubagentTiming,
} from "../../../lib/subagent-topology";
import { ToolRow } from "./ToolRow";

/**
 * The delegates of one parent fan-out (ADR 0062), as a list.
 *
 * The card is already inside the main agent's own turn, under a header that
 * says subagents are working, so the main agent is not drawn again here: a
 * node for it, and connectors running from it, told the reader nothing and
 * took a third of the width from the rows that do. The session board is where
 * the whole shape, trunk included, is shown.
 */
export function SubagentTopology({
  items,
  delegationStatuses,
  delegationTimings,
  onUserInteraction,
}: {
  items: DelegationActivityItem[];
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
  onUserInteraction?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <section className="subagent-topology" aria-label={t("chat.subagentTopology")}>
      <div className="subagent-topology-agents" role="list">
        {items.map((item) => (
          <ToolRow
            key={item.message.id}
            message={item.message}
            {...(item.delegate ? { delegate: item.delegate } : {})}
            variant="topology"
            onUserInteraction={onUserInteraction}
            {...(delegationStatuses ? { delegationStatuses } : {})}
            {...(delegationTimings ? { delegationTimings } : {})}
          />
        ))}
      </div>
    </section>
  );
}
