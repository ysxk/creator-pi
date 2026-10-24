import type { BrowserWindow, WebContents } from "electron";
import type { BrowserState } from "@pi-desktop/shared";
import type { BrowserPane } from "./browser-view";
import { BrowserCdp } from "./browser-cdp";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const BROWSER_PLUGIN_ID = "pi.browser";
export const BROWSER_VIEW_ID = "browser";
/** Work-panel tab id prefix the renderer uses for Browser plugin tabs. */
const BROWSER_TAB_ID_PREFIX = `plugin:${BROWSER_PLUGIN_ID}/${BROWSER_VIEW_ID}`;
const BROWSER_CDP_TIMEOUT_MS = 30_000;

export type BrowserRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserNavigateInput = {
  url?: string;
  path?: string;
};

/**
 * Translate a plugin-page hole into window coordinates and clamp it so the
 * guest cannot cover chat/composer outside the calling plugin view.
 */
export function clampGuestBounds(
  view: BrowserRect,
  hole: BrowserRect,
): BrowserRect | null {
  const x = Math.max(view.x, view.x + hole.x);
  const y = Math.max(view.y, view.y + hole.y);
  const right = Math.min(view.x + view.width, view.x + hole.x + hole.width);
  const bottom = Math.min(view.y + view.height, view.y + hole.y + hole.height);
  const width = Math.floor(right - x);
  const height = Math.floor(bottom - y);
  if (width < 1 || height < 1) return null;
  return {
    x: Math.floor(x),
    y: Math.floor(y),
    width,
    height,
  };
}

function asRect(value: unknown): BrowserRect | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  const width = Number(record.width);
  const height = Number(record.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  return { x, y, width, height };
}

export type BrowserHostDeps = {
  createPane: (onState: (state: BrowserState) => void, onOpenUrl: (url: string) => void) => BrowserPane;
  onOpenUrl?: (url: string, sessionId?: string) => void;
  isPluginLoaded: (pluginId: string) => boolean;
  getFileRoot: (sessionId?: string) => Promise<string | null>;
  getScratchDir?: (sessionId?: string) => string | null;
  onState: (state: BrowserState) => void;
  /** List a host-created tab in that session's work panel (D703). */
  openTab?: (sessionId: string, tabId: string, location: BrowserNavigateInput) => void;
};

type ChromeSurface = {
  pluginId: string;
  viewId: string;
  visible: boolean;
  bounds: BrowserRect;
};

type BrowserPage = {
  key: string;
  sessionId: string;
  tabId: string | null;
  pane: BrowserPane;
  cdp: BrowserCdp;
  state: BrowserState | null;
  started: boolean;
  navigationVersion: number;
  navigating: boolean;
};

/**
 * Bound any CDP round trip on the guest. A page that opens a native dialog
 * or runs a busy loop never answers `debugger.sendCommand`, and neither the
 * CDP layer nor the RPC timeout table bounds it (#1611) — without this the
 * agent's browser tool call hangs forever. On timeout the whole debugger
 * session is detached as recovery, which also drops previously created
 * snapshot uids; the tool result explains the timeout so the agent can
 * re-snapshot.
 */
function withCdpDeadline<T>(
  page: BrowserPage,
  wc: WebContents,
  run: () => Promise<T>,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = Object.assign(
        new Error(`browser ${label} timed out after ${BROWSER_CDP_TIMEOUT_MS}ms`),
        { code: "TIMEOUT" },
      );
      reject(error);
      try {
        page.cdp.detach(wc);
      } catch {
        // Preserve the timeout result if the guest is already shutting down.
      }
    }, BROWSER_CDP_TIMEOUT_MS);
  });
  return Promise.race([Promise.resolve().then(run), timedOut])
    .finally(() => { if (timeout) clearTimeout(timeout); });
}

function captureScreenshotWithDeadline<T>(
  page: BrowserPage,
  capture: (wc: WebContents) => Promise<T>,
): Promise<T> {
  return page.pane.captureScreenshot((wc) =>
    withCdpDeadline(page, wc, () => capture(wc), "screenshot"),
  );
}

