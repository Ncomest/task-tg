import type { Project } from '@task-tg/shared';

export const projectOptions: { value: Project; label: string }[] = [
  { value: 'TG_BUDGET', label: 'tg-budget · учёт финансов' },
  { value: 'TASK_TG', label: 'task-tg · таск-менеджер' },
];

const shortLabels: Record<Project, string> = {
  TG_BUDGET: 'tg-budget',
  TASK_TG: 'task-tg',
};

export function projectLabel(project: Project | null) {
  if (!project) return 'Проект не указан';
  return shortLabels[project];
}
