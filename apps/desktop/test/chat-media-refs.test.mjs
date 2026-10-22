import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { linkifyMdastTree } from "../src/lib/chat-links.ts";
import { remarkChatFileLinks } from "../src/lib/chat-links.ts";
import {
  appendChatMediaPreviews,
  CHAT_MEDIA_TAG,
  chatMediaKind,
  isChatImagePath,
  mentionedFolders,
  remarkChatMediaPreviews,
} from "../src/lib/chat-media-refs.ts";
import { generatedImageDownloadName } from "../src/features/chat/transcript/generated-image-download.ts";

const ROOT = "/work/app";

/** Parse a reply the way a Markdown block is, through both passes. */
function previewsOf(markdown) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  linkifyMdastTree(tree, ROOT);
  appendChatMediaPreviews(tree);
  return tree;
}

const preview = (node) =>
  node.type === "chatMedia" ? `${node.data.hProperties.kind}:${node.data.hProperties.path}` : node.type;

test("only clips the renderer plays and vector drawings are previewed", () => {
  assert.equal(chatMediaKind("out/final.mp4"), "video");
  assert.equal(chatMediaKind("A.MOV"), "video");
  assert.equal(chatMediaKind("clip.webm"), "video");
  assert.equal(chatMediaKind("design/panel.svg"), "image");
  // A recording the renderer decodes gets a player too.
  assert.equal(chatMediaKind("notes/memo.mp3"), "audio");
  assert.equal(chatMediaKind("Take 1.WAV"), "audio");
  assert.equal(chatMediaKind("voice.m4a"), "audio");
  assert.equal(chatMediaKind("master.flac"), "audio");
  assert.equal(chatMediaKind("memo.mp3:12"), null);
  // A raster picture is shown where the reply embeds it, not where it is named.
  assert.equal(chatMediaKind("shot.png"), null);
  // No decoder, or no type on the media scheme.
  assert.equal(chatMediaKind("raw.mkv"), null);
  assert.equal(chatMediaKind("old.avi"), null);
  // A position inside a file is not the file.
  assert.equal(chatMediaKind("clip.mp4:12"), null);
});

test("a named clip gets a preview under the paragraph that names it", () => {
  const tree = previewsOf("Saved to `tmp/final.mp4`.\n\nNothing here.\n");
  assert.deepEqual(tree.children.map(preview), ["paragraph", "video:tmp/final.mp4", "paragraph"]);
  // The node becomes the element the Markdown component map renders.
  assert.equal(tree.children[1].data.hName, "chat-media");
  assert.deepEqual(tree.children[1].position, tree.children[0].position);
});

test("a named recording gets a player under the paragraph that names it", () => {
  const tree = previewsOf("The voice-over is in `out/vo.mp3`, next to `out/vo.wav`.\n");
  assert.deepEqual(tree.children.map(preview), ["paragraph", "audio:out/vo.mp3", "audio:out/vo.wav"]);
});

test("a table of bare file names is followed by one preview per file, in order", () => {
  const tree = previewsOf(
    [
      "| # | file |",
      "| - | - |",
      "| 01 | `01_Johnny_Harris_地图.mp4` |",
      "| 02 | `02_Vox_边境线E1.mp4` |",
      "| 03 | `01_Johnny_Harris_地图.mp4` |",
    ].join("\n"),
  );
  assert.deepEqual(tree.children.map(preview), [
    "table",
    "video:01_Johnny_Harris_地图.mp4",
    "video:02_Vox_边境线E1.mp4",
  ]);
});

/** Each cell's children, flattened through bold and emphasis, as preview labels. */
function cellPreviews(cell) {
  const out = [];
  const visit = (node) => {
    for (const child of node.children ?? []) {
      if (child.type === "chatMedia") {
        const { kind, path, variant } = child.data.hProperties;
        out.push(`${variant}:${kind}:${path}`);
      } else if (child.type === "link") out.push(`link:${child.url}`);
      else visit(child);
    }
  };
  visit(cell);
  return out;
}

