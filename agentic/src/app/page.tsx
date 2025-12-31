"use client";

import {
  FormEvent,
  startTransition,
  useEffect,
  useMemo,
  useState,
} from "react";
import clsx from "clsx";
import { parseTaskInput } from "@/lib/taskParser";
import {
  DailyPlan,
  DailyPlanItem,
  EnergyLevel,
  Priority,
  Subtask,
  Task,
  TaskStatus,
} from "@/types/task";
import {
  addMinutes,
  differenceInMinutes,
  endOfDay,
  format,
  isAfter,
  isBefore,
  isPast,
  isToday,
  isTomorrow,
  parseISO,
  startOfDay,
  subDays,
  isWithinInterval,
} from "date-fns";
import {
  AlertCircle,
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clock,
  ListTodo,
  PencilLine,
  Plus,
  Sparkles,
  Target,
  Zap,
} from "lucide-react";

const STORAGE_KEY = "taskpilot.tasks.v1";
const PLAN_STORAGE_KEY = "taskpilot.plan.v1";

const priorityWeights: Record<Priority, number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
};

const statusOptions: TaskStatus[] = ["Pending", "In Progress", "Completed"];

const energyStartHour: Record<EnergyLevel, number> = {
  High: 8,
  Medium: 9,
  Low: 10,
};

const TIP_LIBRARY = [
  "Group similar tasks into themed blocks to stay in flow longer.",
  "Protect one deep-focus block each day by silencing notifications.",
  "Schedule breaks after high-intensity tasks to avoid energy dips.",
  "Batch quick wins together to build momentum.",
  "Review tomorrow's top three tasks every evening.",
  "Assign explicit outcomes to each task so you know when to stop.",
];

const QUESTION_LIBRARY = [
  "Would time-blocking your top priorities help keep today focused?",
  "What obstacle could prevent your next critical task from finishing on time?",
  "Is there a task you can delegate or defer to reclaim focus?",
  "Which project deserves a dedicated deep-work block this week?",
  "Where can you add buffers to handle surprises without stress?",
];

