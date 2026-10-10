import { describe, expect, it } from "vitest";
import { subagentAvatarDataUrl, subagentAvatarSvg } from "./subagent-avatar.js";

const SHIPPED = ["explorer", "code-reviewer", "test-runner", "fixer", "ui-designer"];

describe("subagentAvatarSvg", () => {
  it("is deterministic for one name", () => {
    expect(subagentAvatarSvg("explorer")).toBe(subagentAvatarSvg("explorer"));
    expect(subagentAvatarSvg("code-reviewer")).not.toBe(subagentAvatarSvg("explorer"));
  });

  it("draws a self-contained ink-on-paper portrait inside a toned ring", () => {
    const svg = subagentAvatarSvg("code-reviewer");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('viewBox="0 0 64 64"');
    // The frame is a ring that ends at the box edge, and the portrait is
    // clipped inside it.
    expect(svg).toContain('<circle cx="32" cy="32" r="29.25" fill="none" stroke="#7c3aed" stroke-width="3.5"/>');
    expect(svg).toContain('clip-path="url(#c)"');
    // Ink, paper, and one tone: no gradients, no second colour.
    const colours = [...new Set(svg.match(/#[0-9a-f]{6}/g))].sort();
    expect(colours).toEqual(["#0f172a", "#7c3aed", "#ffffff"]);
    expect(svg).not.toContain("linearGradient");
    expect(svg).not.toContain("<text");
  });

  it("keeps the tone to the ring and the headwear", () => {
    const svg = subagentAvatarSvg("explorer");
    const tone = "#0284c7";
    const ring = svg.slice(svg.lastIndexOf("<circle"));
    const [beforeHeadwear] = svg.split(tone, 1);
    // Shoulders and head come first and are drawn in ink on paper.
    expect(beforeHeadwear).toContain('stroke="#0f172a"');
    expect(ring).toContain(`stroke="${tone}"`);
    // The disc stays paper: the tone marks the portrait without filling it.
    expect(svg).toContain('<circle cx="32" cy="32" r="31" fill="#ffffff"/>');
    // Eyes and mouth follow the headwear and never take the tone.
    const afterHeadwear = svg.slice(svg.lastIndexOf(tone, svg.lastIndexOf("</g>")));
    expect(afterHeadwear.slice(0, afterHeadwear.indexOf("</g>"))).toContain("#0f172a");
  });

  it("gives the shipped subagents five different tones", () => {
    const toneOf = (name: string) =>
      subagentAvatarSvg(name).match(/stroke="(#[0-9a-f]{6})" stroke-width="3\.5"\/><\/svg>$/)?.[1];
    const tones = SHIPPED.map(toneOf);
    expect(tones.every(Boolean)).toBe(true);
    expect(new Set(tones).size).toBe(SHIPPED.length);
  });

  it("spreads other names across the tones", () => {
    const tones = new Set(
      Array.from({ length: 60 }, (_, index) =>
        subagentAvatarSvg(`agent-${index}`).match(/stroke="(#[0-9a-f]{6})" stroke-width="3\.5"/)?.[1],
      ),
    );
    expect(tones.size).toBe(8);
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
