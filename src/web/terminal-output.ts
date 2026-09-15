const UTF8_C1_LEAD_BYTE = 0xc2;
const C1_CONTROL_START = 0x80;
const C1_CONTROL_END = 0x9f;

const isC1ContinuationByte = (value: number): boolean => value >= C1_CONTROL_START && value <= C1_CONTROL_END;

/**
 * Keeps binary data from changing the terminal's control state when it is
 * printed through a UTF-8 terminal. Modern shells use the 7-bit ESC form for
 * ANSI sequences; UTF-8 encoded C1 controls are therefore treated as data.
 */
export class TerminalOutputSanitizer {
  private pendingUtf8LeadByte = false;

  sanitize(data: Uint8Array): Uint8Array {
    if (data.length === 0) return data;
    if (!this.pendingUtf8LeadByte && !data.includes(UTF8_C1_LEAD_BYTE)) return data;

    const sanitized = new Uint8Array(data.length + (this.pendingUtf8LeadByte ? 1 : 0));
    let sourceIndex = 0;
    let targetIndex = 0;

    if (this.pendingUtf8LeadByte) {
      this.pendingUtf8LeadByte = false;
      if (data.length > 0 && isC1ContinuationByte(data[0])) {
        sourceIndex = 1;
      } else {
        sanitized[targetIndex++] = UTF8_C1_LEAD_BYTE;
      }
    }

    while (sourceIndex < data.length) {
      const value = data[sourceIndex];
      if (value !== UTF8_C1_LEAD_BYTE) {
        sanitized[targetIndex++] = value;
        sourceIndex += 1;
        continue;
      }

      if (sourceIndex + 1 >= data.length) {
        this.pendingUtf8LeadByte = true;
        sourceIndex += 1;
      } else if (isC1ContinuationByte(data[sourceIndex + 1])) {
        sourceIndex += 2;
      } else {
        sanitized[targetIndex++] = value;
        sourceIndex += 1;
      }
    }

    return sanitized.subarray(0, targetIndex);
  }

  reset(): void {
    this.pendingUtf8LeadByte = false;
  }
}