const safeParseDate = (value?: string) => {
  if (!value) return undefined;
  try {
    const parsed = parseISO(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  } catch {
    return undefined;
  }
};

const describeDeadline = (value?: string) => {
  const date = safeParseDate(value);
  if (!date) return "No deadline";
  if (isToday(date)) return `Today · ${format(date, "p")}`;
  if (isTomorrow(date)) return `Tomorrow · ${format(date, "p")}`;
  if (isPast(date)) return `Overdue · ${format(date, "MMM d · p")}`;
  return `${format(date, "EEE, MMM d · p")}`;
};

const getDefaultEstimate = (priority: Priority) => {
  switch (priority) {
    case "Critical":
      return 90;
    case "High":
      return 60;
    case "Medium":
      return 45;
    case "Low":
      return 30;
  }
};

const groupByPriority = (tasks: Task[]) =>
  tasks.reduce<Record<Priority, Task[]>>(
    (acc, task) => {
      acc[task.priority].push(task);
      return acc;
    },
    { Critical: [], High: [], Medium: [], Low: [] },
  );

const calculateProductivityScore = (tasks: Task[]) => {
  if (!tasks.length) return 0;
  const completed = tasks.filter((task) => task.status === "Completed");
  const highImpact = completed.filter((task) =>
    ["Critical", "High"].includes(task.priority),
  );
  const baseScore = Math.round((completed.length / tasks.length) * 70);
  const impactBonus = Math.min(30, highImpact.length * 10);
  return Math.min(100, baseScore + impactBonus);
};

const buildDailyPlan = (
  tasks: Task[],
  availableMinutes: number,
  energyLevel: EnergyLevel,
): DailyPlan => {
  const activeTasks = tasks.filter((task) => task.status !== "Completed");
  const sorted = [...activeTasks].sort((a, b) => {
    const weightDelta =
      priorityWeights[b.priority] - priorityWeights[a.priority];
    if (weightDelta !== 0) return weightDelta;
    const dueA = safeParseDate(a.dueDate);
    const dueB = safeParseDate(b.dueDate);
    if (dueA && dueB) return dueA.getTime() - dueB.getTime();
    if (dueA) return -1;
    if (dueB) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });

  const items: DailyPlanItem[] = [];
  const notes: string[] = [];
  let minutesRemaining = availableMinutes;
  let cursor = new Date();
  cursor.setHours(energyStartHour[energyLevel], 0, 0, 0);

  for (const task of sorted) {
    if (minutesRemaining <= 0) break;
    const estimate = task.estimatedMinutes ?? getDefaultEstimate(task.priority);
    const allocation = Math.min(estimate, minutesRemaining);
    const startTime = cursor.toISOString();
    cursor = addMinutes(cursor, allocation);
    const endTime = cursor.toISOString();
    minutesRemaining -= allocation;
    items.push({
      taskId: task.id,
      taskName: task.name,
      allocatedMinutes: allocation,
      startTime,
      endTime,
    });
  }

  if (!items.length) {
    notes.push("No pending tasks were scheduled. Review priorities or add tasks.");
  }

  if (minutesRemaining > 0) {
    notes.push(
      `You still have ${minutesRemaining} minutes free. Plan recovery, learning, or proactive work.`,
    );
  }

  if (sorted.length > items.length) {
    const remainingCritical = sorted
      .slice(items.length)
      .filter((task) => ["Critical", "High"].includes(task.priority));
    if (remainingCritical.length) {
      notes.push(
        `Consider rescheduling less important work to fit ${remainingCritical.length} high-impact task${remainingCritical.length > 1 ? "s" : ""
        }.`,
      );
    }
  }

  return {
    date: new Date().toISOString(),
    energyLevel,
    availableMinutes,
    items,
    notes,
  };
};

const computeTimelineBuckets = (tasks: Task[]) => {
  const todayStart = startOfDay(new Date());
  const todayEnd = endOfDay(new Date());
  const today: Task[] = [];
  const upcoming: Task[] = [];
  const overdue: Task[] = [];

  tasks.forEach((task) => {
    const due = safeParseDate(task.dueDate);
    if (!due) return;
    if (task.status === "Completed") return;

    if (isBefore(due, todayStart)) {
      overdue.push(task);
    } else if (isWithinInterval(due, { start: todayStart, end: todayEnd })) {
      today.push(task);
    } else {
      upcoming.push(task);
    }
  });

  const sortByDue = (list: Task[]) =>
    list.sort((a, b) => {
      const dueA = safeParseDate(a.dueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const dueB = safeParseDate(b.dueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return dueA - dueB;
    });

  return {
    today: sortByDue(today),
    upcoming: sortByDue(upcoming),
    overdue: sortByDue(overdue),
  };
};

const computeWeeklySummary = (tasks: Task[]) => {
  const now = new Date();
  const windowStart = subDays(now, 7);
  const created = tasks.filter(
    (task) => isAfter(parseISO(task.createdAt), windowStart) || isToday(parseISO(task.createdAt)),
  );
  const completed = tasks.filter(
    (task) =>
      task.completedAt &&
      (isAfter(parseISO(task.completedAt), windowStart) ||
        isToday(parseISO(task.completedAt))),
  );
  const overdue = tasks.filter((task) => {
    const due = safeParseDate(task.dueDate);
    if (!due) return false;
    return isPast(due) && task.status !== "Completed";
  });

  const completionRate = created.length
    ? Math.round((completed.length / created.length) * 100)
    : 0;

  const bottlenecks: string[] = [];
  if (overdue.length > 0) {
    bottlenecks.push(`${overdue.length} task${overdue.length > 1 ? "s" : ""} slipped past their deadlines.`);
  }
  const missingEstimates = tasks.filter(
    (task) => task.status !== "Completed" && !task.estimatedMinutes,
  );
  if (missingEstimates.length >= 3) {
    bottlenecks.push("Several tasks are missing time estimates, making scheduling harder.");
  }
  const inProgressStall = tasks.filter(
    (task) =>
      task.status === "In Progress" &&
      isAfter(new Date(), addMinutes(parseISO(task.updatedAt), 720)),
  );
  if (inProgressStall.length) {
    bottlenecks.push("Some tasks marked 'In Progress' may be stuck. Replan or break them down.");
  }

  return {
    createdCount: created.length,
    completedCount: completed.length,
    completionRate,
    bottlenecks,
    productivityScore: calculateProductivityScore(tasks),
  };
};

const computeCategorySummary = (tasks: Task[]) => {
  const summary = new Map<
    string,
    { total: number; completed: number; pending: number }
  >();
  tasks.forEach((task) => {
    if (!summary.has(task.category)) {
      summary.set(task.category, { total: 0, completed: 0, pending: 0 });
    }
    const entry = summary.get(task.category)!;
    entry.total += 1;
    if (task.status === "Completed") {
      entry.completed += 1;
    } else {
      entry.pending += 1;
    }
  });

  return Array.from(summary.entries())
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.total - a.total);
};

type EisenhowerQuadrant =
  | "urgentImportant"
  | "importantNotUrgent"
  | "urgentNotImportant"
  | "neither";

const determineQuadrant = (task: Task): EisenhowerQuadrant => {
  const due = safeParseDate(task.dueDate);
  const important = ["Critical", "High"].includes(task.priority);
  const urgent =
    due != null
      ? differenceInMinutes(due, new Date()) <= 48 * 60 || isPast(due)
      : task.priority === "Critical";

  if (urgent && important) return "urgentImportant";
  if (important && !urgent) return "importantNotUrgent";
  if (!important && urgent) return "urgentNotImportant";
  return "neither";
};

const buildEisenhowerMatrix = (tasks: Task[]) => {
  return tasks.reduce<
    Record<EisenhowerQuadrant, Task[]>
  >(
    (acc, task) => {
      if (task.status === "Completed") return acc;
      const quadrant = determineQuadrant(task);
      acc[quadrant].push(task);
      return acc;
    },
    {
      urgentImportant: [],
      importantNotUrgent: [],
      urgentNotImportant: [],
      neither: [],
    },
  );
};

const buildCoachInsights = (tasks: Task[]) => {
  const overdue = tasks.filter((task) => {
    const due = safeParseDate(task.dueDate);
    if (!due) return false;
    return isPast(due) && task.status !== "Completed";
  });
  const missingDeadlines = tasks.filter(
    (task) => !task.dueDate && task.status !== "Completed",
  );
  const criticalSoon = tasks.filter((task) => {
    const due = safeParseDate(task.dueDate);
    if (!due) return false;
    return (
      ["Critical", "High"].includes(task.priority) &&
      isBefore(due, endOfDay(new Date()))
    );
  });

  let question =
    QUESTION_LIBRARY[Math.floor(Math.random() * QUESTION_LIBRARY.length)];
  if (overdue.length) {
    question = `Which overdue task will you reschedule first to regain momentum?`;
  } else if (criticalSoon.length) {
    question = `Do you have protected focus time for ${criticalSoon[0].name}?`;
  } else if (missingDeadlines.length) {
    question = `Can you assign deadlines to ${missingDeadlines.length} open task${missingDeadlines.length > 1 ? "s" : ""
    } to tighten your plan?`;
  }

  const tip =
    TIP_LIBRARY[Math.floor(Math.random() * TIP_LIBRARY.length)];

  return { question, tip };
};

const priorityPills: Record<Priority, string> = {
  Critical: "bg-rose-500/20 text-rose-200 border border-rose-400/40",
  High: "bg-orange-500/20 text-orange-200 border border-orange-400/40",
  Medium: "bg-amber-500/20 text-amber-100 border border-amber-400/40",
  Low: "bg-emerald-500/20 text-emerald-100 border border-emerald-400/40",
};

const statusPills: Record<TaskStatus, string> = {
  Pending: "bg-slate-800 text-slate-200 border border-slate-700",
  "In Progress": "bg-sky-500/20 text-sky-100 border border-sky-400/40",
  Completed: "bg-emerald-500/25 text-emerald-100 border border-emerald-400/40",
};

const toDateTimeLocalValue = (value?: string) => {
  const date = safeParseDate(value);
  return date ? format(date, "yyyy-MM-dd'T'HH:mm") : "";
};

interface TaskCardProps {
  task: Task;
  onUpdate: (taskId: string, updates: Partial<Task>) => void;
  onToggleSubtask: (taskId: string, subtaskId: string) => void;
  onAddSubtask: (taskId: string, title: string) => void;
}

const TaskCard = ({
  task,
  onUpdate,
  onToggleSubtask,
  onAddSubtask,
}: TaskCardProps) => {
  const handleDueDateChange = (value: string) => {
    onUpdate(task.id, { dueDate: value ? new Date(value).toISOString() : undefined });
  };

  const handleEstimateChange = (value: string) => {
    const minutes = value ? Math.max(5, Math.round(Number(value))) : undefined;
    onUpdate(task.id, { estimatedMinutes: minutes });
  };

  const handleAddSubtask = () => {
    const title = window.prompt("Subtask name");
    if (title && title.trim().length) {
      onAddSubtask(task.id, title.trim());
    }
  };

  return (
    <article className="glass-panel rounded-xl p-5 shadow-inner shadow-slate-950/40 transition hover:border-slate-700 hover:shadow-xl">
      <div className="flex flex-col gap-3">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Task Name</p>
            <h3 className="text-lg font-semibold text-slate-100">{task.name}</h3>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={clsx("rounded-full px-3 py-1 text-xs font-semibold", priorityPills[task.priority])}>
              {task.priority}
            </span>
            <span className={clsx("rounded-full px-3 py-1 text-xs font-semibold", statusPills[task.status])}>
              {task.status}
            </span>
          </div>
        </header>

        <dl className="grid gap-3 text-sm text-slate-300 sm:grid-cols-2">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-slate-400" />
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Deadline</p>
              <p className="font-medium text-slate-200">{describeDeadline(task.dueDate)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ListTodo className="h-4 w-4 text-slate-400" />
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Category</p>
              <p className="font-medium text-slate-200">{task.category}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-slate-400" />
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Estimate</p>
              <p className="font-medium text-slate-200">
                {task.estimatedMinutes ? `${task.estimatedMinutes} min` : "Estimate needed"}
              </p>
            </div>
          </div>
        </dl>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-slate-500">
            Status
            <select
              value={task.status}
              onChange={(event) =>
                onUpdate(task.id, { status: event.target.value as TaskStatus })
              }
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-500/40"
            >
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-slate-500">
            Priority
            <select
              value={task.priority}
              onChange={(event) =>
                onUpdate(task.id, { priority: event.target.value as Priority })
              }
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-500/40"
            >
              {(["Critical", "High", "Medium", "Low"] as Priority[]).map((priority) => (
                <option key={priority} value={priority}>
                  {priority}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-slate-500">
            Deadline
            <input
              type="datetime-local"
              value={toDateTimeLocalValue(task.dueDate)}
              onChange={(event) => handleDueDateChange(event.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-500/40"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-slate-500">
            Estimate (minutes)
            <input
              type="number"
              min={5}
              step={5}
              value={task.estimatedMinutes ?? ""}
              onChange={(event) => handleEstimateChange(event.target.value)}
              placeholder="30"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-500/40"
            />
          </label>
        </div>

        {task.subtasks.length > 0 && (
          <section className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
            <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-slate-500">
              <span>Subtasks</span>
              <button
                type="button"
                onClick={handleAddSubtask}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-300 hover:text-slate-100"
              >
                <Plus className="h-3 w-3" />
                Add
              </button>
            </div>
            <ul className="space-y-2">
              {task.subtasks.map((subtask) => (
                <li key={subtask.id}>
                  <label className="flex items-center gap-3 text-sm text-slate-300">
                    <input
                      type="checkbox"
                      checked={subtask.completed}
                      onChange={() => onToggleSubtask(task.id, subtask.id)}
                      className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-emerald-400 focus:ring-emerald-400"
                    />
                    <span
                      className={clsx(
                        "transition",
                        subtask.completed
                          ? "text-slate-500 line-through"
                          : "text-slate-200",
                      )}
                    >
                      {subtask.title}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!task.subtasks.length && (
          <button
            type="button"
            onClick={handleAddSubtask}
            className="inline-flex w-fit items-center gap-2 rounded-lg border border-dashed border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:border-slate-500 hover:text-slate-100"
          >
            <Plus className="h-3 w-3" />
            Add subtask
          </button>
        )}
      </div>
    </article>
  );
};

export default function Home() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [plan, setPlan] = useState<DailyPlan | null>(null);
  const [taskInput, setTaskInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [parserNotes, setParserNotes] = useState<string[]>([]);
  const [availableMinutes, setAvailableMinutes] = useState<number>(480);
  const [energyLevel, setEnergyLevel] = useState<EnergyLevel>("Medium");

  useEffect(() => {
    const storedTasks = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (storedTasks) {
      try {
        const parsed: Task[] = JSON.parse(storedTasks);
        startTransition(() => {
          setTasks(parsed);
        });
      } catch (error) {
        console.error("Failed to load tasks", error);
      }
    }
    const storedPlan = typeof window !== "undefined" ? localStorage.getItem(PLAN_STORAGE_KEY) : null;
    if (storedPlan) {
      try {
        const parsed: DailyPlan = JSON.parse(storedPlan);
        startTransition(() => {
          setPlan(parsed);
          setAvailableMinutes(parsed.availableMinutes);
          setEnergyLevel(parsed.energyLevel);
        });
      } catch (error) {
        console.error("Failed to load plan", error);
      }
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  }, [tasks]);

  useEffect(() => {
    if (!plan || typeof window === "undefined") return;
    localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(plan));
  }, [plan]);

  const priorityGroups = useMemo(() => groupByPriority(tasks), [tasks]);
  const timelineBuckets = useMemo(() => computeTimelineBuckets(tasks), [tasks]);
  const categorySummary = useMemo(() => computeCategorySummary(tasks), [tasks]);
  const matrix = useMemo(() => buildEisenhowerMatrix(tasks), [tasks]);
  const weeklySummary = useMemo(() => computeWeeklySummary(tasks), [tasks]);
  const coachInsights = useMemo(() => buildCoachInsights(tasks), [tasks]);

  const reminders = useMemo(() => {
    const now = new Date();
    const soonThreshold = addMinutes(now, 24 * 60);
    const upcoming = tasks.filter((task) => {
      const due = safeParseDate(task.dueDate);
      if (!due) return false;
      if (task.status === "Completed") return false;
      return isAfter(due, now) && isBefore(due, soonThreshold);
    });
    const overdue = tasks.filter((task) => {
      const due = safeParseDate(task.dueDate);
      if (!due) return false;
      return isPast(due) && task.status !== "Completed";
    });
    return { upcoming, overdue };
  }, [tasks]);

  const handleTaskSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!taskInput.trim()) {
      setInputError("Please describe at least one task.");
      return;
    }
    try {
      const parsed = parseTaskInput(taskInput);
      const now = new Date().toISOString();
      const subtasks: Subtask[] = parsed.suggestedSubtasks.map((title) => ({
        id: crypto.randomUUID(),
        title,
        completed: false,
      }));
      const task: Task = {
        id: crypto.randomUUID(),
        name: parsed.name,
        dueDate: parsed.dueDate,
        priority: parsed.priority,
        category: parsed.category,
        estimatedMinutes: parsed.estimatedMinutes,
        status: "Pending",
        createdAt: now,
        updatedAt: now,
        subtasks,
        suggestedSubtasks: parsed.suggestedSubtasks,
      };
      setTasks((previous) => [task, ...previous]);
      setTaskInput("");
      setInputError(null);
      setFollowUps(parsed.followUps);
      setParserNotes(parsed.notes);
    } catch (error) {
      setInputError(
        error instanceof Error ? error.message : "Unable to understand the task.",
      );
    }
  };

  const updateTask = (taskId: string, updates: Partial<Task>) => {
    setTasks((previous) =>
      previous.map((task) => {
        if (task.id !== taskId) return task;
        const next: Task = {
          ...task,
          ...updates,
          updatedAt: new Date().toISOString(),
        };

        if (updates.status) {
          if (updates.status === "Completed") {
            next.completedAt = task.completedAt ?? new Date().toISOString();
          } else {
            next.completedAt = undefined;
          }
        }

        if (updates.subtasks) {
          next.subtasks = updates.subtasks;
        }

        return next;
      }),
    );
  };

  const toggleSubtask = (taskId: string, subtaskId: string) => {
    setTasks((previous) =>
      previous.map((task) => {
        if (task.id !== taskId) return task;
        const subtasks = task.subtasks.map((subtask) =>
          subtask.id === subtaskId
            ? { ...subtask, completed: !subtask.completed }
            : subtask,
        );
        const allDone =
          subtasks.length > 0 && subtasks.every((subtask) => subtask.completed);
        return {
          ...task,
          subtasks,
          status: allDone ? "Completed" : task.status,
          completedAt: allDone ? new Date().toISOString() : task.completedAt,
          updatedAt: new Date().toISOString(),
        };
      }),
    );
  };

  const addSubtask = (taskId: string, title: string) => {
    setTasks((previous) =>
      previous.map((task) => {
        if (task.id !== taskId) return task;
        const subtasks = [
          ...task.subtasks,
          { id: crypto.randomUUID(), title, completed: false },
        ];
        return {
          ...task,
          subtasks,
          updatedAt: new Date().toISOString(),
        };
      }),
    );
  };

  const handleGeneratePlan = () => {
    const sanitized = Math.max(30, Math.min(12 * 60, availableMinutes));
    setAvailableMinutes(sanitized);
    const generated = buildDailyPlan(tasks, sanitized, energyLevel);
    setPlan(generated);
  };

  const pendingTasks = tasks.filter((task) => task.status !== "Completed");

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900 pb-24 text-slate-100">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 pt-16 lg:px-8">
        <header className="flex flex-col gap-6 rounded-3xl border border-slate-800 bg-slate-900/60 p-8 shadow-xl shadow-slate-950/60">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-white md:text-4xl">
                TaskPilot · Intelligent To-Do Strategist
              </h1>
              <p className="mt-2 max-w-2xl text-base text-slate-300">
                Capture intentions in natural language and TaskPilot transforms them into
                an actionable plan with prioritization, scheduling, and coaching baked in.
              </p>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 px-6 py-4 text-sm text-slate-300">
              <p className="text-xs uppercase tracking-wide text-slate-500">Snapshot</p>
              <div className="mt-2 grid grid-cols-3 gap-4 text-center text-sm">
                <div>
                  <div className="text-xl font-semibold text-white">{pendingTasks.length}</div>
                  <p className="text-xs text-slate-400">Active</p>
                </div>
                <div>
                  <div className="text-xl font-semibold text-white">
                    {priorityGroups.Critical.length}
                  </div>
                  <p className="text-xs text-slate-400">Critical</p>
                </div>
                <div>
                  <div className="text-xl font-semibold text-white">
                    {weeklySummary.productivityScore}
                  </div>
                  <p className="text-xs text-slate-400">Productivity</p>
                </div>
              </div>
            </div>
          </div>

          <form
            onSubmit={handleTaskSubmit}
            className="glass-panel flex flex-col gap-4 rounded-2xl border border-slate-800/70 p-6"
          >
            <label className="text-sm font-semibold text-slate-200">
              Quick capture
              <textarea
                value={taskInput}
                onChange={(event) => setTaskInput(event.target.value)}
                placeholder="Example: Tomorrow finish Q2 budget review, prepare slides for Monday client meeting (90 minutes) and book dentist check-up next Wednesday."
                className="mt-2 h-28 w-full resize-none rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-600/40"
              />
            </label>
            {inputError && (
              <p className="flex items-center gap-2 text-sm text-rose-300">
                <AlertCircle className="h-4 w-4" /> {inputError}
              </p>
            )}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap gap-2 text-xs text-slate-400">
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 px-3 py-1">
                  <Sparkles className="h-3 w-3 text-emerald-300" />
                  Natural language parsing
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 px-3 py-1">
                  <Target className="h-3 w-3 text-sky-300" />
                  Eisenhower prioritization
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 px-3 py-1">
                  <Zap className="h-3 w-3 text-amber-300" />
                  Smart reminders
                </span>
              </div>
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-sky-500 px-6 py-2 text-sm font-semibold text-slate-950 shadow-lg shadow-sky-500/40 transition hover:bg-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-300/60"
              >
                <Plus className="h-4 w-4" />
                Add task
              </button>
            </div>
          </form>

          {(followUps.length > 0 || parserNotes.length > 0) && (
            <div className="grid gap-3 text-sm text-slate-300 md:grid-cols-2">
              {followUps.length > 0 && (
                <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                  <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <PencilLine className="h-4 w-4 text-sky-300" />
                    Follow-up questions
                  </p>
                  <ul className="mt-2 space-y-2 text-sm">
                    {followUps.map((item) => (
                      <li key={item} className="flex gap-2">
                        <span className="text-sky-300">•</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {parserNotes.length > 0 && (
                <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                  <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <AlertTriangle className="h-4 w-4 text-amber-300" />
                    Insights
                  </p>
                  <ul className="mt-2 space-y-2 text-sm">
                    {parserNotes.map((item) => (
                      <li key={item} className="flex gap-2">
                        <span className="text-amber-300">•</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </header>

        <section className="grid gap-8 lg:grid-cols-[2fr,1fr]">
          <section className="space-y-6">
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-white">📋 To-Do List</h2>
              <div className="space-y-5">
                <PriorityColumn
                  title="🚨 Critical Priority"
                  tasks={priorityGroups.Critical}
                  emptyMessage="All critical work is under control."
                  onUpdate={updateTask}
                  onToggleSubtask={toggleSubtask}
                  onAddSubtask={addSubtask}
                />
                <PriorityColumn
                  title="🔥 High Priority"
                  tasks={priorityGroups.High}
                  emptyMessage="No high-priority tasks pending."
                  onUpdate={updateTask}
                  onToggleSubtask={toggleSubtask}
                  onAddSubtask={addSubtask}
                />
                <PriorityColumn
                  title="⚡ Medium Priority"
                  tasks={priorityGroups.Medium}
                  emptyMessage="Medium-priority tasks will appear here."
                  onUpdate={updateTask}
                  onToggleSubtask={toggleSubtask}
                  onAddSubtask={addSubtask}
                />
                <PriorityColumn
                  title="💤 Low Priority"
                  tasks={priorityGroups.Low}
                  emptyMessage="Queue low-priority ideas without losing them."
                  onUpdate={updateTask}
                  onToggleSubtask={toggleSubtask}
                  onAddSubtask={addSubtask}
                />
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-3">
              <TimelinePanel title="Today" tasks={timelineBuckets.today} />
              <TimelinePanel title="Upcoming" tasks={timelineBuckets.upcoming} />
              <TimelinePanel title="Overdue" tasks={timelineBuckets.overdue} highlightOverdue />
            </div>

            <div className="glass-panel rounded-3xl border border-slate-800/70 p-6">
              <h3 className="text-lg font-semibold text-white">Eisenhower Matrix</h3>
              <p className="mt-2 text-sm text-slate-400">
                Balance urgency and importance to focus effort where it counts.
              </p>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <MatrixQuadrant
                  title="Urgent & Important"
                  accent="text-rose-300"
                  tasks={matrix.urgentImportant}
                />
                <MatrixQuadrant
                  title="Important, Not Urgent"
                  accent="text-emerald-300"
                  tasks={matrix.importantNotUrgent}
                />
                <MatrixQuadrant
                  title="Urgent, Not Important"
                  accent="text-amber-300"
                  tasks={matrix.urgentNotImportant}
                />
                <MatrixQuadrant
                  title="Neither"
                  accent="text-slate-400"
                  tasks={matrix.neither}
                />
              </div>
            </div>
          </section>

          <aside className="space-y-6">
            <div className="glass-panel space-y-4 rounded-3xl border border-slate-800/70 p-6">
              <h3 className="text-lg font-semibold text-white">Daily Focus Planner</h3>
              <p className="text-sm text-slate-400">
                Generate a realistic plan aligned with your energy levels and time budget.
              </p>
              <div className="grid gap-4">
                <label className="flex flex-col gap-2 text-xs uppercase tracking-wide text-slate-500">
                  Available time (minutes)
                  <input
                    type="number"
                    value={availableMinutes}
                    min={60}
                    max={12 * 60}
                    step={15}
                    onChange={(event) => setAvailableMinutes(Number(event.target.value))}
                    className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-600/40"
                  />
                </label>
                <label className="flex flex-col gap-2 text-xs uppercase tracking-wide text-slate-500">
                  Energy level
                  <select
                    value={energyLevel}
                    onChange={(event) =>
                      setEnergyLevel(event.target.value as EnergyLevel)
                    }
                    className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-600/40"
                  >
                    <option value="High">High</option>
                    <option value="Medium">Medium</option>
                    <option value="Low">Low</option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={handleGeneratePlan}
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 shadow-md shadow-emerald-500/40 transition hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-300/60"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Generate plan
                </button>
              </div>
              {plan && (
                <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                  <p className="text-xs uppercase tracking-wide text-emerald-300">
                    Today&apos;s plan
                  </p>
                  <ul className="mt-3 space-y-3 text-sm text-slate-200">
                    {plan.items.map((item) => (
                      <li
                        key={item.taskId}
                        className="flex flex-col justify-between gap-1 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
                      >
                        <span className="font-semibold">{item.taskName}</span>
                        <span className="text-xs text-slate-400">
                          {format(parseISO(item.startTime), "p")} – {format(parseISO(item.endTime), "p")} · {item.allocatedMinutes} min
                        </span>
                      </li>
                    ))}
                  </ul>
                  {plan.notes.length > 0 && (
                    <ul className="mt-3 space-y-2 text-xs text-emerald-200">
                      {plan.notes.map((note) => (
                        <li key={note} className="flex gap-2">
                          <span>•</span>
                          <span>{note}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <div className="glass-panel space-y-4 rounded-3xl border border-slate-800/70 p-6">
              <h3 className="text-lg font-semibold text-white">Reminders</h3>
              {reminders.overdue.length === 0 && reminders.upcoming.length === 0 ? (
                <p className="text-sm text-slate-400">
                  No reminders right now. You&apos;re on top of everything.
                </p>
              ) : (
                <>
                  {reminders.overdue.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-rose-300">
                        Overdue
                      </p>
                      <ul className="mt-2 space-y-2 text-sm">
                        {reminders.overdue.map((task) => (
                          <li key={task.id} className="flex items-center justify-between rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-rose-100">
                            <span>{task.name}</span>
                            <button
                              type="button"
                              onClick={() => updateTask(task.id, { status: "In Progress" })}
                              className="rounded-full bg-rose-500 px-3 py-1 text-xs font-semibold text-rose-50 shadow-sm hover:bg-rose-400"
                            >
                              Resume
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {reminders.upcoming.length > 0 && (
                    <div>
                      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-amber-300">
                        Due soon
                      </p>
                      <ul className="mt-2 space-y-2 text-sm">
                        {reminders.upcoming.map((task) => {
                          const due = safeParseDate(task.dueDate)!;
                          const minutes = Math.max(1, Math.round(differenceInMinutes(due, new Date())));
                          const hours = Math.round(minutes / 60);
                          const timeLabel = minutes < 90 ? `${minutes} min` : `${hours} hr`;
                          return (
                            <li key={task.id} className="flex items-center justify-between rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-amber-100">
                              <span>{task.name}</span>
                              <span className="text-xs uppercase tracking-wide">
                                {timeLabel}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="glass-panel space-y-4 rounded-3xl border border-slate-800/70 p-6">
              <h3 className="text-lg font-semibold text-white">Weekly Summary</h3>
              <div className="grid grid-cols-3 gap-4 text-center">
                <SummaryStat label="Created" value={weeklySummary.createdCount} />
                <SummaryStat label="Completed" value={weeklySummary.completedCount} />
                <SummaryStat label="Completion rate" value={`${weeklySummary.completionRate}%`} />
              </div>
              {weeklySummary.bottlenecks.length > 0 ? (
                <ul className="space-y-2 text-sm text-amber-200">
                  {weeklySummary.bottlenecks.map((item) => (
                    <li key={item} className="flex gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-300" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-400">
                  No major bottlenecks detected. Keep the habits rolling!
                </p>
              )}
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Category focus
                </p>
                <ul className="mt-2 space-y-2 text-sm text-slate-200">
                  {categorySummary.map((category) => (
                    <li
                      key={category.name}
                      className="flex items-center justify-between rounded-xl border border-slate-800 px-3 py-2"
                    >
                      <span>{category.name}</span>
                      <span className="text-xs text-slate-400">
                        {category.completed}/{category.total} done
                      </span>
                    </li>
                  ))}
                  {categorySummary.length === 0 && (
                    <li className="rounded-xl border border-slate-800 px-3 py-2 text-sm text-slate-400">
                      Add tasks to see category insights.
                    </li>
                  )}
                </ul>
              </div>
            </div>
          </aside>
        </section>

        <footer className="glass-panel grid gap-6 rounded-3xl border border-slate-800/70 p-6 md:grid-cols-[2fr,1fr]">
          <div>
            <h3 className="flex items-center gap-2 text-lg font-semibold text-white">
              <Sparkles className="h-5 w-5 text-emerald-300" />
              Productivity Coach
            </h3>
            <p className="mt-2 text-sm text-slate-300">
              {coachInsights.question}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-200">
            <p className="text-xs uppercase tracking-wide text-slate-500">Tip</p>
            <p className="mt-2">{coachInsights.tip}</p>
          </div>
        </footer>
      </div>
    </main>
  );
}

interface PriorityColumnProps {
  title: string;
  tasks: Task[];
  emptyMessage: string;
  onUpdate: (taskId: string, updates: Partial<Task>) => void;
  onToggleSubtask: (taskId: string, subtaskId: string) => void;
  onAddSubtask: (taskId: string, title: string) => void;
}

const PriorityColumn = ({
  title,
  tasks,
  emptyMessage,
  onUpdate,
  onToggleSubtask,
  onAddSubtask,
}: PriorityColumnProps) => {
  return (
    <section className="space-y-3">
      <h3 className="text-lg font-semibold text-white">{title}</h3>
      {tasks.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-800 bg-slate-950/50 px-4 py-3 text-sm text-slate-400">
          {emptyMessage}
        </p>
      ) : (
        <div className="grid gap-4">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onUpdate={onUpdate}
              onToggleSubtask={onToggleSubtask}
              onAddSubtask={onAddSubtask}
            />
          ))}
        </div>
      )}
    </section>
  );
};

interface TimelinePanelProps {
  title: string;
  tasks: Task[];
  highlightOverdue?: boolean;
}

const TimelinePanel = ({ title, tasks, highlightOverdue }: TimelinePanelProps) => {
  return (
    <section className="glass-panel rounded-3xl border border-slate-800/70 p-5">
      <h3
        className={clsx(
          "text-sm font-semibold uppercase tracking-wide",
          highlightOverdue ? "text-rose-300" : "text-slate-400",
        )}
      >
        {title}
      </h3>
      {tasks.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">Nothing here yet.</p>
      ) : (
        <ul className="mt-3 space-y-3 text-sm text-slate-200">
          {tasks.map((task) => (
            <li key={task.id} className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
              <p className="font-semibold text-white">{task.name}</p>
              <p className="text-xs text-slate-400">{describeDeadline(task.dueDate)}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

interface MatrixQuadrantProps {
  title: string;
  accent: string;
  tasks: Task[];
}

const MatrixQuadrant = ({ title, accent, tasks }: MatrixQuadrantProps) => (
  <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
    <p className={clsx("text-sm font-semibold uppercase tracking-wide", accent)}>{title}</p>
    {tasks.length === 0 ? (
      <p className="mt-2 text-sm text-slate-500">No tasks in this quadrant.</p>
    ) : (
      <ul className="mt-3 space-y-2 text-sm text-slate-200">
        {tasks.map((task) => (
          <li key={task.id} className="rounded-lg border border-slate-800 bg-slate-900/80 px-3 py-2">
            <p className="font-semibold text-white">{task.name}</p>
            <p className="text-xs text-slate-400">{describeDeadline(task.dueDate)}</p>
          </li>
        ))}
      </ul>
    )}
  </div>
);

interface SummaryStatProps {
  label: string;
  value: string | number;
}

const SummaryStat = ({ label, value }: SummaryStatProps) => (
  <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
    <div className="text-lg font-semibold text-white">{value}</div>
    <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
  </div>
);
