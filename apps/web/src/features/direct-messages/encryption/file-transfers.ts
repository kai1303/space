// Bound simultaneous file buffers across mounted messages and composer drafts in this tab.
export function fileTransfers() {
  const slots = Array.from({ length: 3 }, () => ({ pending: 0, tail: Promise.resolve() }));
  return function run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const slot = slots.reduce((best, item) => (item.pending < best.pending ? item : best));
    if (slot.pending >= 16) return Promise.reject(new Error('Too many pending attachments. Try again.'));
    slot.pending++;
    const result = slot.tail
      .then(() => {
        signal.throwIfAborted();
        return work();
      })
      .finally(() => {
        slot.pending--;
      });
    slot.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
}
