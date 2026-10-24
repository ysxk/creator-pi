import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatAudioTime } from "../src/lib/audio-time.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("a playback position reads as a player shows it", () => {
  assert.equal(formatAudioTime(0), "0:00");
  assert.equal(formatAudioTime(7.9), "0:07");
  assert.equal(formatAudioTime(65), "1:05");
  assert.equal(formatAudioTime(3599), "59:59");
  assert.equal(formatAudioTime(3600), "1:00:00");
  assert.equal(formatAudioTime(3725), "1:02:05");
  // A duration the element has not reported yet never leaks a number.
  assert.equal(formatAudioTime(Number.NaN), "0:00");
  assert.equal(formatAudioTime(Number.POSITIVE_INFINITY), "0:00");
  assert.equal(formatAudioTime(-3), "0:00");
});

test("every recording plays in the app's own player, not the browser control", async () => {
  const [player, styles, hoverCard, filesTab, mention, markdown, icons] = await Promise.all([
    read("../src/components/AudioPlayer.tsx"),
    read("../src/styles/audio-player.css"),
    read("../src/components/ImageHoverCard.tsx"),
    read("../src/components/workpanel/FilesTab.tsx"),
    read("../src/components/MarkdownChatMedia.tsx"),
    read("../src/components/Markdown.tsx"),
    read("../src/components/icons.tsx"),
  ]);
  // The element plays and is hidden; the component mirrors its state.
  assert.match(player, /<audio\s+ref=\{audioRef\}\s+src=\{src\}\s+preload="metadata"/);
  assert.doesNotMatch(player, /<audio[^>]*\scontrols/);
  assert.match(styles, /\.audio-player audio \{\s*display: none;/);
  // Play/pause, a seek bar that follows the pointer while held, and the time.
  assert.match(player, /className="audio-player-toggle"/);
  // Solid glyphs on a solid button.
  assert.match(player, /playing \? \(\s*<IconPause[^>]*filled \/>\s*\) : \(\s*<IconPlay[^>]*filled \/>\s*\)/);
  assert.match(player, /type="range"/);
  assert.match(player, /onPointerDown=\{\(\) => setScrubbing\(position\)\}/);
  assert.match(player, /aria-valuetext=\{`\$\{formatAudioTime\(shown\)\} \/ \$\{formatAudioTime\(duration\)\}`\}/);
  assert.match(player, /className="audio-player-time"/);
  // A source that fails to load tells the owner, which keeps its fallback.
  assert.match(player, /onError=\{onError\}/);
  // The recording's tint is the file type's, through the design tokens.
  assert.match(styles, /--audio-tint: var\(--ds-filetype-audio, var\(--ds-accent\)\);/);
  assert.match(styles, /--audio-progress/);
  assert.match(icons, /export const IconPause = mingcute\("pause"\);/);
  // No surface keeps the browser's control.
  for (const [name, source] of [["hover card", hoverCard], ["file tab", filesTab], ["mention", mention], ["markdown", markdown]]) {
    assert.doesNotMatch(source, /<audio\s[^>]*\scontrols/, `${name} still renders a native audio control`);
    assert.match(source, /<AudioPlayer\b/, `${name} does not use the player`);
  }
});
