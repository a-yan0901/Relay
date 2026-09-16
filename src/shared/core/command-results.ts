import type { CommandRunSummary, CommandTargetResult, CommandTargetStatus } from './models.js';

export interface CommandTargetFilter {
  query?: string;
  statuses?: readonly CommandTargetStatus[];
  errorCode?: string;
  hostLabels?: ReadonlyMap<string, string>;
}

export interface CommandOutputDiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

export interface CommandOutputDiff {
  referenceHostId: string;
  targetHostId: string;
  changed: boolean;
  lines: readonly CommandOutputDiffLine[];
  truncated?: boolean;
}

const emptySummary = (): CommandRunSummary => ({
  total: 0,
  queued: 0,
  running: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  interrupted: 0,
  anomalyCount: 0,
  truncatedCount: 0
});

export const summarizeCommandTargets = (targets: readonly CommandTargetResult[]): CommandRunSummary => {
  const summary = emptySummary();
  for (const target of targets) {
    summary.total += 1;
    summary[target.status] += 1;
    if (target.status === 'failed' || target.status === 'cancelled' || target.status === 'interrupted') summary.anomalyCount += 1;
    if (target.truncated === true) summary.truncatedCount += 1;
  }
  return summary;
};

export const filterCommandTargets = (
  targets: readonly CommandTargetResult[],
  filter: CommandTargetFilter = {}
): readonly CommandTargetResult[] => {
  const query = filter.query?.trim().toLocaleLowerCase() ?? '';
  const statuses = filter.statuses === undefined || filter.statuses.length === 0 ? null : new Set(filter.statuses);
  return targets.filter((target) => {
    const searchable = [
      target.hostId,
      filter.hostLabels?.get(target.hostId) ?? '',
      target.status,
      target.errorCode ?? ''
    ].join(' ').toLocaleLowerCase();
    return (!query || searchable.includes(query)) &&
      (statuses === null || statuses.has(target.status)) &&
      (!filter.errorCode || target.errorCode === filter.errorCode);
  });
};

const outputLines = (output: string): string[] => output.length === 0 ? [] : output.split(/\r?\n/u);

export const diffCommandOutputs = (
  targets: readonly Readonly<Pick<CommandTargetResult, 'hostId' | 'output'>>[],
  maxLines = 400
): readonly CommandOutputDiff[] => {
  if (targets.length < 2) return [];
  const [reference, ...comparisons] = targets;
  const referenceLines = outputLines(reference.output);
  return comparisons.map((target) => {
    const targetLines = outputLines(target.output);
    const lines: CommandOutputDiffLine[] = [];
    const lineCount = Math.max(referenceLines.length, targetLines.length);
    let truncated = false;
    for (let index = 0; index < lineCount; index += 1) {
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
      const referenceLine = referenceLines[index];
      const targetLine = targetLines[index];
      if (referenceLine === targetLine && referenceLine !== undefined) {
        lines.push({ kind: 'same', text: referenceLine });
      } else {
        if (referenceLine !== undefined) lines.push({ kind: 'removed', text: referenceLine });
        if (targetLine !== undefined && lines.length < maxLines) lines.push({ kind: 'added', text: targetLine });
        if (lines.length >= maxLines && index < lineCount - 1) truncated = true;
      }
    }
    return {
      referenceHostId: reference.hostId,
      targetHostId: target.hostId,
      changed: reference.output !== target.output,
      lines,
      ...(truncated ? { truncated: true } : {})
    };
  });
};
