import { createContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { installOverlayExit } from "./overlay-exit";

export const PortalVisibilityContext = createContext(true);

export function PortalVisibilityProvider({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  return (
    <PortalVisibilityContext.Provider value={visible}>
      {children}
    </PortalVisibilityContext.Provider>
  );
}

export function visiblePortalContent(node: ReactNode) {
  return (
    <PortalVisibilityContext.Consumer>
      {(visible) => (visible ? node : null)}
    </PortalVisibilityContext.Consumer>
  );
}

export function portalToBody(node: ReactNode) {
  if (typeof document === "undefined") return node;
  // Dialogs portaled here leave with an exit too (once per document).
  installOverlayExit(document.body);
  return createPortal(visiblePortalContent(node), document.body);
}
