export function readChatTheme(): 'light' | 'dark' {
  try { return window.localStorage.getItem('space-theme') === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}
