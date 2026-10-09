import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { TFunction } from "i18next";
import type { Mode } from "@pi-desktop/shared";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { IconCheck } from "../../../components/icons";
import { useHoverMenu } from "../../../hooks/use-hover-menu";
import { ModeIcon } from "./ComposerModeIcon";
import { MODE_CYCLE, MODE_LABEL_KEYS, nextMode } from "./model";

const MODE_DESCRIPTION_KEYS: Record<Mode, string> = {
  agent: "chat.modeAgentDesc",
  plan: "chat.modePlanDesc",
  goal: "chat.modeGoalDesc",
};

/**
 * The Agent / Plan / Goal control.
 *
 * The chip is still the control it always was: a click cycles to the next
 * mode. Resting the pointer on it also lays all three out above it, each with
 * a line saying what it does, so a mode two steps away is one click instead of
 * two and nobody has to cycle to find out what Goal means. The menu takes no
 * focus on hover — the caret stays in the editor — and the keyboard reaches it
 * with the arrow keys from the chip.
 */
export function ComposerModeSwitch({
  t,
  mode,
  planningLive,
  controlsBlocked,
  onBeforeChange,
  onSelect,
}: {
  t: TFunction;
  mode: Mode;
  planningLive: boolean;
  controlsBlocked: boolean;
  /** Close the other composer menus before the mode changes or this one opens. */
  onBeforeChange: () => void;
  onSelect: (mode: Mode) => void | Promise<void>;
}) {
  const hover = useHoverMenu({ disabled: controlsBlocked });
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const label = planningLive ? t(`${mode}.planning`) : t("settings.mode");

  const focusOption = (target: Mode) => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>(`[data-mode-option="${target}"]`)
      ?.focus();
  };

  const onChipKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    onBeforeChange();
    hover.openNow();
    // The menu is measured for one frame before it can take focus.
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => focusOption(mode)),
    );
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const focused = (document.activeElement as HTMLElement | null)?.dataset.modeOption as
      | Mode
      | undefined;
    const index = MODE_CYCLE.indexOf(focused ?? mode);
    const step = event.key === "ArrowDown" ? 1 : -1;
    focusOption(MODE_CYCLE[(index + step + MODE_CYCLE.length) % MODE_CYCLE.length]);
  };

  return (
    <div className="composer-mode" {...hover.anchorProps}>
      <AnchoredMenu
        open={hover.open}
        onClose={() => {
          // Only a keyboard user has focus in the menu to hand back.
          const fromMenu = menuRef.current?.contains(document.activeElement) ?? false;
          hover.close();
          if (fromMenu) chipRef.current?.focus();
        }}
        menuClassName="composer-mode-menu"
        label={t("settings.mode")}
        role="menu"
        align="start"
        side="top"
        initialFocus="none"
        restoreFocus={false}
        onMenuKeyDown={onMenuKeyDown}
        trigger={(ref) => (
          <button
            ref={(node) => {
              ref.current = node;
              chipRef.current = node;
            }}
            type="button"
            className="icon-btn mode-chip composer-mode-chip"
            data-mode={mode}
            data-planning={planningLive ? "true" : undefined}
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={hover.open}
            disabled={controlsBlocked}
            onKeyDown={onChipKeyDown}
            onClick={() => {
              onBeforeChange();
              void onSelect(nextMode(mode));
            }}
          >
            <span className="composer-mode-chip-face" key={mode}>
              <ModeIcon mode={mode} />
              <span className="composer-mode-chip-label text-sm">
                {t(MODE_LABEL_KEYS[mode])}
              </span>
            </span>
          </button>
        )}
      >
        <div className="composer-mode-options" ref={menuRef} {...hover.menuProps}>
          {MODE_CYCLE.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="menuitemradio"
              aria-checked={candidate === mode}
              data-mode-option={candidate}
              className={`composer-mode-option${candidate === mode ? " active" : ""}`}
              onClick={() => {
                onBeforeChange();
                hover.close();
                if (candidate !== mode) void onSelect(candidate);
              }}
            >
              <span className="composer-mode-option-icon" aria-hidden="true">
                <ModeIcon mode={candidate} />
              </span>
              <span className="composer-mode-option-copy">
                <span className="composer-mode-option-name">
                  {t(MODE_LABEL_KEYS[candidate])}
                </span>
                <span className="composer-mode-option-desc">
                  {t(MODE_DESCRIPTION_KEYS[candidate])}
                </span>
              </span>
              {candidate === mode ? (
                <IconCheck className="composer-mode-option-check" size={13} aria-hidden="true" />
              ) : null}
            </button>
          ))}
        </div>
      </AnchoredMenu>
    </div>
  );
}
