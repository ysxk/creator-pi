import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { ProviderConfigPage } from "../../apps/desktop/src/components/settings/ProviderConfigPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";

await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", resources: Object.fromEntries(Object.entries(catalogs).map(([key, catalog]) => [key, { translation: flattenCatalog(catalog) }])), interpolation: { escapeValue: false } });
Object.defineProperty(window, "AudioContext", { configurable: true, value: undefined });
const root = createRoot(document.getElementById("root"));
await useAppStore.getState().refreshProviders();
flushSync(() => root.render(<main className="settings-content"><ProviderConfigPage /></main>));

function wait(predicate) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => { if (predicate()) { clearTimeout(timer); observer.disconnect(); resolve(); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error("UI condition timed out")); }, 10000);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  });
}
const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
window.transferProbe = {
  async click(key, inDialog = false) {
    const scope = inDialog ? document.querySelector('[role="dialog"]') : document.getElementById("root");
    const button = [...scope.querySelectorAll("button")].find((node) => node.textContent.trim() === i18n.t(key));
    if (!button || button.disabled) throw new Error(`Button unavailable: ${key}`);
    button.focus(); button.click(); await frame();
  },
  async toggle(key) {
    const label = [...document.querySelectorAll('[role="dialog"] label')].find((node) => node.textContent.trim() === i18n.t(key));
    if (!label) throw new Error(`Checkbox unavailable: ${key}`);
    label.querySelector("input").click(); await frame();
  },
  async waitDialog() { await wait(() => Boolean(document.querySelector('[role="dialog"]'))); },
  async waitClosed() { await wait(() => !document.querySelector('[role="dialog"]')); },
  async waitText(key) { await wait(() => document.documentElement.textContent.includes(i18n.t(key))); },
  async waitCount(count) { await wait(() => document.querySelector('.provider-section-count')?.textContent === String(count)); },
  async locale(value) { await i18n.changeLanguage(value); await frame(); },
  async refresh() { await useAppStore.getState().refreshProviders(); await frame(); },
  state() {
    const dialog = document.querySelector('[role="dialog"]');
    const includes = [...document.querySelectorAll('label')].find((label) => label.textContent.trim() === i18n.t('channelTransfer.includeSecrets'))?.querySelector('input');
    return { text: dialog?.textContent ?? "", checked: includes?.checked, disabled: dialog?.querySelectorAll('input:disabled').length ?? 0,
      count: useAppStore.getState().providers.length, focus: document.activeElement?.textContent,
      viewportFits: !dialog || (dialog.getBoundingClientRect().left >= 0 && dialog.getBoundingClientRect().right <= innerWidth),
      defaultProvider: useAppStore.getState().settings?.defaultProviderId };
  },
  async escape() { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await frame(); },
  async tabBack() { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })); await frame(); return Boolean(document.activeElement?.closest('[role="dialog"]')); },
};
window.dispatchEvent(new Event("transfer-probe-ready"));
