import { useEffect } from "react";

/**
 * Publish whether the window is the one the user is looking at, as
 * `data-window-active` on the document element.
 *
 * Looping status animations (a running session's halo, a running tool's
 * marker) read it through `--motion-play` and pause while the window is
 * blurred or hidden. The macOS window is transparent over native vibrancy, so
 * every animated frame re-composites the whole window; a loop nobody is
 * watching is pure cost. State never depends on the motion — the paused frame
 * still shows the indicator.
 */
export function useWindowActivity(): void {
  useEffect(() => {
    const root = document.documentElement;
    const publish = () => {
      const active = document.visibilityState === "visible" && document.hasFocus();
      root.dataset.windowActive = active ? "true" : "false";
    };
    publish();
    window.addEventListener("focus", publish);
    window.addEventListener("blur", publish);
    document.addEventListener("visibilitychange", publish);
    return () => {
      window.removeEventListener("focus", publish);
      window.removeEventListener("blur", publish);
      document.removeEventListener("visibilitychange", publish);
      delete root.dataset.windowActive;
    };
  }, []);
}