test("a table cell that names a picture holds its thumbnail, right after the name", () => {
  const tree = previewsOf(
    [
      "| file | use |",
      "| - | - |",
      "| **`output/full.jpg`** | the whole page |",
      "| `design/panel.svg` | drawing, see also `output/seams.PNG` |",
      "| `tmp/final.mp4` | the cut |",
      "| `output/full.jpg` | named twice |",
      "| `page.html` | source |",
    ].join("\n"),
  );
  // A clip still follows the table; the pictures do not.
  assert.deepEqual(tree.children.map(placed), ["table", "block:video:tmp/final.mp4"]);
  const rows = tree.children[0].children.slice(1).map((row) => row.children.map(cellPreviews));
  assert.deepEqual(rows, [
    [["link:output/full.jpg", "thumb:image:output/full.jpg"], []],
    [["link:design/panel.svg", "thumb:image:design/panel.svg"], ["link:output/seams.PNG", "thumb:image:output/seams.PNG"]],
    [["link:tmp/final.mp4"], []],
    // One picture is shown once per table.
    [["link:output/full.jpg"], []],
    [["link:page.html"], []],
  ]);
  // The thumbnail sits inside the bold run that held the name.
  const strong = tree.children[0].children[1].children[0].children[0];
  assert.equal(strong.type, "strong");
  assert.deepEqual(strong.children.map((node) => node.type), ["link", "chatMedia"]);
});

/** A preview label that also names how it sits. */
const placed = (node) =>
  node.type === "chatMedia"
    ? `${node.data.hProperties.variant}:${node.data.hProperties.kind}:${node.data.hProperties.path}`
    : node.type;

test("pictures named outside a table follow their block as a row of thumbnails", () => {
  assert.equal(isChatImagePath("output/full.jpg"), true);
  assert.equal(isChatImagePath("a/b.webp"), true);
  assert.equal(isChatImagePath("a/b.svg"), true);
  assert.equal(isChatImagePath("a/b.mp4"), false);
  assert.equal(isChatImagePath("shot.png:12"), false);
  const tree = previewsOf(
    "Saved `output/full.jpg` and `output/seams.jpg`, see also `design/panel.svg`.\n\n- also `output/seams.jpg`\n- and `out/b.png`\n",
  );
  // A drawing keeps its full preview; the pictures are thumbnails, in order.
  assert.deepEqual(tree.children.map(placed), [
    "paragraph",
    "block:image:design/panel.svg",
    "thumb:image:output/full.jpg",
    "thumb:image:output/seams.jpg",
    "list",
  ]);
  // A list keeps them inside the item; the reply's viewer shows each file once.
  const [first, second] = tree.children[4].children;
  assert.deepEqual(first.children.map(placed), ["paragraph", "thumb:image:output/seams.jpg"]);
  assert.deepEqual(second.children.map(placed), ["paragraph", "thumb:image:out/b.png"]);
});

test("a remote picture or an embedded one in a cell gets no thumbnail", () => {
  const tree = previewsOf(
    [
      "| a | b |",
      "| - | - |",
      "| https://example.com/x.png | ![shot](design/y.png) |",
    ].join("\n"),
  );
  const rows = tree.children[0].children.slice(1).map((row) => row.children.map(cellPreviews));
  assert.deepEqual(rows, [[["link:https://example.com/x.png"], []]]);
});

test("a list keeps each preview inside the item that named the file", () => {
  const tree = previewsOf("- first `a/one.mp4`\n- second `b/two.svg`\n- third\n");
  assert.deepEqual(tree.children.map(preview), ["list"]);
  const [first, second, third] = tree.children[0].children;
  assert.deepEqual(first.children.map(preview), ["paragraph", "video:a/one.mp4"]);
  assert.deepEqual(second.children.map(preview), ["paragraph", "image:b/two.svg"]);
  assert.deepEqual(third.children.map(preview), ["paragraph"]);
});

