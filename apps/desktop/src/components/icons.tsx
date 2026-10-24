import { createElement, type CSSProperties, type ReactNode, type SVGProps } from "react";
import { Code2, Workflow, type LucideIcon, type LucideProps } from "lucide-react";
import {
  MINGCUTE_GLYPHS,
  type MingcuteGlyph,
  type MingcuteNode,
} from "./mingcute-icons.generated";

/*
 * App chrome draws MingCute glyphs (D702). The SVG data is generated from the
 * pinned @iconify-json/mingcute package by scripts/generate-mingcute-icons.mjs,
 * which reads the `mingcute("…")` names below: add a glyph here, then rerun it.
 */

export type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
  /** Selected/active state: draw the solid variant of the same glyph. */
  filled?: boolean;
};

/**
 * Icon sizes are fixed px attributes. Multiply them by `--font-scale` so
 * chrome glyphs stay in proportion with the Appearance type scale (D343).
 */
function scaledIconBox(size: IconProps["size"] = 16): string {
  if (typeof size === "number" && Number.isFinite(size)) {
    return `calc(${size}px * var(--font-scale))`;
  }
  if (typeof size === "string" && size.trim()) {
    const value = size.trim();
    return /[a-z%]+$/i.test(value)
      ? `calc(${value} * var(--font-scale))`
      : `calc(${value}px * var(--font-scale))`;
  }
  return "calc(16px * var(--font-scale))";
}

function withScaledIconStyle(
  size: IconProps["size"],
  style?: CSSProperties,
): CSSProperties {
  const box = scaledIconBox(size);
  return { width: box, height: box, ...style };
}

function glyphFor(base: string, variant: "line" | "fill"): MingcuteGlyph {
  const glyph = MINGCUTE_GLYPHS[`${base}-${variant}`];
  if (!glyph) {
    throw new Error(`MingCute glyph "${base}-${variant}" is not generated; run scripts/generate-mingcute-icons.mjs`);
  }
  return glyph;
}

function renderNodes(nodes: readonly MingcuteNode[]): ReactNode[] {
  return nodes.map(([tag, attrs, children], index) =>
    createElement(tag, { key: index, ...attrs }, children ? renderNodes(children) : undefined),
  );
}

/*
 * A uniform stroke width lives on the <svg> (as Lucide's did), so a caller's
 * `strokeWidth` and CSS such as `.thread-item-status svg` still reach it.
 */
function mingcute(base: string, defaults: { filled?: boolean } = {}) {
  const line = glyphFor(base, "line");
  const fill = glyphFor(base, "fill");
  return function Icon({
    size = 16,
    filled = defaults.filled ?? false,
    style,
    strokeWidth,
    ...props
  }: IconProps) {
    const glyph = filled ? fill : line;
    const labelled = props["aria-label"] !== undefined || props["aria-labelledby"] !== undefined;
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox={glyph.viewBox}
        fill="none"
        aria-hidden={labelled ? undefined : true}
        {...(glyph.strokeWidth !== undefined ? { strokeWidth: strokeWidth ?? glyph.strokeWidth } : {})}
        {...props}
        style={withScaledIconStyle(size, style)}
      >
        {renderNodes(glyph.nodes)}
      </svg>
    );
  };
}

/*
 * Conversation content keeps Lucide for now: code-block and mermaid headers
 * render inside the transcript, which D702 leaves out of the MingCute switch.
 */
function lucide(Lucide: LucideIcon) {
  return function Icon({ size = 16, style, ...props }: LucideProps) {
    return (
      <Lucide
        size={size}
        strokeWidth={1.75}
        {...props}
        style={withScaledIconStyle(size, style)}
      />
    );
  };
}

export const IconCodeBlock = lucide(Code2);
export const IconDiagram = lucide(Workflow);

