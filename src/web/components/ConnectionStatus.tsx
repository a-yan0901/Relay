export interface ConnectionStatusProps {
  label: string;
  tone?: 'neutral' | 'success' | 'danger';
}

export const ConnectionStatus = ({ label, tone = 'neutral' }: ConnectionStatusProps) => (
  <span className={`connection-status connection-status-${tone}`}><span className="status-dot" />{label}</span>
);