test("quoted commands, embedded pictures and remote clips are not mentions", () => {
  const tree = previewsOf(
    [
      "```bash",
      "ffmpeg -i tmp/in.mp4 tmp/out.mp4",
      "```",
      "",
      "![shot](design/panel.svg)",
      "",
      "See https://example.com/talk.mp4 and `notes.md`.",
    ].join("\n"),
  );
  assert.deepEqual(tree.children.map(preview), ["code", "paragraph", "paragraph"]);
});

test("an authored link to a clip is a mention too", () => {
  const tree = previewsOf("The cut is [here](out/cut.mov).\n");
  assert.deepEqual(tree.children.map(preview), ["paragraph", "video:out/cut.mov"]);
});

test("the preview node reaches its renderer through the raw-HTML and sanitizer passes", () => {
  // The same shape Markdown.tsx gives the sanitizer for this element.
  const schema = {
    ...defaultSchema,
    attributes: { ...defaultSchema.attributes, [CHAT_MEDIA_TAG]: ["path", "kind", "variant"] },
    tagNames: [...(defaultSchema.tagNames || []), CHAT_MEDIA_TAG],
  };
  const html = renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkChatFileLinks(ROOT), remarkChatMediaPreviews],
        rehypePlugins: [rehypeRaw, [rehypeSanitize, schema]],
        components: {
          [CHAT_MEDIA_TAG]: ({ path, kind, variant }) =>
            React.createElement("mark", { "data-kind": kind, "data-variant": variant }, path),
        },
      },
      "Saved to `tmp/final.mp4` and `design/panel.svg`.\n\n| file |\n| - |\n| `out/a.jpg` |",
    ),
  );
  assert.match(html, /<\/p>\s*<mark data-kind="video" data-variant="block">tmp\/final\.mp4<\/mark>\s*<mark data-kind="image" data-variant="block">design\/panel\.svg<\/mark>/);
  assert.match(html, /<td>[^]*?<\/a><mark data-kind="image" data-variant="thumb">out\/a\.jpg<\/mark><\/td>/);
});

test("folders a reply names complete the bare file names it lists", () => {
  assert.deepEqual(
    mentionedFolders(
      [
        "已全部下载完成，保存在项目的 `tmp/reference_videos/` 目录下。",
        "",
        "| 01 | `01_Johnny_Harris.mp4` |",
        "",
        "Also see `out\\\\` and `tmp/reference_videos/` again, and `https://example.com/a/`.",
        "",
        "```bash",
        "ls `build/`",
        "```",
        "A word like `tmp` or a file like `a/b.mp4` is not a folder; `./` names nothing.",
      ].join("\n"),
    ),
    ["tmp/reference_videos", "out"],
  );
  assert.deepEqual(mentionedFolders("no folders here"), []);
});

test("a named picture downloads under its own name, whatever its format", () => {
  assert.equal(
    generatedImageDownloadName("data:image/svg+xml;base64,AA==", 0, "panel.svg"),
    "panel.svg",
  );
  assert.equal(generatedImageDownloadName("data:image/png;base64,AA==", 3, "a/b:c.png"), "a_b_c.png");
  assert.equal(generatedImageDownloadName("data:text/html;base64,AA==", 0, "x.svg"), null);
  // An unnamed result keeps its ordinal name and its format allow list.
  assert.equal(generatedImageDownloadName("data:image/svg+xml;base64,AA==", 0), null);
});

