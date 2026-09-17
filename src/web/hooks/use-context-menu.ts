import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';

import type { ContextMenuController, ContextMenuState } from '../context-menu';

export const useContextMenu = <T>(): ContextMenuController<T> => {
  const [state, setState] = useState<ContextMenuState<T> | null>(null);

  const open = useCallback((event: ReactMouseEvent, target: T): void => {
    event.preventDefault();
    event.stopPropagation();
    setState({ target, position: { x: event.clientX, y: event.clientY } });
  }, []);

  const close = useCallback((): void => setState(null), []);

  useEffect(() => {
    if (!state) return;
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (typeof Element !== 'undefined' && target instanceof Element && target.closest('[data-context-menu]')) return;
      close();
    };
    const handleScroll = (): void => close();
    const handleBlur = (): void => close();
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, [close, state]);

  return { state, open, close };
};
