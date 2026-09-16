import { useId, useRef, type ReactNode } from 'react';

import { useDialogFocus } from '../hooks/use-dialog-focus';

export interface DialogProps {
  title: string;
  ariaLabel?: string;
  onClose: () => void;
  initialFocusSelector?: string;
  closeOnBackdrop?: boolean;
  className?: string;
  children: ReactNode;
}

export const Dialog = ({
  title,
  ariaLabel,
  onClose,
  initialFocusSelector,
  closeOnBackdrop = true,
  className = 'dialog-surface',
  children
}: DialogProps) => {
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  useDialogFocus(dialogRef, true, onClose, initialFocusSelector);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (closeOnBackdrop && event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className={className} role="dialog" aria-modal="true" aria-labelledby={ariaLabel ? undefined : titleId} aria-label={ariaLabel} onMouseDown={(event) => event.stopPropagation()}>
        <div className="form-heading">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" type="button" aria-label={`关闭${title}`} onClick={onClose}>×</button>
        </div>
        {children}
      </section>
    </div>
  );
};
