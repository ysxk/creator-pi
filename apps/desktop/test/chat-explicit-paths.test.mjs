import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { linkifyMdastTree, splitChatText, getToolPreviewTarget, handleMarkdownFileLinkClick } from "../src/lib/chat-links.ts";
import { appendChatMediaPreviews } from "../src/lib/chat-media-refs.ts";

const root = "/work/project";
function render(source) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source);
  linkifyMdastTree(tree, root);
  appendChatMediaPreviews(tree);
  return tree;
}
function descendants(tree, type) {
  return [ ...(tree.type === type ? [tree] : []), ...(tree.children ?? []).flatMap((node) => descendants(node, type)) ];
}

test("bare filenames remain text or inline code instead of automatic file targets", () => {
  for (const name of ["voiceover.wav", "素材清单.md", "part_1.wav", "shot.png", "diagram.svg", "clip.mp4", "README.md", "package.json", "Makefile", "file.ts:12:3"]) {
    const text = `See ${name}.`;
    assert.deepEqual(splitChatText(text, root), [{ kind: "text", text }], name);
    const tree = render(`See \`${name}\`.`);
    assert.deepEqual(descendants(tree, "link"), [], name);
    assert.deepEqual(descendants(tree, "chatMedia"), [], name);
    assert.equal(descendants(tree, "inlineCode")[0].value, name);
  }
});

test("the subtitle-table reply does not infer an audio player from its bare filename", () => {
  const tree = render([
    "Saved the audio under `worker/10.27-omni-model/audio/`.",
    "", "| File | Path | Description |", "| --- | --- | --- |",
    "| Words | `worker/10.27-omni-model/subtitle/words.json` | Corresponds to `voiceover.wav` |",
    "| Captions | `worker/10.27-omni-model/subtitle/captions.json` | Final subtitles |",
  ].join("\n"));
  assert.deepEqual(descendants(tree, "link").map((node) => node.url), [
    "worker/10.27-omni-model/subtitle/words.json", "worker/10.27-omni-model/subtitle/captions.json",
  ]);
  assert.deepEqual(descendants(tree, "chatMedia"), []);
});

test("qualified paths retain links and media previews, including root-relative explicit paths", () => {
  for (const path of ["./voiceover.wav", "audio/voiceover.wav", "worker/10.27-omni-model/audio/voiceover.wav", "/work/project/audio/voiceover.wav", String.raw`C:\project\audio\voiceover.wav`]) {
    const tree = render(`Saved \`${path}\`.`);
    assert.equal(descendants(tree, "link").length, 1, path);
    assert.equal(descendants(tree, "chatMedia").length, 1, path);
  }
});

test("authored Markdown destinations remain links even when the visible label is a bare filename", () => {
  for (const path of ["audio/voiceover.wav", "voiceover.wav"]) {
    const tree = render(`[\`voiceover.wav\`](${path})`);
    assert.equal(descendants(tree, "link")[0].url, path);
    assert.equal(descendants(tree, "chatMedia").length, 1);
    const calls = [];
    assert.equal(handleMarkdownFileLinkClick({ preventDefault() {} }, path, root, undefined, (...args) => calls.push(args)), true);
    assert.equal(calls[0][0], path);
  }
  const image = render("![cover](cover.png)");
  assert.equal(descendants(image, "image")[0].url, "cover.png");
});

test("explicit user file references and tool paths keep their existing contracts", () => {
  for (const token of ["@voiceover.wav", '@"素材清单.md"', "@audio/voiceover.wav"]) {
    const segment = splitChatText(token, root).find((part) => part.kind === "target");
    assert.equal(segment?.target.kind, "file", token);
  }
  assert.deepEqual(getToolPreviewTarget({ path: "voiceover.wav" }, root), { kind: "file", path: "voiceover.wav" });
  const tree = render("https://example.com/audio.wav");
  assert.equal(descendants(tree, "link")[0].url, "https://example.com/audio.wav");
  assert.deepEqual(descendants(tree, "chatMedia"), []);
});
