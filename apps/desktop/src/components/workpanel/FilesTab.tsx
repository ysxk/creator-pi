import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  isAudioAttachment,
  isVideoAttachment,
  mediaViewUrl,
  type FsEntry,
  type FsReadResult,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { AudioPlayer } from "../AudioPlayer";
import { Markdown } from "../Markdown";
import { FileTypeBadge } from "../FileTypeBadge";
import { fileDirOf } from "../../lib/chat-links";
import { sameFsRead, subscribeToolSettled } from "../../lib/agent-tool-settle";
import { Button, cx } from "../ui";
import { TooltipButton } from "../ui";
import {
  ensureLang,
  getHighlightVersion,
  resolveLang,
  subscribeHighlighter,
  themeForMode,
  tokenizeIncremental,
  type LineCache,
} from "../../lib/shiki";
import {
  IconChevronLeft,
  IconChevronRight,
  IconExternal,
  IconFileText,
  IconFolder,
} from "../icons";
import { WorkTabEmpty } from "./WorkTabEmpty";

const VIEWER_LINE_CAP = 5000;

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  rs: "rust",
  py: "python",
  go: "go",
  sh: "shellscript",
  zsh: "shellscript",
  bash: "shellscript",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  swift: "swift",
  kt: "kotlin",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
};

function langForPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const lang = EXT_LANG[ext] ?? ext;
  return resolveLang(lang);
}

function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path);
}

/**
 * What the host `file:` tab plays inline instead of previewing as text: a
 * clip or a recording named by its extension, or a stored attachment blob
 * whose metadata declares a media type. It streams over the host-owned
 * `pi-media:` scheme; a container the renderer cannot decode falls back to
 * the binary notice, and the OS player stays one button away either way.
 */
