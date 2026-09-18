/**
 * Retains bounded binary chunks and performs one UTF-8 assembly at the end.
 * Keeping bytes instead of one string per IPC frame avoids a second full
 * string during incremental Vault import and makes the memory limit explicit.
 */
export class BoundedBundleParts {
  private readonly parts: Buffer[] = [];
  private size = 0;

  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('invalid bundle size');
  }

  get byteLength(): number { return this.size; }

  append(value: Uint8Array): void {
    if (!(value instanceof Uint8Array) || value.byteLength === 0) throw new Error('invalid bundle chunk');
    if (this.size > this.maxBytes - value.byteLength) throw new Error('bundle too large');
    this.parts.push(Buffer.from(value));
    this.size += value.byteLength;
  }

  takeText(): string {
    const value = Buffer.concat(this.parts, this.size);
    this.parts.length = 0;
    this.size = 0;
    try {
      return value.toString('utf8');
    } finally {
      value.fill(0);
    }
  }

  clear(): void {
    for (const part of this.parts) part.fill(0);
    this.parts.length = 0;
    this.size = 0;
  }
}
