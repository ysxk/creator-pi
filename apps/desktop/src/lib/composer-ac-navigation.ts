/**
 * Keyboard movement in the composer's `@` panel.
 *
 * The panel has two regions that share one highlight index: a strip of
 * subagents (the leading `subagent` items) and the file list under it. Files
 * are what `@` is for most of the time, so the highlight starts there and the
 * up and down keys stay inside the list. Left and right move along the strip,
 * but those are also the caret's keys, so they only enter the strip when the
 * caret has nowhere useful to go: right at the end of the token, left when
 * nothing has been typed after the `@`. Everywhere else they return `null`
 * and the editor handles the key as it always did.
 */
export type AcNavItem = { kind: string };

export type AcNavKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

export type AcNavContext = {
  /** Nothing typed after the trigger character yet. */
  queryEmpty: boolean;
  /** The caret is at the end of the token: whitespace or nothing follows it. */
  caretAtTokenEnd: boolean;
};

/** How many items at the head of the list are subagents. */
export function agentCount(items: readonly AcNavItem[]): number {
  let count = 0;
  while (count < items.length && items[count].kind === "subagent") count += 1;
  return count;
}

/**
 * Where the highlight starts for a query. The first file, unless the query is
 * the start of a subagent's name: `@fixer` followed by Enter has to keep
 * meaning the subagent, as it did when subagents led the list.
 */
export function initialHighlight(
  items: readonly (AcNavItem & { agent?: { name: string } })[],
  query: string,
): number {
  const agents = agentCount(items);
  if (agents === 0 || agents === items.length) return 0;
  const typed = query.trim().toLowerCase();
  if (typed) {
    const named = items.findIndex(
      (item, index) => index < agents && item.agent?.name.toLowerCase().startsWith(typed),
    );
    if (named >= 0) return named;
  }
  return agents;
}

/** The next highlight for a key, or `null` when the key is not the panel's. */
export function moveHighlight(
  items: readonly AcNavItem[],
  highlight: number,
  key: AcNavKey,
  context: AcNavContext,
): number | null {
  const count = items.length;
  if (count === 0) return null;
  const agents = agentCount(items);
  const files = count - agents;
  const vertical = key === "ArrowUp" || key === "ArrowDown";

  // No strip: the list wraps, and the caret keys belong to the editor.
  if (agents === 0) {
    if (!vertical) return null;
    return (highlight + (key === "ArrowDown" ? 1 : -1) + count) % count;
  }

  if (highlight < agents) {
    if (vertical) {
      if (files > 0) return agents;
      return (highlight + (key === "ArrowDown" ? 1 : -1) + agents) % agents;
    }
    if (key === "ArrowRight") return Math.min(agents - 1, highlight + 1);
    // Left of the first subagent is the way back to the files.
    if (highlight > 0) return highlight - 1;
    return files > 0 ? agents : 0;
  }

  if (vertical) {
    const within = highlight - agents;
    return agents + ((within + (key === "ArrowDown" ? 1 : -1) + files) % files);
  }
  if (key === "ArrowRight") return context.caretAtTokenEnd ? 0 : null;
  return context.queryEmpty && context.caretAtTokenEnd ? 0 : null;
}