/** Host-owned pages, keyed by conversation and resource tab. */
export class BrowserHost {
  private readonly deps: BrowserHostDeps;
  private readonly pages = new Map<string, BrowserPage>();
  private readonly locations = new Map<string, string>();
  private readonly selectedTabs = new Map<string, string | null>();
  private readonly pendingSessions = new Map<string, string>();
  private readonly pendingTabs = new Set<string>();
  private active: BrowserPage | null = null;
  private window: BrowserWindow | null = null;
  private chrome: ChromeSurface | null = null;
  private hole: BrowserRect | null = null;
  private holePluginId: string | null = null;

  constructor(deps: BrowserHostDeps) { this.deps = deps; }

  setWindow(window: BrowserWindow | null): void {
    this.window = window;
    if (!window) { this.disposeGuest(); return; }
    for (const page of this.pages.values()) page.pane.setWindow(window);
    this.applyGuest();
  }

  setChromeSurface(surface: ChromeSurface | null): void {
    this.chrome = surface;
    this.applyGuest();
  }

  getContext(): { sessionId?: string; tabId?: string } {
    return this.active ? this.contextFor(this.active) : {};
  }

  private contextFor(page: BrowserPage): { sessionId?: string; tabId?: string } {
    return {
      ...(page.sessionId ? { sessionId: page.sessionId } : {}),
      ...(page.tabId ? { tabId: page.tabId } : {}),
    };
  }

  private assertBrowserViewVisible(): void {
    if (
      this.chrome?.visible === true &&
      this.chrome.pluginId === BROWSER_PLUGIN_ID &&
      this.chrome.viewId === BROWSER_VIEW_ID
    ) return;
    throw Object.assign(
      new Error("Browser view must be visible before browser operations can run"),
      { code: "UNAVAILABLE" },
    );
  }

  private key(sessionId: string, tabId: string | null): string {
    return JSON.stringify([sessionId, tabId]);
  }

  /**
   * A session's selected Browser page, on screen or not. Agent calls resolve
   * through this, so they never reach the page of whichever session the user
   * happens to be viewing (D703).
   */
  private sessionPage(sessionId: string): BrowserPage | null {
    const tab = this.selectedTabs.get(sessionId);
    if (tab === undefined) return null;
    return this.pages.get(this.key(sessionId, tab)) ?? null;
  }

  /** Create a Browser tab for a session and have the renderer list it. */
  private openSessionTab(sessionId: string, location: BrowserNavigateInput): BrowserPage {
    const tabId = `${BROWSER_TAB_ID_PREFIX}:agent-${randomUUID().slice(0, 8)}`;
    const page = this.pageFor(sessionId, tabId);
    this.selectedTabs.set(sessionId, tabId);
    this.deps.openTab?.(sessionId, tabId, location);
    return page;
  }

  /**
   * The page a page-level call acts on. A call made for an agent session
   * uses that session's own page whether or not it is visible; a call with no
   * session keeps the visible-view rule and acts on the page on screen.
   */
  private callerPage(sessionId?: string): BrowserPage {
    const id = sessionId?.trim();
    if (!id) {
      this.assertBrowserViewVisible();
      if (!this.active?.started) throw Object.assign(new Error("browser guest is not available"), { code: "UNAVAILABLE" });
      return this.active;
    }
    const page = this.sessionPage(id);
    if (page?.started) return page;
    throw Object.assign(
      new Error(page?.navigating
        ? "This session's Browser page is still loading; retry once navigate returns"
        : "This session has no open Browser page; call BrowserPreview or Browser navigate first"),
      { code: "UNAVAILABLE" },
    );
  }

  private pageFor(sessionId: string, tabId: string | null): BrowserPage {
    const key = this.key(sessionId, tabId);
    const existing = this.pages.get(key);
    if (existing) return existing;
    const page: BrowserPage = {
      key, sessionId, tabId, cdp: new BrowserCdp(), state: null,
      started: false, navigationVersion: 0, navigating: false,
      pane: this.deps.createPane(
        (state) => {
          if (this.pages.get(key) !== page) return;
          page.state = state;
          if (state.url && !page.navigating && !this.pendingTabs.has(key)) this.locations.set(key, state.url);
          if (this.active === page) this.publishCurrent();
        },
        (url) => {
          if (this.pages.get(key) === page) this.deps.onOpenUrl?.(url, sessionId || undefined);
        },
      ),
    };
    page.pane.setWindow(this.window);
    this.pages.set(key, page);
    return page;
  }

