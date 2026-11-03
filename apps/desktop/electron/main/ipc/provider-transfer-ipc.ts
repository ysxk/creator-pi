import { BrowserWindow, dialog, type IpcMainInvokeEvent, type WebContents } from "electron";
import { IPC, transferError } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";
import { ProviderTransferService } from "../services/provider-transfer";

export function registerProviderTransferIpc({ registrar, getHost }: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
}): void {
  const owners = new WeakMap<WebContents, { host?: HostProcess; service?: ProviderTransferService }>();
  const serviceFor = (event: IpcMainInvokeEvent): ProviderTransferService => {
    registrar.assertMainWindowSender(event);
    const sender = event.sender;
    if (event.senderFrame !== sender.mainFrame) throw transferError("CHANNEL_TRANSFER_FORBIDDEN");
    const owner = BrowserWindow.fromWebContents(sender);
    const host = getHost();
    if (!owner || sender.isDestroyed() || !host) throw transferError("CHANNEL_TRANSFER_UNAVAILABLE");
    let state = owners.get(sender);
    if (!state) {
      state = {};
      owners.set(sender, state);
      const owned = state;
      const clear = () => { owned.service?.close(); owned.service = undefined; owned.host = undefined; };
      sender.once("destroyed", clear);
      sender.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) clear();
      });
    }
    if (!state.service || state.host !== host) {
      state.service?.close();
      state.host = host;
      state.service = new ProviderTransferService(host, {
        open: async () => {
          const result = await dialog.showOpenDialog(owner, { properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] });
          return result.canceled ? undefined : result.filePaths[0];
        },
        save: async () => {
          const result = await dialog.showSaveDialog(owner, { defaultPath: "pi-desktop-channels.json", filters: [{ name: "JSON", extensions: ["json"] }] });
          return result.canceled ? undefined : result.filePath;
        },
      });
    }
    return state.service;
  };
  registrar.handleWithEvent(IPC.invoke.providersImportPreview, async (event) => serviceFor(event).prepare());
  registrar.handleWithEvent(IPC.invoke.providersImportConfirm, async (event, input: unknown) => serviceFor(event).confirm(input));
  registrar.handleWithEvent(IPC.invoke.providersImportCancel, async (event, input: unknown) => { serviceFor(event).cancel(input); return { ok: true }; });
  registrar.handleWithEvent(IPC.invoke.providersExportFile, async (event, input: unknown) => serviceFor(event).export(input));
}
