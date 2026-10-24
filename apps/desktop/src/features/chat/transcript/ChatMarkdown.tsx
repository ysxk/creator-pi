import { useCallback, useMemo, useRef, useState } from "react";
import { Markdown } from "../../../components/Markdown";
import {
  CHAT_GALLERY_ATTRIBUTE,
  MarkdownChatMediaContext,
  type MarkdownChatMedia,
} from "../../../components/MarkdownChatMedia";
import { mentionedFolders } from "../../../lib/chat-media-refs";
import type { InkClock } from "../../../lib/ink-bloom";
import { GeneratedImageViewer } from "./GeneratedImageViewer";
import type { GeneratedImageRef } from "./GeneratedImageThumbnail";

/** The prose wrapper every assistant reply renders its Markdown inside. */
const REPLY_SCOPE = ".prose-chat";

function leafName(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
}

/**
 * An assistant reply's Markdown, with its media made lookable.
 *
 * The reply lends its tree two things a README or a plan card has no use for:
 * previews under the clips and drawings it names, and a viewer its pictures
 * open in. The viewer steps through the pictures of this one reply, in the
 * order they appear, read from the page when one is clicked so that a picture
 * still streaming in is part of the set by the time it is reached.
 */
export function ChatMarkdown({ source, streaming, inkClock }: {
  source: string;
  streaming?: boolean;
  /** Present while the reply's newest characters bloom in (D695). */
  inkClock?: InkClock;
}) {
  const [viewer, setViewer] = useState<{ images: GeneratedImageRef[]; index: number } | null>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const claims = useRef(new Map<string, string>());

  const openImage = useCallback((trigger: HTMLElement, path: string) => {
    const scope = trigger.closest(REPLY_SCOPE);
    const paths: string[] = [];
    for (const element of scope?.querySelectorAll<HTMLElement>(`[${CHAT_GALLERY_ATTRIBUTE}]`) ?? []) {
      const value = element.getAttribute(CHAT_GALLERY_ATTRIBUTE);
      if (value && !paths.includes(value)) paths.push(value);
    }
    if (!paths.includes(path)) paths.push(path);
    focusReturnRef.current = trigger;
    setViewer({
      images: paths.map((value, index) => ({ path: value, index, name: leafName(value) })),
      index: paths.indexOf(path),
    });
  }, []);

  // Joined so the list is one value while a streaming reply grows around it.
  const folderKey = useMemo(() => mentionedFolders(source).join("\n"), [source]);
  const media = useMemo<MarkdownChatMedia>(
    () => ({
      openImage,
      folders: folderKey ? folderKey.split("\n") : [],
      claim: (file, owner) => {
        if (!claims.current.has(file)) claims.current.set(file, owner);
        return claims.current.get(file) === owner;
      },
      release: (file, owner) => {
        if (claims.current.get(file) === owner) claims.current.delete(file);
      },
    }),
    [openImage, folderKey],
  );

  return (
    <MarkdownChatMediaContext.Provider value={media}>
      <Markdown source={source} streaming={streaming} inkClock={inkClock} />
      {viewer && viewer.images[viewer.index] ? (
        <GeneratedImageViewer
          images={viewer.images}
          selectedIndex={viewer.index}
          onSelect={(index) => setViewer((current) => (current ? { ...current, index } : current))}
          onClose={() => setViewer(null)}
          focusReturnRef={focusReturnRef}
        />
      ) : null}
    </MarkdownChatMediaContext.Provider>
  );
}
