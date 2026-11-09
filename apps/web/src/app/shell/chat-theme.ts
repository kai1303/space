export function readChatTheme() {
  try { return window.localStorage.getItem('space-theme') === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}
