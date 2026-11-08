/**
 * Anchored popover: closes on outside pointer-down and Escape. The parent
 * supplies the anchor; the panel renders in a fixed layer positioned by
 * `anchor` + `placement`.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';

export function Popover({
  open,
  onClose,
  anchor,
  children,
  width = 320,
  placement = 'above',
}: {
  open: boolean;
  onClose(): void;
  anchor: HTMLElement | null;
  children: ReactNode;
  width?: number;
  placement?: 'above' | 'below';
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number }>({ left: 0, top: 0 });

  useEffect(() => {
    if (!open || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(
      Math.max(margin, rect.left),
      window.innerWidth - width - margin,
    );
    if (placement === 'above') {
      setPos({ left, bottom: window.innerHeight - rect.top + margin });
    } else {
      setPos({ left, top: rect.bottom + margin });
    }
  }, [open, anchor, width, placement]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [anchor, onClose, open]);

  if (!open) return null;
  return (
    <div
      ref={panelRef}
      role="dialog"
      className={clsx(
        'fixed z-50 overflow-hidden rounded-card border border-border bg-surface2 shadow-2xl',
      )}
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width }}
    >
      {children}
    </div>
  );
}
