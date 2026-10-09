import { describe, expect, it } from "vitest";
import { subagentAvatarDataUrl, subagentAvatarSvg } from "./subagent-avatar.js";

const SHIPPED = ["explorer", "code-reviewer", "test-runner", "fixer", "ui-designer"];

describe("subagentAvatarSvg", () => {
  it("is deterministic for one name", () => {
    expect(subagentAvatarSvg("explorer")).toBe(subagentAvatarSvg("explorer"));
    expect(subagentAvatarSvg("code-reviewer")).not.toBe(subagentAvatarSvg("explorer"));
  });

  it("draws a self-contained ink-on-paper portrait inside a circle", () => {
    const svg = subagentAvatarSvg("code-reviewer");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('viewBox="0 0 64 64"');
    // The frame is a ring, and the portrait is clipped to it.
    expect(svg).toContain('<circle cx="32" cy="32" r="30" fill="none"');
    expect(svg).toContain('clip-path="url(#c)"');
    // One ink, one paper, one shade: no gradients and no per-name colours.
    const colours = new Set(svg.match(/#[0-9a-f]{6}/g));
    expect([...colours].sort()).toEqual(["#0f172a", "#475569", "#ffffff"].filter((c) => colours.has(c)));
    expect(colours.has("#0f172a")).toBe(true);
    expect(svg).not.toContain("linearGradient");
    expect(svg).not.toContain("<text");
  });

  it("gives every shipped subagent its own portrait", () => {
    const portraits = new Set(SHIPPED.map(subagentAvatarSvg));
    expect(portraits.size).toBe(SHIPPED.length);
  });

  it("never writes the name into the markup", () => {
    // Names are constrained to [a-z0-9-], but the generator must stay safe
    // even if a caller passes something wider: the name only selects parts.
    const svg = subagentAvatarSvg('<script>alert("x")&');
    expect(svg).not.toContain("script");
    expect(svg).not.toContain("alert");
    expect(svg).toBe(subagentAvatarSvg('<script>alert("x")&'));
  });

  it("spreads other names across the available parts", () => {
    const names = Array.from({ length: 40 }, (_, index) => `agent-${index}`);
    const portraits = new Set(names.map(subagentAvatarSvg));
    expect(portraits.size).toBeGreaterThan(12);
  });
});

describe("subagentAvatarDataUrl", () => {
  it("encodes the SVG for an img src", () => {
    const url = subagentAvatarDataUrl("explorer");
    expect(url.startsWith("data:image/svg+xml;utf8,")).toBe(true);
    expect(decodeURIComponent(url.split("utf8,")[1])).toBe(subagentAvatarSvg("explorer"));
  });
});
