// Browsers may suspend audio until the first interaction in this tab.
export function createNotificationSound() {
  let context: AudioContext | undefined;
  let enabled = false;

  function prepare() {
    if (!enabled || typeof AudioContext === 'undefined') return;
    try {
      context ??= new AudioContext();
      if (context.state === 'suspended') void context.resume().catch(() => {});
    } catch { /* Audio output is best effort. */ }
  }
  function setEnabled(next: boolean) {
    if (enabled === next) return;
    enabled = next;
    if (enabled) {
      window.addEventListener('click', prepare, true);
      window.addEventListener('keydown', prepare, true);
      if (navigator.userActivation?.hasBeenActive) prepare();
    } else {
      window.removeEventListener('click', prepare, true);
      window.removeEventListener('keydown', prepare, true);
      if (context) void context.close().catch(() => {});
      context = undefined;
    }
  }
  function play() {
    if (context?.state !== 'running') return;
    const now = context.currentTime;
    const tone = context.createOscillator();
    const volume = context.createGain();
    tone.frequency.value = 740;
    volume.gain.setValueAtTime(0.001, now);
    volume.gain.exponentialRampToValueAtTime(0.12, now + 0.012);
    volume.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    tone.connect(volume);
    volume.connect(context.destination);
    tone.start(now);
    tone.stop(now + 0.23);
  }
  return { setEnabled, play, get ready() { return context?.state === 'running'; } };
}
