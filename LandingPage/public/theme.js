// Sets the theme before the first paint, so a light visit never flashes dark. Loaded blocking in <head> by
// src/app/layout.tsx. The saved choice (components/site/theme-toggle.tsx) wins; otherwise the device setting.
(() => {
  let theme = null;
  try {
    theme = window.localStorage.getItem("wrenai-theme");
  } catch {
    // Storage is blocked (some private modes): fall back to the device setting.
    theme = null;
  }
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.dataset.theme = theme;
})();
