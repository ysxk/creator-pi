import { useEffect, useState } from "react";
import { subagentAvatarDataUrl } from "@pi-desktop/shared";
import { api } from "../lib/api";

/**
 * A subagent's identity mark: an AI-generated PNG when one was stored for the
 * name, otherwise the deterministic SVG generated from the name alone. PNG
 * lookups are cached per name and published through a subscription so every
 * mounted avatar updates when a PNG is generated or reset — the editor
 * preview, Settings rows, and the @ popup stay in sync without a remount.
 */

type PngCache = {
  url: Map<string, string | null>;
  /** Monotonic per-name write counter: a late read must not undo a newer write. */
  version: Map<string, number>;
  listeners: Set<() => void>;
};

const pngCache: PngCache = {
  url: new Map(),
  version: new Map(),
  listeners: new Set(),
};

function publishPng(name: string, dataUrl: string | null): void {
  pngCache.url.set(name, dataUrl);
  pngCache.version.set(name, (pngCache.version.get(name) ?? 0) + 1);
  for (const listener of pngCache.listeners) listener();
}

function subscribePng(listener: () => void): () => void {
  pngCache.listeners.add(listener);
  return () => pngCache.listeners.delete(listener);
}

function useSubagentAvatarUrl(name: string): string {
  const [png, setPng] = useState<string | null>(() => pngCache.url.get(name) ?? null);
  useEffect(() => {
    let current = true;
    // A published change (generate/reset elsewhere) applies immediately,
    // including when the cache already held a value.
    const sync = () => {
      setPng(pngCache.url.get(name) ?? null);
    };
    sync();
    const unsubscribe = subscribePng(sync);
    if (pngCache.url.has(name)) {
      return () => {
        unsubscribe();
        current = false;
      };
    }
    // The read is only allowed to publish when no newer write happened while
    // it was in flight — a generate/reset that lands first must not be
    // overwritten by a stale answer for the same name.
    const observedVersion = pngCache.version.get(name) ?? 0;
    void api
      .subagentIcon(name)
      .then((result) => {
        const url = result.kind === "png" ? result.dataUrl : null;
        if (current && (pngCache.version.get(name) ?? 0) === observedVersion) {
          publishPng(name, url);
        }
      })
      .catch(() => {
        if (current && (pngCache.version.get(name) ?? 0) === observedVersion) {
          publishPng(name, null);
        }
      });
    return () => {
      unsubscribe();
      current = false;
    };
  }, [name]);
  return png ?? subagentAvatarDataUrl(name);
}

/** Replace a name's cached mark after generation or removal. */
export function setSubagentAvatarPng(name: string, dataUrl: string | null): void {
  publishPng(name, dataUrl);
}

export function SubagentAvatar({
  name,
  size = 28,
  className,
}: {
  name: string;
  /** Rendered square edge in CSS pixels. */
  size?: number;
  className?: string;
}) {
  const src = useSubagentAvatarUrl(name);
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={className ? `subagent-avatar ${className}` : "subagent-avatar"}
      draggable={false}
    />
  );
}
