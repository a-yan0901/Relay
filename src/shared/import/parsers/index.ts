import { AppError } from '../../errors.js';
import { detectImportFormats } from '../detect.js';
import type { ImportDocument, ImportFormat, ImportSourceFile } from '../types.js';
import { parseSshCsv } from './csv.js';
import { parseMobaXterm } from './mobaxterm.js';
import { parseOpenSshConfig } from './openssh.js';
import { parseSecureCrtIni, parseSecureCrtXml } from './securecrt.js';
import { parseXshell } from './xshell.js';

const asText = (content: string | Uint8Array): string => typeof content === 'string'
  ? content
  : new globalThis.TextDecoder('utf-8', { fatal: false }).decode(content);

export const parseImportSource = (source: ImportSourceFile, formatHint?: ImportFormat): ImportDocument => {
  const format = formatHint ?? source.formatHint ?? detectImportFormats(source.content, source.filename)[0]?.format;
  if (!format) throw new AppError('IMPORT_FORMAT_UNSUPPORTED');
  switch (format) {
    case 'openssh-config': return parseOpenSshConfig(asText(source.content), source.filename);
    case 'ssh-csv': return parseSshCsv(asText(source.content), source.filename);
    case 'mobaxterm': return parseMobaXterm(source.content, source.filename);
    case 'xshell': return parseXshell(source.content, source.filename);
    case 'securecrt':
      return source.filename.toLowerCase().endsWith('.xml')
        ? parseSecureCrtXml(asText(source.content), source.filename)
        : parseSecureCrtIni(asText(source.content), source.filename);
  }
};

export { parseOpenSshConfig } from './openssh.js';
export { parseSshCsv } from './csv.js';
export { parseMobaXterm } from './mobaxterm.js';
export { parseXshell } from './xshell.js';
export { parseSecureCrtIni, parseSecureCrtXml } from './securecrt.js';
