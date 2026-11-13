// Keep ordinary anchor behavior (including opening a new tab) for destinations outside this homepage.
const original = new URL('https://tesser.sh');
function pointToOriginal(root) {
  for (const link of root.querySelectorAll('a[href^="/"]')) {
    const target = new URL(link.getAttribute('href'), original);
    if (target.pathname !== '/') link.href = target.href;
  }
}
document.addEventListener('DOMContentLoaded', () => {
  pointToOriginal(document);
  new MutationObserver(() => pointToOriginal(document)).observe(document.body, {
    childList: true, subtree: true,
  });
});
document.addEventListener('click', event => {
  const link = event.target.closest?.('a');
  if (link && new URL(link.href).origin === original.origin) event.stopPropagation();
}, true);
