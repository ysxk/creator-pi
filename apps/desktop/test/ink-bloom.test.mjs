import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createInkClock, INK_BLOOM_MS, rehypeInkBloom } from "../src/lib/ink-bloom.ts";

/**
 * Ink bloom for streaming text (D695): only the characters still blooming are
 * wrapped, each with the delay its own age gives it, and everything a
 * component reads as a string stays untouched.
 */

const text = (value, start) => ({
  type: "text",
  value,
  position: { start: { offset: start }, end: { offset: start + value.length } },
});
const element = (tagName, children, properties = {}) => ({ type: "element", tagName, properties, children });
const spans = (node) => (node.children ?? []).flatMap((child) =>
  child.type === "element" && child.properties?.className?.includes("ink") ? [child] : spans(child));

test("the clock spreads a revealed stretch and lets it settle", () => {
  const clock = createInkClock();
  clock.reveal(10, 15, 1000);
  assert.equal(clock.delayAt(9, 1000), null, "text before the stretch is ink");
  assert.equal(clock.delayAt(10, 1000), 0);
  // Five characters in one frame start 12.8ms apart: one frame at most, 64ms in all.
  assert.ok(Math.abs(clock.delayAt(14, 1000) - 51.2) < 1e-9);
  assert.equal(clock.delayAt(10, 1000 + 40), -40, "a blooming character is 40ms in");
  assert.equal(clock.delayAt(10, 1000 + INK_BLOOM_MS), null, "a settled character is plain ink");
  assert.equal(clock.settledBefore(1000), 10);
  assert.equal(clock.settledBefore(1000 + 52 + INK_BLOOM_MS), Number.POSITIVE_INFINITY);
  assert.ok(Math.abs(clock.settlesAt() - (1000 + 51.2 + INK_BLOOM_MS)) < 1e-9, "the last character's bloom ends the stretch");
  clock.reveal(15, 16, 1100);
  assert.equal(clock.settlesAt(), 1100 + INK_BLOOM_MS);
  clock.reset();
  assert.equal(clock.settledBefore(1100), Number.POSITIVE_INFINITY, "a cut-back reply blooms nothing");
  assert.equal(clock.settlesAt(), Number.NEGATIVE_INFINITY);
});

test("only the young tail is wrapped, each with its own age", () => {
  const clock = createInkClock();
  const now = performance.now();
  clock.reveal(6, 8, now);
  const paragraph = element("p", [text("Hello 世界", 0)]);
  const tree = { type: "root", children: [paragraph] };
  rehypeInkBloom({ offset: 0, clock })(tree);
  assert.equal(paragraph.children[0].value, "Hello ", "settled text stays one text node");
  const young = spans(tree);
  assert.deepEqual(young.map((span) => span.children[0].value), ["世", "界"]);
  for (const span of young) {
    assert.match(span.properties.className.join(" "), /^ink ink-[01]$/);
    const delay = Number(span.properties.style.match(/animation-delay:(-?\d+)ms/)[1]);
    assert.ok(delay <= 32 && delay > -INK_BLOOM_MS, `delay ${delay} comes from the character's age`);
  }
});

test("the block offset maps text into the reply, and spaces are never wrapped", () => {
  const clock = createInkClock();
  clock.reveal(100, 105, performance.now());
  const paragraph = element("p", [text("a b c", 0)]);
  rehypeInkBloom({ offset: 100, clock })({ type: "root", children: [paragraph] });
  assert.deepEqual(spans(paragraph).map((span) => span.children[0].value), ["a", "b", "c"]);
  assert.ok(paragraph.children.some((child) => child.type === "text" && child.value === " "));
});

test("strings a component reads and markup it lays out stay untouched", () => {
  const clock = createInkClock();
  clock.reveal(0, 200, performance.now());
  const opaque = [
    element("code", [text("src/app.ts", 0)]),
    element("pre", [element("code", [text("let a = 1", 20)])]),
    element("span", [text("x", 40)], { className: ["katex"] }),
    element("pi-chat-media", [text("clip", 60)]),
  ];
  const tree = { type: "root", children: [element("p", [...opaque, text("go", 80)])] };
  rehypeInkBloom({ offset: 0, clock })(tree);
  for (const node of opaque) assert.equal(spans(node).length, 0, `${node.tagName} must not bloom`);
  assert.deepEqual(spans(tree).map((span) => span.children[0].value), ["g", "o"]);
});

test("each render of a block flips its animation name so reused spans restart on time", () => {
  const clock = createInkClock();
  clock.reveal(0, 30, performance.now());
  const render = (offset) => {
    const tree = { type: "root", children: [element("p", [text("a", 0)])] };
    rehypeInkBloom({ offset, clock })(tree);
    return spans(tree)[0].properties.className[1];
  };
  const first = render(0);
  assert.notEqual(render(0), first);
  assert.equal(render(0), first);
  // Two blocks rendering in the same pass keep their own alternation.
  const other = render(20);
  assert.notEqual(render(0), first);
  assert.notEqual(render(20), other);
});

test("a reply that is not blooming renders untouched", () => {
  const clock = createInkClock();
  const tree = { type: "root", children: [element("p", [text("done", 0)])] };
  const before = JSON.stringify(tree);
  rehypeInkBloom({ offset: 0, clock })(tree);
  assert.equal(JSON.stringify(tree), before);
});

test("the live reply blooms instead of drawing a caret", () => {
  const parts = readFileSync(new URL("../src/features/chat/transcript/AssistantTurnParts.tsx", import.meta.url), "utf8");
  assert.match(parts, /const inkClock = useInkClock\(displayContent\.length, enabled\);/);
  assert.match(parts, /<ChatMarkdown source=\{displayContent\} streaming=\{streaming\} inkClock=\{inkClock\} \/>/);
  assert.doesNotMatch(parts, /smooth-cursor/);
  const markdown = readFileSync(new URL("../src/components/Markdown.tsx", import.meta.url), "utf8");
  assert.match(markdown, /\[rehypeSourcePositions, \{ offset: sourceOffset \}\],[\s\S]*?\[\[rehypeInkBloom, \{ offset: sourceOffset, clock: inkClock \}\]\]/);
  // A finished block drops the clock and with it its spans; so does the reply
  // once its last character has bloomed.
  assert.match(markdown, /inkClock=\{start \+ raw\.length > inkSettled \? inkClock : undefined\}/);
  const hook = readFileSync(new URL("../src/hooks/use-ink-clock.ts", import.meta.url), "utf8");
  assert.match(hook, /const timer = window\.setTimeout\(settle, settlesAt - performance\.now\(\) \+ 1\);/);
  assert.match(hook, /return blooming \? clock : undefined;/);
  const messages = readFileSync(new URL("../src/styles/messages.css", import.meta.url), "utf8");
  assert.doesNotMatch(messages, /smooth-cursor|smooth-stream-blink/);
  assert.match(messages, /\.ink-0 \{\s*animation-name: ds-ink-bloom-0;\s*\}/);
  assert.match(messages, /\.ink-1 \{\s*animation-name: ds-ink-bloom-1;\s*\}/);
  assert.match(messages, /@media \(prefers-reduced-motion: reduce\) \{\s*\.ink \{\s*animation: none;/);
  const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
  assert.match(tokens, new RegExp(`--motion-ink-duration: ${INK_BLOOM_MS}ms;`));
});
