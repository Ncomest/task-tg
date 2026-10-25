interface TelegramWebApp {
  initData: string;
  colorScheme: 'light' | 'dark';
  ready: () => void;
  expand: () => void;
  onEvent: (event: 'themeChanged', callback: () => void) => void;
  offEvent: (event: 'themeChanged', callback: () => void) => void;
}

declare global {
  interface Window { Telegram?: { WebApp: TelegramWebApp } }
}

export function connectTelegram() {
  const app = window.Telegram?.WebApp;
  if (!app?.initData) return { initData: '', disconnect: () => {} };
  const applyTheme = () => { document.documentElement.style.colorScheme = app.colorScheme; };
  applyTheme();
  app.onEvent('themeChanged', applyTheme);
  app.expand();
  app.ready();
  return { initData: app.initData, disconnect: () => app.offEvent('themeChanged', applyTheme) };
}

export function launchInviteCode() {
  const raw = window.Telegram?.WebApp.initData ?? '';
  const start = new URLSearchParams(raw).get('start_param') ?? '';
  return /^join_[\w-]{43}$/.test(start) ? start.slice(5) : '';
}
