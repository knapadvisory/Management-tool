// Task lifecycle statuses, shared across the board, list and modal.
export const TASK_STATUSES = [
  { value: 'in_progress', label: 'In Progress', color: '#0ea5e9' },
  { value: 'completed', label: 'Completed', color: '#16a34a' },
  { value: 'hold', label: 'On Hold', color: '#f59e0b' },
  { value: 'cancelled', label: 'Cancelled', color: '#6b7280' },
];

export const statusMeta = (value) => TASK_STATUSES.find((s) => s.value === value) || TASK_STATUSES[0];
export const needsReason = (value) => value === 'hold' || value === 'cancelled';