  private publishCurrent(): void {
    const state = this.getState();
    this.deps.onState(state ?? {
      url: "", title: "", isLoading: false, canGoBack: false, canGoForward: false,
      ...this.getContext(),
    });
  }

  setChromeSession(sessionId: string | undefined, tabId?: string, location?: string): boolean {
    const id = sessionId?.trim() || "";
    const tab = tabId ?? (this.active?.sessionId === id
      ? this.active.tabId : this.selectedTabs.get(id) ?? null);
    const page = this.pageFor(id, tab);
    if (this.active === page) return false;
    this.active?.pane.setVisible(false);
    this.active = page;
    this.selectedTabs.set(id, tab);
    const pending = this.pendingSessions.get(id);
    if (pending) {
      this.locations.set(page.key, pending);
      this.pendingTabs.add(page.key);
      this.pendingSessions.delete(id);
    }
    const target = this.locations.get(page.key) ?? location?.trim();
    const navigate = this.pendingTabs.delete(page.key) || (!page.started && !page.navigating);
    if (target && navigate) {
      page.started = false;
      page.state = null;
      this.publishCurrent();
      this.applyGuest();
      void this.navigatePage(page, target).catch((error) => {
        console.warn("Browser tab restore failed", error);
      });
    } else {
      this.publishCurrent();
      this.applyGuest();
    }
    return true;
  }

  setGuestHole(pluginId: string, hole: unknown): BrowserRect | null {
    this.hole = asRect(hole);
    this.holePluginId = pluginId;
    this.applyGuest();
    return this.guestBounds();
  }

  setGuestVisible(pluginId: string, visible: boolean): void {
    if (!visible && this.holePluginId === pluginId) {
      this.active?.pane.setVisible(false);
    } else if (visible) {
      this.applyGuest();
    }
  }

  rememberLocation(sessionId: string | undefined, location: string): void {
    const id = sessionId?.trim();
    const target = location.trim();
    if (!id || !target) return;
    const tabId = this.selectedTabs.get(id);
    if (tabId != null) {
      const key = this.key(id, tabId);
      this.locations.set(key, target);
      if (this.active?.key !== key) this.pendingTabs.add(key);
    } else {
      this.pendingSessions.set(id, target);
    }
  }

  async navigate(input: BrowserNavigateInput, sessionId?: string, tabId?: string): Promise<BrowserState | null> {
    this.assertBrowserViewVisible();
    const target = String(input.path ?? input.url ?? "").trim();
    if (!target) return this.getState();
    const id = sessionId?.trim() || this.active?.sessionId || "";
    if (tabId !== undefined) {
      const page = this.pages.get(this.key(id, tabId));
      return page ? this.navigatePage(page, target, true) : null;
    }
    if (!this.active) {
      this.active = this.pageFor(id, this.selectedTabs.get(id) ?? null);
      this.selectedTabs.set(id, this.active.tabId);
    }
    if (id !== this.active.sessionId) {
      this.rememberLocation(id, target);
      return null;
    }
    return this.navigatePage(this.active, target, true);
  }

  /**
   * Navigate for an agent tool call made in `sessionId` (D703). The session's
   * selected tab loads now, visible or not; a session without one gets a new
   * tab, listed in its work panel.
   */
  async navigateForSession(input: BrowserNavigateInput, sessionId: string): Promise<BrowserState | null> {
    const target = String(input.path ?? input.url ?? "").trim();
    const page = this.sessionPage(sessionId);
    if (!target) return page?.state ? { ...page.state, ...this.contextFor(page) } : null;
    return this.navigatePage(page ?? this.openSessionTab(sessionId, input), target);
  }

