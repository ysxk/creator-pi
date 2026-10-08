import { useEffect, useState } from "react";
import { subagentAvatarDataUrl } from "@pi-desktop/shared";
import { api } from "../lib/api";

/**
 * A subagent's identity mark: an AI-generated PNG when one was stored for the
 * name, otherwise the deterministic SVG generated from the name alone. PNG
 * lookups are cached per name for the session so a settings page full of rows
 * costs one IPC round trip each, once.
 */

const pngCache = new Map<string, string | null>();

function useSubagentAvatarUrl(name: string): string {
  const [png, setPng] = useState<string | null>(() => pngCache.get(name) ?? null);
  useEffect(() => {
    let current = true;
    if (pngCache.has(name)) {
      setPng(pngCache.get(name) ?? null);
      return;
    }
    void api
      .subagentIcon(name)
      .then((result) => {
        const url = result.kind === "png" ? result.dataUrl : null;
        pngCache.set(name, url);
        if (current) setPng(url);
      })
      .catch(() => {
        pngCache.set(name, null);
      });
    return () => {
      current = false;
    };
  }, [name]);
  return png ?? subagentAvatarDataUrl(name);
}

/** Replace a name's cached mark after generation or removal. */
export function setSubagentAvatarPng(name: string, dataUrl: string | null): void {
  pngCache.set(name, dataUrl);
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
