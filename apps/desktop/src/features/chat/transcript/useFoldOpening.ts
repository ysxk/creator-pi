import { useCallback, useEffect, useState } from "react";
import { FOLD_OPEN_MS } from "../../../lib/motion";

/**
 * The window of a reader's own open of a fold (D694). While it lasts, the
 * fold grows from a closed row and its rows ease in (`data-fold-opening`,
 * messages.css). An open nobody clicked — a first render, an automatic open,
 * a search reveal — shows at full height at once, so content never grows
 * under the reading position by itself.
 */
export function useFoldOpening() {
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    if (!opening) return;
    const timer = window.setTimeout(() => setOpening(false), FOLD_OPEN_MS);
    return () => window.clearTimeout(timer);
  }, [opening]);
  const markOpening = useCallback(() => setOpening(true), []);
  return { opening, markOpening };
}
