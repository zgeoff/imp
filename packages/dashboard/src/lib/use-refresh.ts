import { useQueryClient } from '@tanstack/react-query';

// After a change, every view asks impd again: one action moves RAM, states
// and checkpoints at once, and every query is cheap.
export function useRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();

  return () => queryClient.invalidateQueries();
}
