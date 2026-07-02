// Light/dark theme: a `data-theme` attribute on <html> flips the CSS variables in styles.css.
// The choice is persisted to localStorage; first-time visitors follow their OS preference.

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'filmstrip-theme';

/** Stored preference, else the OS preference, else dark. */
export function getInitialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Apply a theme to the document and remember it. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(STORAGE_KEY, theme);
}
