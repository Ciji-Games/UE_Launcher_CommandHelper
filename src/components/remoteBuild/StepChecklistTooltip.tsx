import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import type { ChecklistItem, StepPrerequisiteReport } from '../../types';

export interface StepChecklistTooltipProps {
  report: StepPrerequisiteReport;
  children: ReactNode;
  position?: 'top' | 'bottom';
  className?: string;
}

interface Coords {
  top: number;
  left: number;
  width: number;
  placement: 'top' | 'bottom';
}

export function StepChecklistTooltip({
  report,
  children,
  position = 'top',
  className = '',
}: StepChecklistTooltipProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<Coords | null>(null);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCloseTimeout = () => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  };

  const handleOpen = () => {
    clearCloseTimeout();
    setIsOpen(true);
  };

  const handleClose = () => {
    clearCloseTimeout();
    closeTimeoutRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 250);
  };

  useEffect(() => {
    return () => {
      clearCloseTimeout();
    };
  }, []);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const popoverWidth = Math.min(384, Math.max(300, viewportWidth - 32));
    const estimatedHeight = 260;

    let placement: 'top' | 'bottom' = position;
    if (position === 'top' && rect.top - estimatedHeight < 16) {
      placement = 'bottom';
    } else if (position === 'bottom' && rect.bottom + estimatedHeight > viewportHeight - 16) {
      placement = 'top';
    }

    let top = 0;
    if (placement === 'top') {
      top = rect.top - 8;
    } else {
      top = rect.bottom + 8;
    }

    const triggerCenter = rect.left + rect.width / 2;
    let left = triggerCenter - popoverWidth / 2;
    const minLeft = 16;
    const maxLeft = viewportWidth - popoverWidth - 16;
    left = Math.max(minLeft, Math.min(maxLeft, left));

    setCoords({
      top,
      left,
      width: popoverWidth,
      placement,
    });
  }, [position]);

  useEffect(() => {
    if (isOpen) {
      updatePosition();
      const handleScrollOrResize = () => updatePosition();
      window.addEventListener('scroll', handleScrollOrResize, true);
      window.addEventListener('resize', handleScrollOrResize);
      return () => {
        window.removeEventListener('scroll', handleScrollOrResize, true);
        window.removeEventListener('resize', handleScrollOrResize);
      };
    }
  }, [isOpen, updatePosition]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const statusBadge = () => {
    switch (report.status) {
      case 'ready':
        return <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">Ready</span>;
      case 'running':
        return <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30 animate-pulse">Running</span>;
      case 'waiting':
        return <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">Queued</span>;
      case 'checking':
        return <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">Checking</span>;
      case 'blocked':
        return <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">Blocked</span>;
      case 'warning':
        return <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">Warning</span>;
      case 'disabled':
        return <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">Disabled</span>;
    }
  };

  const renderItemIcon = (item: ChecklistItem) => {
    switch (item.state) {
      case 'passed':
        return (
          <svg className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        );
      case 'blocking':
        return (
          <svg className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        );
      case 'warning':
        return (
          <svg className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        );
      case 'info':
      default:
        return (
          <svg className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
        );
    }
  };

  return (
    <div
      ref={triggerRef}
      className={`relative inline-block ${className}`}
      onMouseEnter={handleOpen}
      onMouseLeave={handleClose}
      onFocus={handleOpen}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          handleClose();
        }
      }}
      tabIndex={0}
      role="region"
      aria-haspopup="dialog"
      aria-expanded={isOpen}
    >
      {children}

      {isOpen && coords && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          onMouseEnter={handleOpen}
          onMouseLeave={handleClose}
          style={{
            position: 'fixed',
            top: `${coords.top}px`,
            left: `${coords.left}px`,
            width: `${coords.width}px`,
            transform: coords.placement === 'top' ? 'translateY(-100%)' : 'none',
            zIndex: 99999,
          }}
          className={`p-3.5 bg-slate-900/95 backdrop-blur-md rounded-xl border border-slate-700/80 shadow-2xl text-left text-xs pointer-events-auto transition-all animate-in fade-in duration-150 before:content-[''] before:absolute before:left-0 before:right-0 before:h-3 ${
            coords.placement === 'top' ? 'before:top-full' : 'before:bottom-full'
          }`}
          role="dialog"
          aria-label={`${report.label} Checklist`}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-2.5">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-200 text-sm tracking-tight">{report.label}</span>
            </div>
            {statusBadge()}
          </div>

          {/* Checklist Items */}
          <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
            {report.items.map((item) => (
              <div key={item.id} className="text-xs space-y-1">
                <div className="flex items-start gap-2">
                  {renderItemIcon(item)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-300">{item.label}</span>
                    </div>
                    <p className={`text-[11px] leading-relaxed mt-0.5 ${
                      item.state === 'blocking'
                        ? 'text-rose-300 font-medium'
                        : item.state === 'warning'
                        ? 'text-amber-300'
                        : item.state === 'passed'
                        ? 'text-slate-400'
                        : 'text-slate-400'
                    }`}>
                      {item.message}
                    </p>
                    {item.remediation && (
                      <div className="mt-1 p-1.5 rounded bg-slate-950/70 border border-slate-800 text-[11px] text-slate-300 flex items-start gap-1.5">
                        <span className="text-amber-400 font-bold">Fix:</span>
                        <span>{item.remediation}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Footer hint */}
          <div className="mt-2.5 pt-2 border-t border-slate-800/80 text-[10px] text-slate-400 flex items-center justify-between">
            <span>Dynamic Prerequisite Check</span>
            <span className="font-mono text-[9px] text-slate-400">ESC to close</span>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
