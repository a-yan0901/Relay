import { useEffect, useRef, type RefObject } from 'react';

const getFocusableElements = (dialog: HTMLElement): HTMLElement[] => Array.from(dialog.querySelectorAll<HTMLElement>(
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
));

export const useDialogFocus = (
  dialogRef: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  initialFocusSelector?: string
): void => {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const returnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = (): HTMLElement[] => getFocusableElements(dialog);
    const initialTarget = initialFocusSelector ? dialog.querySelector<HTMLElement>(initialFocusSelector) : null;
    (initialTarget ?? focusable()[0])?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (elements.length === 0) return;
      const current = document.activeElement;
      const index = elements.indexOf(current as HTMLElement);
      if (event.shiftKey && (index <= 0 || index === -1)) {
        event.preventDefault();
        elements.at(-1)?.focus();
      } else if (!event.shiftKey && index === elements.length - 1) {
        event.preventDefault();
        elements[0]?.focus();
      }
    };

    dialog.addEventListener('keydown', handleKeyDown);
    return () => {
      dialog.removeEventListener('keydown', handleKeyDown);
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [dialogRef, initialFocusSelector, open]);
};