  private async navigatePage(page: BrowserPage, target: string, requireVisible = false): Promise<BrowserState | null> {
    const version = ++page.navigationVersion;
    const previousLocation = this.locations.get(page.key);
    page.navigating = true;
    this.locations.set(page.key, target);
    const current = () => this.pages.get(page.key) === page && page.navigationVersion === version;
    const assertVisible = () => {
      if (!requireVisible) return;
      try {
        this.assertBrowserViewVisible();
      } catch (error) {
        page.navigating = false;
        if (previousLocation === undefined) this.locations.delete(page.key);
        else this.locations.set(page.key, previousLocation);
        throw error;
      }
    };
    let root: string | null;
    try {
      root = await this.deps.getFileRoot(page.sessionId || undefined);
    } catch (error) {
      if (!current()) return null;
      assertVisible();
      page.navigating = false;
      page.started = false;
      page.state = { url: target, title: "", isLoading: false, canGoBack: false,
        canGoForward: false, loadError: error instanceof Error ? error.message : String(error) };
      if (this.active === page) { this.publishCurrent(); this.applyGuest(); }
      return null;
    }
    if (!current()) return null;
    assertVisible();
    let state: BrowserState | null;
    try {
      state = await page.pane.navigateAndWait(target, root);
    } catch (error) {
      if (!current()) return null;
      page.navigating = false;
      page.started = false;
      page.state = { url: target, title: "", isLoading: false, canGoBack: false,
        canGoForward: false, loadError: error instanceof Error ? error.message : String(error) };
      if (this.active === page) { this.publishCurrent(); this.applyGuest(); }
      return null;
    }
    if (!current()) return null;
    page.navigating = false;
    page.started = state !== null;
    page.state = state ?? page.pane.getState();
    if (!this.pendingTabs.has(page.key)) this.locations.set(page.key, state?.url || target);
    if (!state && !page.state?.loadError) {
      page.state = { url: target, title: "", isLoading: false,
        canGoBack: false, canGoForward: false, loadError: "INVALID_URL" };
    }
    if (this.active === page) { this.publishCurrent(); this.applyGuest(); }
    return state ? { ...state, ...this.contextFor(page) } : null;
  }

  action(action: "back" | "forward" | "reload" | "stop", sessionId?: string, tabId?: string): void {
    this.assertBrowserViewVisible();
    const page = sessionId !== undefined && tabId !== undefined
      ? this.pages.get(this.key(sessionId, tabId)) : this.active;
    if (page?.state) page.pane.action(action);
  }

  getState(): BrowserState | null {
    return this.active?.state ? { ...this.active.state, ...this.getContext() } : null;
  }

  getStateForPlugin(): BrowserState | null {
    this.assertBrowserViewVisible();
    return this.getState();
  }

  openExternal(sessionId?: string, tabId?: string): void {
    this.assertBrowserViewVisible();
    const page = sessionId !== undefined && tabId !== undefined
      ? this.pages.get(this.key(sessionId, tabId)) : this.active;
    if (page?.started) page.pane.openExternal();
  }

  private requireWebContents(page: BrowserPage) {
    const wc = page.pane.getWebContents();
    if (!wc || wc.isDestroyed()) throw Object.assign(new Error("browser guest is not available"), { code: "UNAVAILABLE" });
    return wc;
  }

  async snapshot(sessionId?: string): Promise<{ tree: string; url: string; title: string }> {
    const page = this.callerPage(sessionId);
    const wc = this.requireWebContents(page);
    return withCdpDeadline(page, wc, () => page.cdp.snapshot(wc), "snapshot");
  }

  async screenshot(input: { fullPage?: boolean } = {}, sessionId?: string): Promise<{ mimeType: string; data: string; path?: string }> {
    const page = this.callerPage(sessionId);
    const shot = await captureScreenshotWithDeadline(page, (wc) => page.cdp.screenshot(wc, input));
    const scratch = this.deps.getScratchDir?.(sessionId ?? page.sessionId);
    if (!scratch) return shot;
    try {
      mkdirSync(scratch, { recursive: true });
      const path = join(scratch, `browser-screenshot-${Date.now()}.jpg`);
      writeFileSync(path, Buffer.from(shot.data, "base64"));
      return { ...shot, path };
    } catch { return shot; }
  }