function mediaPreviewKind(path: string, mimeType?: string): "audio" | "video" | null {
  if (isAudioAttachment(mimeType, path)) return "audio";
  if (isVideoAttachment(mimeType, path)) return "video";
  return null;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function useThemeMode(): "light" | "dark" {
  return useSyncExternalStore(
    (notify) => {
      const observer = new MutationObserver(notify);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      return () => observer.disconnect();
    },
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
  );
}

function HighlightedText({ path, content }: { path: string; content: string }) {
  const mode = useThemeMode();
  const highlightVersion = useSyncExternalStore(
    subscribeHighlighter,
    getHighlightVersion,
  );
  const lang = langForPath(path);
  const lines = useMemo(() => content.split("\n"), [content]);
  const capped = lines.length > VIEWER_LINE_CAP;
  const visible = useMemo(
    () => (capped ? lines.slice(0, VIEWER_LINE_CAP).join("\n") : content),
    [capped, lines, content],
  );

  const tokens = useMemo<LineCache | null>(() => {
    void highlightVersion;
    if (!lang) return null;
    ensureLang(lang);
    return tokenizeIncremental(null, visible, lang, themeForMode(mode));
  }, [lang, visible, mode, highlightVersion]);

  return (
    <pre className="file-viewer-code">
      {tokens
        ? tokens.tokens.map((row, i) => (
            <div className="file-viewer-line" data-line={i + 1} key={i}>
              {row.length === 0
                ? "\n"
                : row.map((token, j) => (
                    <span key={j} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))}
            </div>
          ))
        : visible.split("\n").map((line, i) => (
            <div className="file-viewer-line" data-line={i + 1} key={i}>
              {line || "\n"}
            </div>
          ))}
      {capped && <div className="file-viewer-cap">…</div>}
    </pre>
  );
}

type DirState = { entries: FsEntry[]; error?: boolean };

// Module-level so a chat preview request fires once, not again on every
// files-tab remount (the tab unmounts when another tool is selected).
let handledFileRequestSeq = 0;

export function FilesTab() {
  const { t } = useTranslation();
  const workspace = useAppStore((s) => s.workspace);
  const fileRequest = useAppStore((s) => s.workPanelFileRequest);
  const showToast = useAppStore((s) => s.showToast);
  const root = workspace?.path ?? null;

  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedMimeType, setSelectedMimeType] = useState<string | undefined>();
  const [selectedLine, setSelectedLine] = useState<number | undefined>();
  const [file, setFile] = useState<FsReadResult | null>(null);
  const [fileError, setFileError] = useState(false);
  /** The inline player could not decode the selected media; show the notice instead. */
  const [mediaFailed, setMediaFailed] = useState(false);
  const viewerBodyRef = useRef<HTMLDivElement>(null);
  /** Bumped when the viewer changes file, so a stale re-read cannot land. */
  const fileGeneration = useRef(0);
  /** A requested line is scrolled to once per open, not after each re-read. */
  const lineJumpPending = useRef(false);

  // Workspace switches reset all browsing state. Guarded so it only fires on
  // an actual root change: an unconditional [root] effect also runs on the
  // StrictMode remount, wiping the selection a chat file request just made
  // (first click landed on the tree instead of the file).
  const prevRoot = useRef(root);
  useEffect(() => {
    if (prevRoot.current === root) return;
    prevRoot.current = root;
    fileGeneration.current += 1;
    setDirs({});
    setExpanded(new Set());
    setSelected(null);
    setSelectedMimeType(undefined);
    setSelectedLine(undefined);
    setFile(null);
    setFileError(false);
    setMediaFailed(false);
  }, [root]);

  const loadDir = useCallback(
    async (rel: string) => {
      if (!root) return;
      try {
        const res = await api.fsList(rel);
        setDirs((prev) => ({ ...prev, [rel]: { entries: res.entries } }));
      } catch {
        setDirs((prev) => ({ ...prev, [rel]: { entries: [], error: true } }));
      }
    },
    [root],
  );

  useEffect(() => {
    if (root && !dirs[""]) void loadDir("");
  }, [root, dirs, loadDir]);

  const toggleDir = useCallback(
    (rel: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(rel)) {
          next.delete(rel);
        } else {
          next.add(rel);
        }
        return next;
      });
      if (!dirs[rel]) void loadDir(rel);
    },
    [dirs, loadDir],
  );

  const openFile = useCallback(
    async (rel: string, mimeType?: string, position?: { line?: number; column?: number }) => {
      fileGeneration.current += 1;
      lineJumpPending.current = position?.line != null;
      setSelected(rel);
      setSelectedMimeType(mimeType);
      setSelectedLine(position?.line);
      setFile(null);
      setFileError(false);
      setMediaFailed(false);
      try {
        setFile(await api.fsRead(rel, mimeType));
      } catch {
        setFileError(true);
      }
    },
    [],
  );

  useEffect(() => {
    if (!file || selectedLine == null || !lineJumpPending.current) return;
    const frame = requestAnimationFrame(() => {
      lineJumpPending.current = false;
      const lineNode = viewerBodyRef.current?.querySelector(
        `[data-line="${selectedLine}"]`,
      );
      lineNode?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [file, selectedLine]);

  const openWithSystem = useCallback(async () => {
    if (!selected) return;
    try {
      await api.fsOpen(selected, selectedMimeType);
    } catch {
      showToast(t("panel.files.openFailed"), { variant: "error" });
    }
  }, [selected, selectedMimeType, showToast, t]);

  // Chat-initiated previews: open the file and expand its ancestor folders
  // so "back" lands on a tree that reveals it. Attachment blobs and absolute
  // scratch paths live outside the workspace tree.
  useEffect(() => {
    if (!fileRequest) return;
    if (fileRequest.seq === handledFileRequestSeq) return;
    handledFileRequestSeq = fileRequest.seq;
    const path = fileRequest.path;
    const isExternal =
      path.startsWith("attachments/") ||
      path.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(path) ||
      path.startsWith("\\\\");
    if (root && !isExternal) {
      const parts = path.split("/").slice(0, -1);
      const ancestors: string[] = [];
      let acc = "";
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        ancestors.push(acc);
      }
      setExpanded((prev) => new Set([...prev, ...ancestors]));
      for (const dir of ancestors) void loadDir(dir);
    }
    void openFile(path, fileRequest.mimeType, {
      line: fileRequest.line,
      column: fileRequest.column,
    });
  }, [fileRequest, root, loadDir, openFile]);

  // After the agent finishes a tool call, re-read the open file and every
  // listed folder so edits, new files and deletions show without reopening.
  // Unchanged results keep their identity; the scroll position stays put.
  const refreshShown = useCallback(async () => {
    const rootAtStart = root;
    const listed = Object.keys(dirs);
    const relist = rootAtStart
      ? listed.map(async (rel) => {
          let next: DirState;
          try {
            next = { entries: (await api.fsList(rel)).entries };
          } catch {
            next = { entries: [], error: true };
          }
          if (prevRoot.current !== rootAtStart) return;
          setDirs((prev) => (prev[rel] ? { ...prev, [rel]: next } : prev));
        })
      : [];
    const reread = (async () => {
      if (selected === null) return;
      const generation = fileGeneration.current;
      try {
        const next = await api.fsRead(selected, selectedMimeType);
        if (generation !== fileGeneration.current) return;
        setFileError(false);
        setFile((prev) => (prev && sameFsRead(prev, next) ? prev : next));
      } catch {
        if (generation !== fileGeneration.current) return;
        setFileError(true);
      }
    })();
    await Promise.all([...relist, reread]);
  }, [root, dirs, selected, selectedMimeType]);

  const refreshShownRef = useRef(refreshShown);
  useEffect(() => {
    refreshShownRef.current = refreshShown;
  }, [refreshShown]);

  useEffect(
    () =>
      subscribeToolSettled(api.onAgentEvent, () => {
        void refreshShownRef.current();
      }),
    [],
  );

  const renderDir = (rel: string, depth: number): React.ReactNode => {
    const state = dirs[rel];
    if (!state) {
      return (
        <div
          className="file-tree-note"
          style={{ paddingLeft: 12 + depth * 14 }}
          key={`${rel}:loading`}
        >
          {t("panel.files.loading")}
        </div>
      );
    }
    if (state.entries.length === 0) {
      return (
        <div
          className="file-tree-note"
          style={{ paddingLeft: 12 + depth * 14 }}
          key={`${rel}:empty`}
        >
          {state.error ? t("panel.files.error") : t("panel.files.empty")}
        </div>
      );
    }
    return state.entries.map((entry) => {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.kind === "dir") {
        const open = expanded.has(childRel);
        return (
          <div key={childRel}>
            <button
              type="button"
              className="file-tree-row"
              style={{ paddingLeft: 12 + depth * 14 }}
              onClick={() => toggleDir(childRel)}
            >
              <span className={cx("file-tree-caret", open && "open")} aria-hidden>
                <IconChevronRight size={12} />
              </span>
              <IconFolder size={14} />
              <span className="file-tree-name">{entry.name}</span>
            </button>
            {open && renderDir(childRel, depth + 1)}
          </div>
        );
      }
      return (
        <button
          key={childRel}
          type="button"
          className={cx("file-tree-row", selected === childRel && "active")}
          style={{ paddingLeft: 12 + depth * 14 + 16 }}
          onClick={() => void openFile(childRel)}
          title={childRel}
        >
          <FileTypeBadge path={entry.name} fallback={<IconFileText size={14} />} />
          <span className="file-tree-name">{entry.name}</span>
        </button>
      );
    });
  };

  if (selected !== null) {
    const media = mediaPreviewKind(selected, selectedMimeType);
    return (
      <div className="file-viewer">
        <div className="file-viewer-header">
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square"
            tooltip={t("panel.files.back")}
            ariaLabel={t("panel.files.back")}
            onClick={() => {
              fileGeneration.current += 1;
              setSelected(null);
              setSelectedMimeType(undefined);
              setSelectedLine(undefined);
              setFile(null);
            }}
          >
            <IconChevronLeft size={14} />
          </TooltipButton>
          <span className="file-viewer-path" title={selected}>
            {selected}
          </span>
          {file && <span className="file-viewer-size">{formatSize(file.size)}</span>}
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square"
            tooltip={t("panel.files.reveal")}
            ariaLabel={t("panel.files.reveal")}
            onClick={() => void api.fsReveal(selected)}
          >
            <IconExternal size={14} />
          </TooltipButton>
        </div>
        <div className="file-viewer-body" ref={viewerBodyRef}>
          {fileError ? (
            <WorkTabEmpty icon={IconFileText} title={t("panel.files.error")} />
          ) : !file ? (
            <div className="file-tree-note">{t("panel.files.loading")}</div>
          ) : media && !mediaFailed ? (
            <div className="file-viewer-media" data-media={media}>
              {media === "video" ? (
                <video
                  controls
                  preload="metadata"
                  src={mediaViewUrl(selected)}
                  title={selected}
                  onError={() => setMediaFailed(true)}
                />
              ) : (
                <AudioPlayer
                  src={mediaViewUrl(selected)}
                  title={selected}
                  onError={() => setMediaFailed(true)}
                />
              )}
              <Button type="button" onClick={() => void openWithSystem()}>
                {t("chat.openFile")}
              </Button>
            </div>
          ) :
          file.kind === "text" &&
          isMarkdownPath(selected) &&
          selectedLine === undefined ? (
            <div className="file-viewer-markdown prose-chat">
              <Markdown source={file.content ?? ""} baseDir={fileDirOf(selected)} />
            </div>
          ) : file.kind === "text" ? (
            <HighlightedText path={selected} content={file.content ?? ""} />
          ) : file.kind === "image" ? (
            <div className="file-viewer-image">
              <img src={file.dataUrl} alt={selected} />
            </div>
          ) : (
            <WorkTabEmpty
              icon={IconFileText}
              title={
                file.kind === "tooLarge"
                  ? t("panel.files.tooLarge")
                  : t("panel.files.binary")
              }
            >
              {media && (
                <Button type="button" onClick={() => void openWithSystem()}>
                  {t("chat.openFile")}
                </Button>
              )}
            </WorkTabEmpty>
          )}
        </div>
      </div>
    );
  }

  if (!root) {
    return (
      <WorkTabEmpty
        icon={IconFolder}
        title={t("panel.files.noWorkspace")}
        body={t("panel.files.noWorkspaceHint")}
      />
    );
  }

  return <div className="file-tree">{renderDir("", 0)}</div>;
}
