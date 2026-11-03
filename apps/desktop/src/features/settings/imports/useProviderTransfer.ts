import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderTransferPreview, ProviderTransferResult } from "@pi-desktop/shared";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";

export function useProviderTransfer() {
  const [mode, setMode] = useState<"import" | "export" | null>(null);
  const [preview, setPreview] = useState<ProviderTransferPreview | null>(null);
  const [result, setResult] = useState<ProviderTransferResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<number | null>(null);
  const mounted = useRef(false);
  const locked = useRef(false);
  const token = useRef<string | null>(null);
  const release = useCallback((value: string) => {
    void api.cancelProviderImport(value).catch(() => console.warn("Channel preview cleanup failed"));
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (token.current) release(token.current); token.current = null; };
  }, [release]);
  const close = useCallback(() => {
    if (locked.current) return;
    if (token.current) release(token.current);
    token.current = null;
    setPreview(null); setResult(null); setMode(null); setError(null);
  }, [release]);
  const run = async (operation: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null); setExported(null);
    try { await operation(); }
    catch (cause) {
      if (mounted.current) {
        const message = cause instanceof Error ? cause.message : "";
        const key = /CHANNEL_FILE_VERSION/.test(message) ? "version"
          : /CHANNEL_FILE_TOO_LARGE/.test(message) ? "tooLarge"
          : /CHANNEL_FILE_INVALID/.test(message) ? "invalid"
          : /CHANNEL_PREVIEW_INVALID/.test(message) ? "expired"
          : /CHANNEL_SECRET_UNAVAILABLE/.test(message) ? "secretUnavailable" : "failed";
        setError(key);
      }
    } finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  const openImport = () => run(async () => {
    const value = await api.previewProviderImport();
    if (!mounted.current) { if (value) release(value.token); return; }
    if (!value) return;
    token.current = value.token;
    setPreview(value); setResult(null); setMode("import");
  });
  const openExport = () => { if (!locked.current) { setError(null); setExported(null); setMode("export"); } };
  const confirm = (indices: number[]) => run(async () => {
    if (!token.current) return;
    const value = token.current;
    token.current = null;
    const outcome = await api.confirmProviderImport({ token: value, indices });
    if (mounted.current) setResult(outcome);
    await useAppStore.getState().refreshProviders();
  });
  const exportFile = (providerIds: string[], includeSecrets: boolean) => run(async () => {
    const value = await api.exportProvidersFile({ providerIds, includeSecrets });
    if (!mounted.current || !value) return;
    setExported(value.exported); setMode(null);
  });
  return { mode, preview, result, busy, error, exported, openImport, openExport, confirm, exportFile, close };
}
