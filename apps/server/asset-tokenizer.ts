import { AbstractTokenizer, EndOfStreamError, type IReadChunkOptions } from 'strtok3/core';
import type { AssetStorage } from './storage.js';

// Classifiers can seek to a container directory near the end of the original.
// Cache adjacent reads and bound storage round trips for fragmented containers.
export class AssetTokenizer extends AbstractTokenizer {
  readonly fileInfo: {size: number};
  private window = new Uint8Array(0) as Uint8Array;
  private start = 0;
  private reads = 0;
  failure?: Error;
  original?: Uint8Array;

  constructor(private storage: AssetStorage, private key: string, size: number) {
    super({maxBufferSize: size});
    this.fileInfo = {size};
  }
  supportsRandomAccess() { return true; }
  setPosition(position: number) {
    this.validateLength(position, 'position');
    this.position = position;
  }
  async peekBuffer(target: Uint8Array, options?: IReadChunkOptions) {
    const {position, length, mayBeLess} = this.normalizeOptions(target, options);
    const size = this.fileInfo.size;
    const count = Math.max(0, Math.min(length, size - position));
    if (count < length && !mayBeLess) throw new EndOfStreamError();
    if (!count) return 0;
    if (position < this.start || position + count > this.start + this.window.length) {
      const full = ++this.reads >= 4 || count >= size / 2;
      const start = full ? 0 : position;
      const end = full ? size : Math.min(size, position + Math.max(65536, count));
      try {
        this.window = await this.storage.read(this.key, end - start, full ? undefined : {start, end: end - 1});
        if (this.window.length !== end - start) throw new Error('invalid_storage_range');
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error('storage_unavailable');
        throw this.failure;
      }
      this.start = start;
      if (full) this.original = this.window;
    }
    target.set(this.window.subarray(position - this.start, position - this.start + count));
    return count;
  }
  async readBuffer(target: Uint8Array, options?: IReadChunkOptions) {
    const position = options?.position ?? this.position;
    const count = await this.peekBuffer(target, options);
    this.position = position + count;
    return count;
  }
}
