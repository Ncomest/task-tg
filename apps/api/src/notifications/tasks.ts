import type { TaskItem } from '@task-tg/shared';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { TelegramSender } from './telegram.js';

const DESCRIPTION_LIMIT = 400;

interface NotificationUser {
  firstName: string;
  lastName: string | null;
  username: string | null;
}

export interface NewTaskNotification {
  teamId: string;
  actorId: string;
  task: TaskItem;
}

export interface TaskNotifier {
  taskCreated(input: NewTaskNotification): Promise<{ sent: number; failed: number }>;
}

export interface NewTaskMessageInput {
  teamName: string;
  title: string;
  description: string;
  authorName: string;
  assigneeName: string | null;
}

function displayName(user: NotificationUser | undefined) {
  if (!user) return 'Участник';
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return fullName || (user.username ? `@${user.username}` : 'Участник');
}

export function formatNewTaskMessage(input: NewTaskMessageInput) {
  const description = [...input.description.trim()];
  const details = description.length > DESCRIPTION_LIMIT
    ? `${description.slice(0, DESCRIPTION_LIMIT).join('')}…`
    : description.join('');
  return [
    `🆕 Новая задача в команде «${input.teamName}»`,
    input.title,
    ...(details ? ['', details] : []),
    '',
    `Автор: ${input.authorName}`,
    ...(input.assigneeName ? [`Ответственный: ${input.assigneeName}`] : []),
  ].join('\n');
}

/**
 * Notifies every team member except the task author. Delivery is best effort:
 * recipients that cannot be reached (for example, the bot was never started)
 * are counted as failed and do not fail task creation.
 */
export function createTaskNotifier(db: PrismaClient, sender: TelegramSender): TaskNotifier {
  return {
    async taskCreated({ teamId, actorId, task }) {
      const team = await db.team.findUnique({
        where: { id: teamId },
        select: {
          name: true,
          memberships: {
            select: {
              userId: true,
              user: { select: { firstName: true, lastName: true, username: true, telegramId: true } },
            },
          },
        },
      });
      if (!team) return { sent: 0, failed: 0 };
      const author = team.memberships.find((membership) => membership.userId === actorId)?.user;
      const assignee = task.assigneeId ? team.memberships.find((membership) => membership.userId === task.assigneeId)?.user : undefined;
      const text = formatNewTaskMessage({
        teamName: team.name,
        title: task.title,
        description: task.description,
        authorName: displayName(author),
        assigneeName: task.assigneeId ? displayName(assignee) : null,
      });
      const recipients = team.memberships.filter((membership) => membership.userId !== actorId);
      const results = await Promise.allSettled(recipients.map((membership) => sender.sendMessage(String(membership.user.telegramId), text)));
      const failed = results.filter((result) => result.status === 'rejected').length;
      return { sent: results.length - failed, failed };
    },
  };
}
