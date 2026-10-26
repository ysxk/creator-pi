type NavigationAction = () => void;
let guard: ((action: NavigationAction) => void) | undefined;

export function registerSettingsNavigationGuard(next: (action: NavigationAction) => void) {
  guard = next;
  return () => { if (guard === next) guard = undefined; };
}

export function requestSettingsNavigation(action: NavigationAction) {
  if (guard) guard(action);
  else action();
}
