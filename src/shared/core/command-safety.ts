export interface CommandRiskAssessment {
  command: string;
  requiresConfirmation: boolean;
  reasons: readonly string[];
}

const RISK_PATTERNS: readonly [RegExp, string][] = [
  [/\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/iu, '递归强制删除'],
  [/\b(?:shutdown|reboot|poweroff)\b/iu, '主机电源操作'],
  [/\bmkfs(?:\.[a-z0-9_-]+)?\b/iu, '磁盘格式化'],
  [/\bdd\s+[^\n]*\bof=\/dev\//iu, '直接写入块设备'],
  [/\b(?:drop\s+database|drop\s+table|truncate\s+table)\b/iu, '数据库破坏性操作'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/u, '资源耗尽命令']
];

const commandVariablePattern = /\{\{([^{}]+)\}\}/gu;
const sensitiveVariablePattern = /(?:pass(?:word|phrase)?|secret|token|private|credential|api[_-]?key)/iu;

export const assessCommandRisk = (command: string): CommandRiskAssessment => {
  const reasons = RISK_PATTERNS.filter(([pattern]) => pattern.test(command)).map(([, reason]) => reason);
  return { command, requiresConfirmation: reasons.length > 0, reasons };
};

/** Keeps ordinary preview values useful while preventing common secret variables from being echoed. */
export const redactCommandPreview = (
  command: string,
  variables: Readonly<Record<string, string>>
): string => command.replace(commandVariablePattern, (match, name: string) => (
  sensitiveVariablePattern.test(name) ? '••••' : variables[name] ?? match
));
