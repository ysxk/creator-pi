import { describe, expect, it } from "vitest";
import { subagentAvatarDataUrl, subagentAvatarSvg } from "./subagent-avatar.js";

describe("subagentAvatarSvg", () => {
  it("is deterministic for one name", () => {
    expect(subagentAvatarSvg("explorer")).toBe(subagentAvatarSvg("explorer"));
    expect(subagentAvatarSvg("code-reviewer")).not.toBe(subagentAvatarSvg("explorer"));
  });

  it("produces a self-contained SVG with the mark's initials", () => {
    const svg = subagentAvatarSvg("code-reviewer");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    // Kebab parts contribute one letter each, uppercased.
    expect(svg).toContain(">CR</text>");
    // A single-word name takes its first two characters.
    expect(subagentAvatarSvg("fixer")).toContain(">FI</text>");
  });

  it("never emits raw ampersands or angle brackets from the name", () => {
    // Names are constrained to [a-z0-9-], but the generator must stay safe
    // even if a caller passes something wider.
    const svg = subagentAvatarSvg("<script>&");
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("&(?!amp|lt|gt|quot|#)");
  });

  it("spreads names across palettes", () => {
    const palettes = new Set(
      ["explorer", "code-reviewer", "test-runner", "fixer", "ui-designer", "a", "b", "c"].map(
        (name) => /stop-color="([^"]+)"/.exec(subagentAvatarSvg(name))?.[1],
      ),
    );
    expect(palettes.size).toBeGreaterThan(1);
  });
});

describe("subagentAvatarDataUrl", () => {
  it("encodes the SVG for an img src", () => {
    const url = subagentAvatarDataUrl("explorer");
    expect(url.startsWith("data:image/svg+xml;utf8,")).toBe(true);
    expect(decodeURIComponent(url.split("utf8,")[1])).toBe(subagentAvatarSvg("explorer"));
  });
});
