import { useEffect } from "react";

interface UseLoadOnTabActivationParams {
  isActive: boolean;
  loading: boolean;
  loaded: boolean;
  load: () => void;
}

/**
 * Trigger one-time tab data loading on first activation.
 */
export function useLoadOnTabActivation({
  isActive,
  loading,
  loaded,
  load,
}: UseLoadOnTabActivationParams) {
  useEffect(() => {
    if (!isActive || loading || loaded) return;
    load();
  }, [isActive, loading, loaded, load]);
}
