import { useRef } from 'react';

import type { TerminalHostKeyEvent } from '@shared/protocol';

import { useDialogFocus } from '../hooks/use-dialog-focus';

export interface HostKeyDialogProps {
  challenge: TerminalHostKeyEvent;
  onDecision: (decision: 'trust' | 'reject') => void;
}

export const HostKeyDialog = ({ challenge, onDecision }: HostKeyDialogProps) => {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, true, () => onDecision('reject'), '#host-key-reject');

  return (
  <div className="modal-backdrop" role="presentation">
    <section ref={dialogRef} className="host-key-dialog" role="dialog" aria-modal="true" aria-labelledby="host-key-title" aria-describedby="host-key-description">
      <div className="danger-icon" aria-hidden="true">!</div>
      <p className="eyebrow">FIRST CONNECTION</p>
      <h2 id="host-key-title">确认 Server 指纹</h2>
      <p id="host-key-description" className="dialog-copy">这是该 Server 第一次连接。请确认你信任这个 SSH host key，再继续建立终端。</p>
      <dl className="fingerprint-details">
        <div><dt>地址</dt><dd>{challenge.address}:{challenge.port}</dd></div>
        <div><dt>算法</dt><dd>{challenge.algorithm}</dd></div>
        <div><dt>SHA-256 指纹</dt><dd className="fingerprint-value">{challenge.fingerprint}</dd></div>
      </dl>
      <p className="dialog-warning">只信任你能通过其他安全渠道核对过的指纹。拒绝后不会保存信任关系。</p>
      <div className="dialog-actions">
        <button id="host-key-reject" className="button button-ghost" type="button" onClick={() => onDecision('reject')}><span aria-hidden="true">⚠</span><span>拒绝连接</span></button>
        <button className="button button-primary" type="button" onClick={() => onDecision('trust')}><span aria-hidden="true">✓</span><span>信任并连接</span></button>
      </div>
    </section>
  </div>
  );
};
