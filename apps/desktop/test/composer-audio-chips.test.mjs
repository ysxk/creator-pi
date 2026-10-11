import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [composer, composerInput, editor, hover, hoverHook, card, cardStyles, storeHelpers, completions, draftHook] =
  await Promise.all([
    read("../src/components/Composer.tsx"),
    read("../src/features/chat/composer/ComposerInput.tsx"),
    read("../src/features/chat/composer/editor.ts"),
    read("../src/features/chat/composer/ComposerMediaHoverPreview.tsx"),
    read("../src/features/chat/composer/hooks/useComposerMediaHover.ts"),
    read("../src/components/ImageHoverCard.tsx"),
    read("../src/styles/image-hover-card.css"),
    read("../src/stores/helpers/store-helpers.ts"),
    read("../src/features/chat/composer/hooks/useComposerCompletions.ts"),
    read("../src/features/chat/composer/hooks/useComposerDraft.ts"),
  ]);

test("a recording in the draft is an audio chip", () => {
  // Pasted, dropped and @-mentioned recordings all classify by the shared table.
  assert.match(editor, /isAudioAttachment\(undefined, path\)\s*\?\s*"audio"/);
  assert.match(completions, /isAudioAttachment\(undefined, acceptedFileReference\.path\)\s*\?\s*"audio"/);
  // The chip wears the audio glyph whatever the file is called.
  assert.match(editor, /if \(reference\.kind === "audio" \|\| AUDIO_FILE_PATTERN\.test\(name\) \|\| mime\.startsWith\("audio\/"\)\)/);
  // And carries the marker the hover tracker looks for.
  assert.match(editor, /const audio = reference\.kind === "audio";/);
  assert.match(editor, /if \(audio\) chip\.dataset\.audio = "";/);
});

test("activating an audio chip opens the recording in the file view", () => {
  // The chip is a button whose action names the media preview; it shares the
  // picture's preview callback, and the owner picks the view by kind.
  assert.match(editor, /audio\s*\?\s*\(\) => onOpenImage\(token\)/);
  assert.match(editor, /audio\s*\?\s*"open-media-preview"/);
  assert.match(draftHook, /if \(reference\.kind === "audio"\) \{\s*openFileRefRef\.current\(reference\.path, undefined, reference\.mimeType\);/);
  assert.match(draftHook, /imagePreview\.open\(reference\);/);
});

test("hovering an audio chip reveals a player that stays reachable", () => {
  assert.match(hoverHook, /const MEDIA_CHIP_SELECTOR = "\.composer-chip\[data-audio\]";/);
  assert.match(hoverHook, /getBoundingClientRect\(\)/);
  // The player takes pointer events, so leaving the chip starts a grace
  // period instead of closing the card; reaching the card cancels it.
  assert.match(hoverHook, /const LEAVE_GRACE_MS = \d+;/);
  assert.match(hoverHook, /return \{ target, dismiss, keep: cancelLeave \};/);
  assert.match(hover, /onPointerEnter=\{keep\}/);
  // A chip that moves under the pointer must not leave a stale card behind.
  assert.match(hoverHook, /editor\.addEventListener\("input", hide\)/);
  // The recording streams from the host-owned scheme by the path the chip names.
  assert.match(hover, /src=\{live \? mediaViewUrl\(target\.reference\.path\) : null\}/);
  // The card is the transcript's media card, playing in an audio element.
  assert.match(hover, /<MediaHoverCard\s+media="audio"/);
  assert.match(card, /onPointerEnter=\{onPointerEnter\}/);
  assert.match(card, /data-media=\{media\}/);
  assert.match(cardStyles, /\.image-hover-card audio \{/);
  // The input mounts it beside the image hover, fed by the draft's references.
  assert.match(composerInput, /<ComposerMediaHover references=\{fileReferences\} editorRef=\{inputRef\} \/>/);
  assert.match(composer, /fileReferences=\{draft\.fileReferences\}/);
});

test("an audio chip travels as a structured attachment like a picture or a clip", () => {
  assert.match(storeHelpers, /isAudioAttachment\(undefined, reference\.path\)\s*\?\s*"audio"/);
  assert.match(storeHelpers, /kind !== "image" && kind !== "video" && kind !== "audio"/);
});
