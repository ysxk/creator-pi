/**
 * The label of a process or activity header. While its work runs, a sheen
 * crosses the muted words (D694): a masked copy of the same text that moves by
 * `transform` alone (motion.css `ds-sheen-*`), so a running turn never repaints
 * per frame and pauses with the window like every other work-in-flight mark.
 * The copy is hidden from assistive technology; the label reads once.
 */
export function ActivityLabel({ text, running }: { text: string; running: boolean }) {
  return (
    <span className={`tool-activity-label${running ? " running" : ""}`}>
      {text}
      {running ? (
        <span className="tool-activity-sheen" aria-hidden>
          <span>{text}</span>
        </span>
      ) : null}
    </span>
  );
}
