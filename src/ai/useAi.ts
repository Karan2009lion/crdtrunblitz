import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createLearner, type LearnerState } from './learner';

export interface AiStore {
  learner: LearnerState;
  status: 'starting' | 'loading' | 'learning' | 'offline';
  message: string;
}

/** The neural network and its record, saved in the browser separately from the paper account. */
export const useAi = create<AiStore>()(
  persist(() => ({ learner: createLearner(), status: 'starting' as AiStore['status'], message: '' }), {
    name: 'crdtrade-ai',
    version: 1,
    storage: createJSONStorage(() => localStorage),
    partialize: (s) => ({ learner: s.learner }),
  }),
);
