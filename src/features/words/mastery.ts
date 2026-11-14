import type { MasteryStatus } from '../../types';

export const masteryZh: Record<MasteryStatus, string> = {
  passive: '认识',
  training: '练用中',
  active: '会用',
};

export const masteryOrder: MasteryStatus[] = ['passive', 'training', 'active'];

export type MasteryFilter = MasteryStatus | 'all';
