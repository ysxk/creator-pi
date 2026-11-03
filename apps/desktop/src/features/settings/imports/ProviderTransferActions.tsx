import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { providerTransferEligible, type ProviderPublic } from "@pi-desktop/shared";
import { Button, Checkbox, portalOverlay } from "../../../components/ui";
import { useBlockingOverlay } from "../../../lib/blocking-overlay";
import { useAppStore } from "../../../stores/app-store";
import { useProviderTransfer } from "./useProviderTransfer";
import "./provider-transfer.css";

type Transfer = ReturnType<typeof useProviderTransfer>;

export function ProviderTransferActions() {
  const { t } = useTranslation();
  const providers = useAppStore((state) => state.providers);
  const transfer = useProviderTransfer();
  return <>
    <Button disabled={transfer.busy} onClick={() => void transfer.openImport()}>{t("channelTransfer.importFile")}</Button>
    <Button disabled={transfer.busy} onClick={transfer.openExport}>{t("channelTransfer.exportFile")}</Button>
    {!transfer.mode && transfer.error ? <span role="alert">{t(`channelTransfer.${transfer.error}`)}</span> : null}
    {transfer.exported !== null ? <span role="status">{t("channelTransfer.exported", { count: transfer.exported })}</span> : null}
    {transfer.mode ? <ProviderTransferDialog key={transfer.mode} providers={providers} transfer={transfer} /> : null}
  </>;
}

function ProviderTransferDialog({ providers, transfer }: { providers: ProviderPublic[]; transfer: Transfer }) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const current = useRef(transfer);
  current.current = transfer;
  const importing = transfer.mode === "import";
  const [selected, setSelected] = useState(() => new Set(importing
    ? transfer.preview?.channels.map((channel) => String(channel.index)) ?? []
    : providers.filter(providerTransferEligible).map((provider) => provider.id)));
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const choices = importing ? transfer.preview?.channels.map((channel) => String(channel.index)) ?? []
    : providers.filter(providerTransferEligible).map((provider) => provider.id);
  const chosen = choices.filter((key) => selected.has(key));
  const all = choices.length > 0 && chosen.length === choices.length;
  const toggle = (key: string, on: boolean) => setSelected((previous) => {
    const next = new Set(previous); if (on) next.add(key); else next.delete(key); return next;
  });
  useLayoutEffect(() => { if (transfer.result) dialog.current?.focus(); }, [transfer.result]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); current.current.close(); }
      if (event.key !== "Tab") return;
      const nodes = dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])");
      if (!nodes?.length) { event.preventDefault(); return; }
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      const outside = !dialog.current?.contains(document.activeElement);
      if (event.shiftKey && (outside || document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (outside || document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("keydown", keydown, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  return portalOverlay(<div className="overlay" onClick={(event) => { if (event.target === event.currentTarget) transfer.close(); }}>
    <div ref={dialog} className="dialog channel-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby={id} aria-describedby={`${id}-description`} tabIndex={-1} aria-busy={transfer.busy}>
      <h3 id={id}>{t(importing ? "channelTransfer.importFile" : "channelTransfer.exportFile")}</h3>
      <p id={`${id}-description`}>{t(importing ? "channelTransfer.importDescription" : "channelTransfer.exportDescription")}</p>
      {transfer.error ? <p role="alert">{t(`channelTransfer.${transfer.error}`)}</p> : null}
      {transfer.result ? <div className="channel-transfer-list" role="status">
        {transfer.result.items.map((item) => <p key={item.index}>
          <strong>{transfer.preview?.channels[item.index]?.name}</strong>{" — "}{t(`channelTransfer.${item.status}`)}
          {item.status === "cleanupFailed" ? <code>{item.providerId}</code> : null}
        </p>)}
      </div> : <>
        <Checkbox label={t("channelTransfer.selectAll")} checked={all} indeterminate={chosen.length > 0 && !all} disabled={transfer.busy || !choices.length}
          onChange={(event) => setSelected(new Set(event.target.checked ? choices : []))} />
        <div className="channel-transfer-list">
          {importing ? transfer.preview?.channels.map((channel) => <div className="channel-transfer-row" key={channel.index}>
            <Checkbox label={channel.name} checked={selected.has(String(channel.index))} disabled={transfer.busy} onChange={(event) => toggle(String(channel.index), event.target.checked)} />
            <p>{channel.protocol}{" · "}{t("channelTransfer.models", { count: channel.modelCount })}{" · "}{t(channel.enabled ? "channelTransfer.enabled" : "channelTransfer.disabled")}</p>
            <p>{t(channel.hasApiKey ? "channelTransfer.hasKey" : "channelTransfer.noKey")}{channel.hasHeaders ? ` · ${t("channelTransfer.hasHeaders")}` : ""}</p>
            {channel.sameName ? <p>{t("channelTransfer.sameName")}</p> : null}
          </div>) : providers.map((provider) => <div className="channel-transfer-row" key={provider.id}>
            <Checkbox label={provider.name} checked={selected.has(provider.id)} disabled={transfer.busy || !providerTransferEligible(provider)} onChange={(event) => toggle(provider.id, event.target.checked)} />
            <p>{provider.ownerPluginId ? t("channelTransfer.pluginExcluded") : provider.authKind === "oauth" ? t("channelTransfer.oauthExcluded") : t("channelTransfer.models", { count: provider.models.length })}</p>
          </div>)}
          {!choices.length ? <p>{t("channelTransfer.empty")}</p> : null}
        </div>
        {!importing ? <>
          <Checkbox label={t("channelTransfer.includeSecrets")} checked={includeSecrets} disabled={transfer.busy} onChange={(event) => setIncludeSecrets(event.target.checked)} />
          {includeSecrets ? <p role="note" className="channel-transfer-warning">{t("channelTransfer.secretWarning")}</p> : null}
        </> : null}
      </>}
      <div className="channel-transfer-footer">
        <Button disabled={transfer.busy} onClick={transfer.close}>{t("channelTransfer.close")}</Button>
        {!transfer.result ? <Button variant="primary" disabled={transfer.busy || !chosen.length || (importing && Boolean(transfer.error))}
          onClick={() => void (importing ? transfer.confirm(chosen.map(Number)) : transfer.exportFile(chosen, includeSecrets))}>
          {t(transfer.busy ? "channelTransfer.working" : importing ? "channelTransfer.confirmImport" : "channelTransfer.exportFile")}
        </Button> : null}
      </div>
    </div>
  </div>);
}
