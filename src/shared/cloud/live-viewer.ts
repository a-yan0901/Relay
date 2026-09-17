import { parseLiveFrame, type LiveFrame, type LiveTerminalDescriptor } from './live-protocol.js';
import { trackLiveSequence, type LiveSequenceTracker } from './protocol.js';

type OutputFrame = Extract<LiveFrame, { type: 'terminal-output' }>;
type PendingInput = Extract<LiveFrame, { type: 'terminal-input' }>;
type InputStatus = 'pending' | 'accepted' | 'duplicate' | 'unknown';

interface OutputBuffer {
  tracker: LiveSequenceTracker;
  frames: OutputFrame[];
  bytes: number;
}

export interface LiveWorkspaceViewerOptions {
  workspaceId: string;
  participantDeviceId: string;
  maxOutputBytes?: number;
  maxOutputFrames?: number;
  maxPendingInputs?: number;
}

const frameBytes = (frame: OutputFrame): number => new globalThis.TextEncoder().encode(JSON.stringify(frame)).byteLength;
const inputId = (): string => `input-${typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;

export class LiveWorkspaceViewer {
  private readonly workspaceId: string;
  private readonly participantDeviceId: string;
  private readonly maxOutputBytes: number;
  private readonly maxOutputFrames: number;
  private readonly maxPendingInputs: number;
  private readonly terminals = new Map<string, LiveTerminalDescriptor>();
  private readonly outputs = new Map<string, OutputBuffer>();
  private readonly pending = new Map<string, { frame: PendingInput; status: InputStatus }>();
  private ownerEpoch: number | null = null;

  constructor(options: LiveWorkspaceViewerOptions) {
    this.workspaceId = options.workspaceId;
    this.participantDeviceId = options.participantDeviceId;
    this.maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
    this.maxOutputFrames = options.maxOutputFrames ?? 512;
    this.maxPendingInputs = options.maxPendingInputs ?? 4_096;
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1 || this.maxOutputBytes > 4 * 1024 * 1024) throw new Error('invalid live viewer output buffer');
    if (!Number.isSafeInteger(this.maxOutputFrames) || this.maxOutputFrames < 1 || this.maxOutputFrames > 4_096) throw new Error('invalid live viewer output frame limit');
    if (!Number.isSafeInteger(this.maxPendingInputs) || this.maxPendingInputs < 64 || this.maxPendingInputs > 65_536) throw new Error('invalid live viewer input window');
  }

  get epoch(): number | null { return this.ownerEpoch; }

  apply(value: unknown): { status: 'applied' | 'duplicate' | 'resync-required' | 'epoch-changed'; sessionId?: string; afterSequence?: number } {
    const frame = parseLiveFrame(value);
    if (frame.workspaceId !== this.workspaceId) return { status: 'duplicate' };
    if (frame.type === 'workspace-snapshot') return this.applySnapshot(frame);
    if (frame.type === 'terminal-output') return this.applyOutput(frame);
    if (frame.type === 'input-ack') {
      const pending = this.pending.get(frame.inputId);
      if (pending) pending.status = frame.outcome;
      return { status: pending ? 'applied' : 'duplicate' };
    }
    return { status: 'duplicate' };
  }

  createInput(sessionId: string, payload: string): PendingInput {
    const frame = parseLiveFrame({
      protocolVersion: 1,
      type: 'terminal-input',
      workspaceId: this.workspaceId,
      sessionId,
      participantDeviceId: this.participantDeviceId,
      inputId: inputId(),
      payload
    });
    if (frame.type !== 'terminal-input') throw new Error('invalid live input');
    if (this.pending.size >= this.maxPendingInputs) {
      const oldest = this.pending.keys().next().value;
      if (typeof oldest === 'string') this.pending.delete(oldest);
    }
    this.pending.set(frame.inputId, { frame, status: 'pending' });
    return frame;
  }

  pendingInput(inputIdValue: string): { frame: PendingInput; status: InputStatus } | null {
    const value = this.pending.get(inputIdValue);
    return value ? { frame: value.frame, status: value.status } : null;
  }

  terminalsSnapshot(): readonly LiveTerminalDescriptor[] { return [...this.terminals.values()]; }
  output(sessionId: string): readonly OutputFrame[] { return [...(this.outputs.get(sessionId)?.frames ?? [])]; }

  private applySnapshot(frame: Extract<LiveFrame, { type: 'workspace-snapshot' }>): { status: 'applied' | 'epoch-changed' } {
    const epochChanged = this.ownerEpoch !== null && this.ownerEpoch !== frame.ownerEpoch;
    this.ownerEpoch = frame.ownerEpoch;
    this.terminals.clear();
    this.outputs.clear();
    for (const terminal of frame.terminals) {
      this.terminals.set(terminal.sessionId, terminal);
      const tracker = trackLiveSequence();
      tracker.apply({ kind: 'snapshot', ownerEpoch: frame.ownerEpoch, sequence: 0 });
      this.outputs.set(terminal.sessionId, { tracker, frames: [], bytes: 0 });
    }
    if (epochChanged) {
      for (const pending of this.pending.values()) pending.status = 'unknown';
      return { status: 'epoch-changed' };
    }
    return { status: 'applied' };
  }

  private applyOutput(frame: OutputFrame): { status: 'applied' | 'duplicate' | 'resync-required' | 'epoch-changed'; sessionId: string; afterSequence?: number } {
    if (this.ownerEpoch !== frame.ownerEpoch) return { status: 'epoch-changed', sessionId: frame.sessionId };
    const buffer = this.outputs.get(frame.sessionId);
    if (!buffer) return { status: 'resync-required', sessionId: frame.sessionId, afterSequence: 0 };
    const result = buffer.tracker.apply({ kind: 'output', ownerEpoch: frame.ownerEpoch, sequence: frame.sequence });
    if (result.status === 'resync-required') return { status: 'resync-required', sessionId: frame.sessionId, afterSequence: result.nextSequence - 1 };
    if (result.status === 'epoch-changed') return { status: 'epoch-changed', sessionId: frame.sessionId };
    if (result.status === 'duplicate') return { status: 'duplicate', sessionId: frame.sessionId };
    buffer.frames.push(frame);
    buffer.bytes += frameBytes(frame);
    while (buffer.frames.length > this.maxOutputFrames || buffer.bytes > this.maxOutputBytes) {
      const removed = buffer.frames.shift();
      if (!removed) break;
      buffer.bytes -= frameBytes(removed);
    }
    return { status: 'applied', sessionId: frame.sessionId };
  }
}