  async click(uid: string, sessionId?: string): Promise<void> {
    const page = this.callerPage(sessionId);
    const wc = this.requireWebContents(page);
    return withCdpDeadline(page, wc, () => page.cdp.click(wc, uid), "click");
  }
  async fill(uid: string, text: string, sessionId?: string): Promise<void> {
    const page = this.callerPage(sessionId);
    const wc = this.requireWebContents(page);
    return withCdpDeadline(page, wc, () => page.cdp.fill(wc, uid, text), "fill");
  }
  async evaluate(expression: string, sessionId?: string): Promise<unknown> {
    const page = this.callerPage(sessionId);
    const wc = this.requireWebContents(page);
    return withCdpDeadline(page, wc, () => page.cdp.evaluate(wc, expression), "evaluate");
  }
  console(limit?: number, sessionId?: string): { messages: ReturnType<BrowserCdp["console"]> } {
    const id = sessionId?.trim();
    if (!id) this.assertBrowserViewVisible();
    const page = id ? this.sessionPage(id) : this.active;
    if (!page?.started) return { messages: [] };
    const wc = this.requireWebContents(page);
    void page.cdp.attach(wc);
    return { messages: page.cdp.console(limit) };
  }
  async cdpCommand(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    const page = this.callerPage(sessionId);
    const wc = this.requireWebContents(page);
    if (method === "Page.captureScreenshot") {
      return captureScreenshotWithDeadline(page, (view) => page.cdp.send(view, method, params));
    }
    return withCdpDeadline(page, wc, () => page.cdp.send(wc, method, params), `cdp ${method}`);
  }

  /**
   * Open a workspace file in a new Browser tab of `sessionId` and load it
   * there, whether or not that session is on screen (D703). The renderer lists
   * the tab through `openTab`; it does not navigate it again.
   */
  async previewWorkspaceFile(
    sessionId: string,
    path: string,
  ): Promise<{ ok: true; loadError?: string } | { ok: false; content: string }> {
    if (!this.deps.isPluginLoaded(BROWSER_PLUGIN_ID)) return {
      ok: false, content: "BrowserPreview: the Browser plugin is disabled. Enable pi.browser in Plugins to preview HTML.",
    };
    const page = this.openSessionTab(sessionId, { path });
    const state = await this.navigatePage(page, path);
    const loadError = state ? undefined : page.state?.loadError;
    return loadError ? { ok: true, loadError } : { ok: true };
  }

  closeTab(sessionId: string, tabId: string | null): void {
    const key = this.key(sessionId, tabId);
    const page = this.pages.get(key);
    if (page) {
      this.pages.delete(key);
      page.navigationVersion += 1;
      page.cdp.detach(page.pane.getWebContents() ?? undefined);
      page.pane.dispose();
      if (this.active === page) this.active = null;
    }
    this.locations.delete(key);
    this.pendingTabs.delete(key);
    if (this.selectedTabs.get(sessionId) === tabId) this.selectedTabs.delete(sessionId);
  }

  closeSession(sessionId: string): void {
    for (const page of [...this.pages.values()]) {
      if (page.sessionId !== sessionId) continue;
      this.closeTab(sessionId, page.tabId);
    }
    this.pendingSessions.delete(sessionId);
    this.selectedTabs.delete(sessionId);
    for (const key of this.locations.keys()) {
      if (JSON.parse(key)[0] === sessionId) { this.locations.delete(key); this.pendingTabs.delete(key); }
    }
  }

  dispose(): void { this.disposeGuest(); }

  disposeGuest(): void {
    for (const page of this.pages.values()) {
      page.navigationVersion += 1;
      page.cdp.detach(page.pane.getWebContents() ?? undefined);
      page.pane.dispose();
    }
    this.pages.clear();
    this.active = null;
    this.hole = null;
    this.holePluginId = null;
  }

  private guestBounds(): BrowserRect | null {
    if (!this.chrome?.visible || !this.hole || this.holePluginId !== this.chrome.pluginId) return null;
    return clampGuestBounds(this.chrome.bounds, this.hole);
  }

  private applyGuest(): void {
    if (!this.active) return;
    const bounds = this.guestBounds();
    if (!bounds || !this.active.started) { this.active.pane.setVisible(false); return; }
    this.active.pane.setBounds(bounds);
    this.active.pane.setVisible(true);
  }
}