export const IconPlus = mingcute("add");
export const IconPower = mingcute("power");
export const IconPause = mingcute("pause");
export const IconPlay = mingcute("play");
export const IconBookOpen = mingcute("book-2");
/** Paste-from-clipboard actions (MCP config import). */
export const IconClipboard = mingcute("paste");
export const IconArchive = mingcute("archive");
export const IconArchiveRestore = mingcute("inbox");
export const IconActivity = mingcute("heartbeat");
export const IconArrowUpDown = mingcute("transfer-vertical");
export const IconSearch = mingcute("search");
export const IconRefresh = mingcute("refresh-2");
export const IconChat = mingcute("chat-3");
/** Session creation affordance. Keep it distinct from generic add actions. */
export const IconNewSession = mingcute("edit-3");
export const IconFolder = mingcute("folder");
export const IconFolderOpen = mingcute("folder-open");
export const IconNewProject = mingcute("new-folder");
export const IconGripVertical = mingcute("dots-vertical");
export const IconFileText = mingcute("document");
export const IconGlobe = mingcute("world-2");
export const IconBranch = mingcute("git-branch");
export const IconTerminal = mingcute("terminal-box");
export const IconPencil = mingcute("pencil");
export const IconWrench = mingcute("tool");
export const IconPullRequest = mingcute("git-pull-request");
export const IconClock = mingcute("time");
export const IconAt = mingcute("at");
export const IconSettings = mingcute("settings-3");
export const IconHelp = mingcute("question");
export const IconPanel = mingcute("layout-right");
export const IconPanelOpen = mingcute("layout-rightbar-open");
export const IconPanelMaximize = mingcute("fullscreen");
export const IconPanelRestore = mingcute("fullscreen-exit");
export const IconDiff = mingcute("document-2");
export const IconSidebar = mingcute("layout-left");
export const IconArrowUp = mingcute("arrow-up");
export const IconArrowDown = mingcute("arrow-down");
export const IconCopy = mingcute("copy-2");
/* Chat context menus: hand a message's rendered text to the platform selection. */
export const IconTextSelect = mingcute("cursor-text");
export const IconCode = mingcute("code");
export const IconDatabase = mingcute("storage");
export const IconCheck = mingcute("check");
export const IconBell = mingcute("notification");
export const IconBot = mingcute("robot");
export const IconCheckCheck = mingcute("checks");
export const IconShield = mingcute("shield");
export const IconChevronDown = mingcute("down");
export const IconClose = mingcute("close");
/* Frameless window chrome (WindowControls): minimize / maximize / restore. */
export const IconMinus = mingcute("minimize");
export const IconSquare = mingcute("square");
export const IconSliders = mingcute("settings-6");
export const IconConfig = mingcute("refresh-2");
export const IconChevronLeft = mingcute("left");
export const IconExternal = mingcute("external-link");
export const IconArrowUpRight = mingcute("arrow-right-up");
export const IconChevronRight = mingcute("right");
export const IconChevronUp = mingcute("up");
export const IconUndo2 = mingcute("back-2");
export const IconCloudDown = mingcute("download-3");
export const IconDownload = mingcute("download-2");
export const IconImage = mingcute("pic");
export const IconCamera = mingcute("camera-2");
/* Composer attachment chips: one glyph per file family. */
export const IconSheet = mingcute("table-2");
export const IconAudio = mingcute("music-2");
export const IconVideo = mingcute("video");
export const IconReview = mingcute("refresh-3");
export const IconKeyboard = mingcute("keyboard");
export const IconMic = mingcute("mic");
export const IconMicOff = mingcute("mic-off");
export const IconWaveform = mingcute("voice");
export const IconPhoneOff = mingcute("phone-off");
export const IconVolume = mingcute("volume");
export const IconPlug = mingcute("plugin-2");
export const IconSlash = mingcute("command");
export const IconUser = mingcute("user-3");
/** A signed-in vendor account, as opposed to a pasted key. */
export const IconKey = mingcute("key-2");
export const IconLogOut = mingcute("exit");
export const IconSparkles = mingcute("sparkles");
export const IconListChecks = mingcute("list-check");
/** Goal mode: an outcome to reach, as opposed to Plan's list of steps. */
export const IconTarget = mingcute("target");
export const IconBrowser = mingcute("web");
export const IconHook = mingcute("webhook");
export const IconWorkflow = mingcute("route");
export const IconLink = mingcute("link");
export const IconPalette = mingcute("palette");
export const IconPerson = mingcute("emoji");
export const IconInfo = mingcute("information");
export const IconServer = mingcute("server");
export const IconSun = mingcute("sun");
export const IconMoon = mingcute("moon");
export const IconMonitor = mingcute("computer");
export const IconPet = mingcute("paw");
export const IconSnapshot = mingcute("refresh-1");
export const IconGear = mingcute("settings-3");
export const IconPin = mingcute("pin-2");
export const IconMore = mingcute("more-1");
export const IconX = mingcute("close");
export const IconTrash = mingcute("delete-2");
export const IconStar = mingcute("star");
/* Toast status glyphs (see ToastHost) */
export const IconCircleCheck = mingcute("check-circle");
export const IconCircleAlert = mingcute("warning");
export const IconTriangleAlert = mingcute("alert");
/* Password field reveal toggle (see PasswordInput). */
export const IconEye = mingcute("eye-2");
export const IconEyeOff = mingcute("eye-close");

export const IconStop = mingcute("stop", { filled: true });
/* Solid small round dot (status markers). */
export const IconDot = mingcute("round", { filled: true });

/** VS Code brand mark (settings open-target pill) — logos stay custom, no MingCute equivalent. */
export function IconVSCode(props: SVGProps<SVGSVGElement> & { size?: number }) {
  const { size = 14, style, ...rest } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      {...rest}
      style={withScaledIconStyle(size, style)}
    >
      <path
        d="M17.5 2.6 21 4.2v15.6l-3.5 1.6-9.2-7.2L3 17V7l5.3-2.8 9.2 7.2V2.6Z"
        fill="#0078D4"
      />
      <path
        d="M17.5 2.6v11.4L8.3 7.2 17.5 2.6Z"
        fill="#0090F1"
        opacity="0.92"
      />
      <path
        d="M8.3 16.8 17.5 21.4V10.6L8.3 16.8Z"
        fill="#0065A9"
        opacity="0.95"
      />
    </svg>
  );
}
