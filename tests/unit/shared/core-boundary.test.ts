import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const coreRoot = join(process.cwd(), 'src', 'shared', 'core');
const forbiddenDependencyPatterns = [
  /from\s+['"]node:/u,
  /from\s+['"]react(?:\/|['"])/u,
  /from\s+['"]react-dom(?:\/|['"])/u,
  /\bWebSocket\b/u,
  /from\s+['"]ssh2(?:\/|['"])/u,
  /\b(?:localStorage|sessionStorage)\b/u,
  /\b(?:window|document)\s*[.(]/u,
  /\b(?:File|Blob|FormData)\s*[.[(<({]/u,
  /\bfetch\s*\(/u
];

const listTypeScriptFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return listTypeScriptFiles(path);
  return statSync(path).isFile() && /\.tsx?$/u.test(entry.name) ? [path] : [];
});

describe('shared core platform boundary', () => {
  it('does not depend on a platform runtime or browser storage', () => {
    const violations: string[] = [];
    for (const filename of listTypeScriptFiles(coreRoot)) {
      const source = readFileSync(filename, 'utf8');
      for (const pattern of forbiddenDependencyPatterns) {
        if (pattern.test(source)) violations.push(`${filename}: ${pattern}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
