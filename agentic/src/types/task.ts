export type Priority = "Critical" | "High" | "Medium" | "Low";

export type TaskStatus = "Pending" | "In Progress" | "Completed";

export type EnergyLevel = "Low" | "Medium" | "High";

export interface Subtask {
  id: string;
  title: string;
  completed: boolean;
}

export interface Task {
  id: string;
  name: string;
  description?: string;
  dueDate?: string;
  category: string;
  priority: Priority;
  estimatedMinutes?: number;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  subtasks: Subtask[];
  suggestedSubtasks?: string[];
}

export interface DailyPlanItem {
  taskId: string;
  taskName: string;
  allocatedMinutes: number;
  startTime: string;
  endTime: string;
}

export interface DailyPlan {
  date: string;
  energyLevel: EnergyLevel;
  availableMinutes: number;
  items: DailyPlanItem[];
  notes: string[];
}
