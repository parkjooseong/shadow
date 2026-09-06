import { useLayoutEffect, useRef, type ReactNode } from 'react';

interface SidePanelProps {
  titleId: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}

export function SidePanel({ titleId, className, onClose, children }: SidePanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    // Start on the close button so opening a panel does not summon a mobile keyboard.
    dialog.querySelector<HTMLButtonElement>('.panel-header button')?.focus({ preventScroll: true });

    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={`side-panel${className ? ` ${className}` : ''}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, a[href], [tabindex]',
        )).filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      {children}
    </dialog>
  );
}
