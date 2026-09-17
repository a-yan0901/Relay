import { createInputSequencer, type InputAcceptance, type LiveInputRequest } from './protocol.js';
import {
  LIVE_MAX_FRAME_BYTES,
  LIVE_MAX_PAYLOAD_BYTES,
  LIVE_MAX_SCREEN_BYTES,
  parseLiveFrame,
  type LiveFrame,
  type LiveTerminalDescriptor
} from './live-protocol.js';

interface OutputBuffer {
  frames: LiveFrame[];
  bytes: number;
}

export interface LiveWorkspaceStateOptions {
  workspaceId: string;
  ownerEpoch?: number;
  maxOutputBytes?: number;
  maxOutputFrames?: number;
  maxInputDedupeEntries?: number;
}

const frameBytes = (frame: LiveFrame): number => new globalThis.TextEncoder().encode(JSON.stringify(frame)).byteLength;

const assertBoundedString = (value: string, maxBytes: number, message: string, allowEmpty = false): void => {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || new globalThis.TextEncoder().encode(value).byteLength > maxBytes) throw new Error(message);
};

const assertEpoch = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid live owner epoch');
};

export class LiveWorkspaceState {
  private readonly workspaceId: string;
  private readonly maxOutputBytes: number;
  private readonly maxOutputFrames: number;
  private readonly inputSequencer: ReturnType<typeof createInputSequencer>;
  private readonly terminals = new Map<string, LiveTerminalDescriptor>();
  private readonly outputs = new Map<string, OutputBuffer>();
  private epoch: number;

  constructor(options: LiveWorkspaceStateOptions) {
    assertBoundedString(options.workspaceId, 128, 'invalid live workspace id');
    this.workspaceId = options.workspaceId;
    this.epoch = options.ownerEpoch ?? 1;
    assertEpoch(this.epoch);
    this.maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
    this.maxOutputFrames = options.maxOutputFrames ?? 512;
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < LIVE_MAX_FRAME_BYTES || this.maxOutputBytes > 4 * 1024 * 1024) throw new Error('invalid live output buffer');
    if (!Number.isSafeInteger(this.maxOutputFrames) || this.maxOutputFrames < 1 || this.maxOutputFrames > 4_096) throw new Error('invalid live output frame limit');
    this.inputSequencer = createInputSequencer(options.maxInputDedupeEntries);
  }

  get ownerEpoch(): number { return this.epoch; }

  setOwnerEpoch(epoch: number): void {
    assertEpoch(epoch);
    if (epoch === this.epoch) return;
    this.epoch = epoch;
    this.outputs.clear();
  }

  setTerminal(descriptor: LiveTerminalDescriptor): void {
    if (this.terminals.size >= 32 && !this.terminals.has(descriptor.sessionId)) throw new Error('live terminal limit reached');
    if (descriptor.screen !== undefined) assertBoundedString(descriptor.screen, LIVE_MAX_SCREEN_BYTES, 'live screen too large', true);
    const validated = parseLiveFrame({
      protocolVersion: 1,
      type: 'workspace-snapshot',
      workspaceId: this.workspaceId,
      ownerEpoch: this.epoch,
      sequence: 0,
      terminals: [descriptor]
    });
    const terminal = validated.type === 'workspace-snapshot' ? validated.terminals[0] : undefined;
    if (!terminal) throw new Error('invalid live terminal');
    this.terminals.set(descriptor.sessionId, { ...terminal, ...(terminal.screen === undefined ? {} : { screen: terminal.screen }) });
  }

  removeTerminal(sessionId: string): void { this.terminals.delete(sessionId); this.outputs.delete(sessionId); }

  snapshot(): LiveFrame {
    return parseLiveFrame({
      protocolVersion: 1,
      type: 'workspace-snapshot',
      workspaceId: this.workspaceId,
      ownerEpoch: this.epoch,
      sequence: this.latestSequence(),
      terminals: [...this.terminals.values()]
    });
  }

  recordOutput(sessionId: string, payload: string): LiveFrame {
    assertBoundedString(payload, LIVE_MAX_PAYLOAD_BYTES, 'live output too large');
    const current = this.outputs.get(sessionId) ?? { frames: [], bytes: 0 };
    const lastFrame = current.frames.at(-1);
    const nextSequence = lastFrame?.type === 'terminal-output' ? lastFrame.sequence + 1 : 1;
    const frame = parseLiveFrame({
      protocolVersion: 1,
      type: 'terminal-output',
      workspaceId: this.workspaceId,
      sessionId,
      ownerEpoch: this.epoch,
      sequence: nextSequence,
      payload
    });
    const size = frameBytes(frame);
    current.frames.push(frame);
    current.bytes += size;
    while (current.frames.length > this.maxOutputFrames || current.bytes > this.maxOutputBytes) {
      const removed = current.frames.shift();
      if (!removed) break;
      current.bytes -= frameBytes(removed);
    }
    this.outputs.set(sessionId, current);
    return frame;
  }

  replay(sessionId: string, afterSequence: number): readonly LiveFrame[] | null {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('invalid live sequence');
    const frames = this.outputs.get(sessionId)?.frames ?? [];
    const first = frames[0];
    if (first?.type === 'terminal-output' && afterSequence + 1 < first.sequence) return null;
    return frames.filter((frame) => frame.type === 'terminal-output' && frame.sequence > afterSequence);
  }

  acceptInput(input: LiveInputRequest): InputAcceptance {
    const frame = parseLiveFrame({
      protocolVersion: 1,
      type: 'terminal-input',
      workspaceId: this.workspaceId,
      sessionId: input.sessionId,
      participantDeviceId: input.participantDeviceId,
      inputId: input.inputId,
      payload: input.payload
    });
    if (frame.type !== 'terminal-input') throw new Error('invalid live input');
    return this.inputSequencer.accept(input);
  }

  inputAck(input: LiveInputRequest, acceptance: InputAcceptance): LiveFrame {
    return parseLiveFrame({
      protocolVersion: 1,
      type: 'input-ack',
      workspaceId: this.workspaceId,
      sessionId: input.sessionId,
      inputId: input.inputId,
      inputSequence: acceptance.status === 'rejected' ? 0 : acceptance.inputSequence,
      outcome: acceptance.status === 'rejected' ? 'unknown' : acceptance.status
    });
  }

  private latestSequence(): number {
    let latest = 0;
    for (const buffer of this.outputs.values()) {
      const frame = buffer.frames.at(-1);
      if (frame?.type === 'terminal-output') latest = Math.max(latest, frame.sequence);
    }
    return latest;
  }
}
