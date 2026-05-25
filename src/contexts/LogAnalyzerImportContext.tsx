/**
 * Bridges Toolbox Output Log → UE Log Analyzer (load text and switch tool).
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

export interface LogAnalyzerImportPayload {
  id: number;
  text: string;
  fileName: string;
}

interface LogAnalyzerImportContextValue {
  pendingImport: LogAnalyzerImportPayload | null;
  sendToVisualizer: (text: string, fileName?: string) => void;
  clearPendingImport: () => void;
}

const LogAnalyzerImportContext = createContext<LogAnalyzerImportContextValue | null>(null);

export function LogAnalyzerImportProvider({
  children,
  onOpenAnalyzer,
}: {
  children: React.ReactNode;
  onOpenAnalyzer: () => void;
}) {
  const [pendingImport, setPendingImport] = useState<LogAnalyzerImportPayload | null>(null);

  const sendToVisualizer = useCallback(
    (text: string, fileName = 'output-log.txt') => {
      if (!text.trim()) return;
      setPendingImport({ id: Date.now(), text, fileName });
      onOpenAnalyzer();
    },
    [onOpenAnalyzer]
  );

  const clearPendingImport = useCallback(() => {
    setPendingImport(null);
  }, []);

  const value = useMemo(
    () => ({ pendingImport, sendToVisualizer, clearPendingImport }),
    [pendingImport, sendToVisualizer, clearPendingImport]
  );

  return <LogAnalyzerImportContext.Provider value={value}>{children}</LogAnalyzerImportContext.Provider>;
}

export function useLogAnalyzerImport() {
  const ctx = useContext(LogAnalyzerImportContext);
  if (!ctx) {
    throw new Error('useLogAnalyzerImport must be used within LogAnalyzerImportProvider');
  }
  return ctx;
}

/** Optional hook for Output Log when provider may be absent (defensive). */
export function useLogAnalyzerImportOptional() {
  return useContext(LogAnalyzerImportContext);
}
