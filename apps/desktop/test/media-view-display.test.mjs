import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  schemes,
  mediaProtocol,
  workspaceIpc,
  indexHtml,
  markdown,
  transcriptShared,
  messageRow,
  hoverCard,
] = await Promise.all([
  read("../electron/main/plugin-schemes.ts"),
  read("../electron/main/media-protocol.ts"),
  read("../electron/main/ipc/workspace-ipc.ts"),
  read("../index.html"),
  read("../src/components/Markdown.tsx"),
  read("../src/features/chat/transcript/shared.tsx"),
  read("../src/features/chat/transcript/MessageRow.tsx"),
  read("../src/components/ImageHoverCard.tsx"),
]);

test("the pi-media scheme is reserved privileged before app ready", () => {
  assert.match(schemes, /PI_MEDIA_SCHEME_PRIVILEGES/);
  assert.match(mediaProtocol, /stream: true/);
  assert.match(mediaProtocol, /standard: true/);
  assert.match(mediaProtocol, /supportFetchAPI: true/);
});

test("media requests are confined to the openable roots and honor ranges", () => {
  // The resolver is the fsOpen one: outside references must not resolve.
  assert.match(workspaceIpc, /installMediaProtocol/);
  assert.match(workspaceIpc, /resolveRealOpenablePath\(/);
  // A video element seeks through Range requests; without 206 support
  // playback still starts but seeking silently breaks.
  assert.match(mediaProtocol, /parseMediaRange/);
  assert.match(mediaProtocol, /"content-range"/);
  assert.match(mediaProtocol, /accept-ranges/);
  assert.match(mediaProtocol, /createReadStream\(path, \{ start, end \}\)/);
});

test("the renderer CSP allows the scheme for media elements", () => {
  const match = /media-src ([^;]+);/.exec(indexHtml);
  assert.ok(match);
  assert.match(match[1], /pi-media:/);
});

test("markdown video blocks stream local paths and fall back to a chip", () => {
  assert.match(markdown, /function VideoBlock/);
  assert.match(markdown, /mediaViewUrl\(localRef\)/);
  // A local file the resolver refuses must degrade, not render a dead player.
  assert.match(markdown, /onError=\{\(\) => setFailed\(true\)\}/);
  assert.match(markdown, /chat-image-chip/);
});

test("user video attachments render a chip with an operable hover player", () => {
  assert.match(transcriptShared, /export function MessageAttachmentVideo/);
  assert.match(transcriptShared, /VideoHoverCard\n?\s*src=\{mediaViewUrl\(attachment\.ref\)\}/);
  assert.match(hoverCard, /export function VideoHoverCard/);
  assert.match(hoverCard, /is-interactive/);
  // The card is portal-rendered with a gap from the chip: the chip must not
  // dismiss on pointer leave, or the pointer can never reach the controls.
  // (The image chip keeps its own pointer-leave dismissal: its card is
  // pointer-inert, so nothing needs crossing a gap.)
  const videoComponent = transcriptShared.slice(
    transcriptShared.indexOf("export function MessageAttachmentVideo"),
    transcriptShared.indexOf("/** Plain user text"),
  );
  assert.doesNotMatch(videoComponent, /onPointerLeave=\{dismiss\}/);
  // The card owns its exit: its own pointer leave, Escape, scroll/resize.
  assert.match(hoverCard, /onPointerLeave=\{onDismiss\}/);
  assert.match(hoverCard, /event\.key === "Escape"/);
  // Keyboard focus still reveals. Focus moving from the chip into the
  // portal-rendered player's controls must keep the card open; only focus
  // landing outside THIS attachment's own card dismisses. The own-card ref is
  // what keeps two simultaneously open cards from being confused — a global
  // querySelector would always answer with whichever card mounted first.
  assert.match(transcriptShared, /onFocus=\{reveal\}/);
  assert.match(transcriptShared, /onBlur=\{onChipBlur\}/);
  assert.match(transcriptShared, /const card = cardRef\.current/);
  assert.doesNotMatch(transcriptShared, /document\.querySelector/);
  // The card owns its keyboard exit: focus leaving the player dismisses it,
  // unless it is heading back to the chip. The own-card element ref crosses
  // the portal boundary so the chip's blur test can address this card.
  assert.match(hoverCard, /onBlur=\{onCardBlur\}/);
  assert.match(transcriptShared, /cardRef=\{cardRef\}/);
  assert.match(hoverCard, /cardRef\?: RefObject<HTMLDivElement \| null>/);
  // Both placements — inline between words and the trailing list — route video.
  assert.match(messageRow, /MessageAttachmentVideo/);
});