test("the reply lends its Markdown the previews and the viewer; nothing else gets them", async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const [markdown, chatMarkdown, turnParts, messageRow, mention, images, css] = await Promise.all([
    read("../src/components/Markdown.tsx"),
    read("../src/features/chat/transcript/ChatMarkdown.tsx"),
    read("../src/features/chat/transcript/AssistantTurnParts.tsx"),
    read("../src/features/chat/transcript/MessageRow.tsx"),
    read("../src/components/MarkdownChatMedia.tsx"),
    read("../src/features/chat/transcript/GeneratedImages.tsx"),
    read("../src/styles/generated-images.css"),
  ]);
  // The preview pass runs only when the transcript's context is present, and
  // after the link pass whose links it reads.
  assert.match(markdown, /const mediaPreviews = useContext\(MarkdownChatMediaContext\) !== null;/);
  assert.match(
    markdown,
    /remarkChatFileLinks\(workspaceRoot, baseDir\),[\s\S]{0,120}\.\.\.\(mediaPreviews \? \[remarkChatMediaPreviews\] : \[\]\)/,
  );
  // The element survives the sanitizer and has a renderer.
  assert.match(markdown, /\[CHAT_MEDIA_TAG\]: \["path", "kind", "variant"\]/);
  // A picture's name in a reply opens the viewer on the completed file, and
  // the link around the chip does not open it a second time.
  assert.match(markdown, /openReplyFileRef\(text \?\? target\.path, baseDir, event\.currentTarget\)/);
  assert.match(markdown, /if \(e\.defaultPrevented\) return;/);
  assert.match(mention, /if \(!media \|\| !trigger \|\| !isChatImagePath\(path\)\) \{\s*openFileRef\(path, baseDir\);/);
  assert.match(mention, /if \(file && trigger\.isConnected\) media\.openImage\(trigger, file\);\s*else openFileRef\(path, baseDir\);/);
  // A cell's picture is phrasing content with no caption; the chip names it.
  assert.match(markdown, /variant=\{variant === "thumb" \? "thumb" : "block"\}/);
  assert.match(mention, /if \(variant === "thumb"\) \{\s*return \(\s*<span className="chat-media-thumb"/);
  assert.match(markdown, /\[CHAT_MEDIA_TAG\]: ChatMediaNode/);
  // Both places an assistant reply is drawn go through the provider.
  assert.match(turnParts, /<ChatMarkdown source=\{displayContent\} streaming=\{streaming\} inkClock=\{inkClock\} \/>/);
  assert.match(messageRow, /<ChatMarkdown source=\{displayed\} \/>/);
  assert.match(chatMarkdown, /<MarkdownChatMediaContext\.Provider value=\{media\}>/);
  assert.match(chatMarkdown, /<GeneratedImageViewer/);
  // A picture in a reply opens the viewer; outside one it still opens the file.
  assert.match(
    markdown,
    /chatMedia\s*\? \(event\) => chatMedia\.openImage\(event\.currentTarget, localRef\)\s*: \(\) => openFileRef\(localRef, baseDir\)/,
  );
  // A name the host cannot find draws nothing, and a clip streams from the
  // host-owned scheme by the path the host resolved.
  assert.match(mention, /api\.fsResolveRef\(candidate, sessionId \?\? undefined\)/);
  // A bare name is also tried inside the folders the reply named.
  assert.match(mention, /folderKey\.split\("\\n"\)\.map\(\(folder\) => `\$\{folder\}\/\$\{ref\}`\)/);
  assert.match(mention, /if \(!media \|\| !file \|\| owned !== file\) return null;/);
  assert.match(mention, /src=\{mediaViewUrl\(file\)\}/);
  // A recording has its own player and chip fallback, and the node reaches it.
  assert.match(mention, /function MentionedAudio\(/);
  assert.match(mention, /kind === "audio" \? \(\s*<MentionedAudio file=\{file\} onContextMenu=\{openMenu\} \/>/);
  assert.match(markdown, /kind !== "video" && kind !== "audio" && kind !== "image"/);
  // A generated set is every picture at reading size, not one and a strip.
  assert.match(images, /\{images\.map\(\(image, position\) => \(\s*<ImageResult/);
  assert.doesNotMatch(images, /<GeneratedImageThumbnail/);
  assert.match(css, /\.generated-image-set \{[^}]*flex-direction: column;/);
  assert.doesNotMatch(css, /generated-image-thumbnails/);
});
