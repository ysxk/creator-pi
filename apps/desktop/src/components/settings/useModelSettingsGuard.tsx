import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { registerSettingsNavigationGuard } from "../../lib/settings-navigation-guard";
import { Button, portalOverlay } from "../ui";
import { useBlockingOverlay } from "../../lib/blocking-overlay";

function DiscardDialog({ onCancel, onDiscard }: { onCancel: () => void; onDiscard: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  useBlockingOverlay();
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return portalOverlay(<dialog ref={ref} className="dialog model-discard-dialog" aria-labelledby="model-discard-title"
    onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <h2 id="model-discard-title" className="settings-card-heading">{t("settings.modelPrefs.discardTitle")}</h2>
    <p>{t("settings.modelPrefs.discardBody")}</p>
    <div className="model-pref-actions">
      <Button autoFocus variant="secondary" onClick={onCancel}>{t("settings.modelPrefs.keepEditing")}</Button>
      <Button variant="primary" onClick={onDiscard}>{t("settings.modelPrefs.discard")}</Button>
    </div>
  </dialog>);
}

export function useModelSettingsGuard(dirty: boolean, busy: boolean) {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const request = useCallback((action: () => void) => {
    if (busy) return;
    if (dirty) setPending(() => action);
    else action();
  }, [dirty, busy]);
  useLayoutEffect(() => registerSettingsNavigationGuard(request), [request]);
  useLayoutEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  return { request, confirmation: pending ? <DiscardDialog onCancel={() => setPending(null)} onDiscard={() => {
    setPending(null);
    pending();
  }} /> : null };
}
