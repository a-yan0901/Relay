import type { SnippetMetadata } from '../../shared/core/models';

export interface SnippetPickerProps {
  snippets: readonly SnippetMetadata[];
  onSelect: (id: string) => void;
}

export const SnippetPicker = ({ snippets, onSelect }: SnippetPickerProps) => (
  <label className="command-snippet-picker">
    <span>命令片段</span>
    <select aria-label="命令片段" defaultValue="" onChange={(event) => { if (event.target.value) onSelect(event.target.value); }}>
      <option value="">选择已保存片段</option>
      {snippets.map((snippet) => <option value={snippet.id} key={snippet.id}>{snippet.name}</option>)}
    </select>
  </label>
);
