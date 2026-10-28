<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { AgentMessageItem, AgentRunItem, AgentRunStatus, Project, TaskItem, TaskStatus, TeamDetail } from '@task-tg/shared';
import ArchiveIcon from './ArchiveIcon.vue';
import { api, ApiError } from '../api';
import { projectLabel, projectOptions } from '../projects';
const props = defineProps<{ team: TeamDetail; currentUserId: string }>();
const emit = defineEmits<{ 'session-expired': []; 'access-lost': []; 'archive-view': [value: boolean] }>();
const tasks = ref<TaskItem[]>([]);
const archived = ref(false);
const pending = ref(new Set<string>());
const undoTask = ref<TaskItem | null>(null);
let loadSequence = 0;
let mounted = true;
function visible(task: TaskItem) {
  return Boolean(task.archivedAt) === archived.value && (archived.value || ( (!statusFilter.value || task.status === statusFilter.value) && (!assigneeFilter.value || (assigneeFilter.value === 'unassigned' ? !task.assigneeId : task.assigneeId === (assigneeFilter.value === 'me' ? props.currentUserId : assigneeFilter.value))) && (!q.value.trim() || `${task.title} ${task.description}`.toLowerCase().includes(q.value.trim().toLowerCase()))));
}
async function setArchived(task: TaskItem, archive: boolean) {
  if (pending.value.has(task.id) || busy.value) return;
  const index = tasks.value.findIndex(item => item.id === task.id);
  pending.value.add(task.id);
  tasks.value = tasks.value.filter(item => item.id !== task.id);
  error.value = ''; notice.value = ''; undoTask.value = null;
  try {
    const result = await api<{ task: TaskItem }>(`${base}/${task.id}/${archive ? 'archive' : 'restore'}`, { version: task.version });
    if (!mounted) return;
    if (visible(result.task)) tasks.value.splice(Math.max(index, 0), 0, result.task);
    notice.value = archive ? 'Задача перемещена в архив.' : 'Задача восстановлена в «Готово».';
    if (archive) undoTask.value = result.task;
  } catch (cause) {
    if (!mounted) return;
    if (visible(task) && !tasks.value.some(item => item.id === task.id)) tasks.value.splice(Math.max(index, 0), 0, task);
    fail(cause);
  } finally { pending.value.delete(task.id); }
}
function switchArchive() {
  if (busy.value || pending.value.size) return;
  archived.value = !archived.value;
  emit('archive-view', archived.value);
  tasks.value = []; cursor.value = null; error.value = ''; notice.value = ''; undoTask.value = null;
  void load();
}
const members = ref(props.team.members);
const busy = ref(false);
const refreshPending = ref(false);
const error = ref('');
const notice = ref('');
const q = ref('');
const statusFilter = ref('');
const assigneeFilter = ref('');
const cursor = ref<string | null>(null);
watch([q, statusFilter, assigneeFilter], () => { cursor.value = null; });
const sheet = ref<HTMLDialogElement | null>(null);
const editing = ref<TaskItem | null>(null);
const latest = ref<TaskItem | null>(null);
const conflicted = ref(false);
const title = ref('');
const description = ref('');
const status = ref<TaskStatus>('TODO');
const project = ref<Project | ''>('');
const assigneeId = ref('');
const deleting = ref(false);
const agentRuns = ref<AgentRunItem[]>([]);
const agentMessages = ref<AgentMessageItem[]>([]);
const agentMessageText = ref('');
const agentBusy = ref(false);
const agentChatBusy = ref(false);
const agentPollBusy = ref(false);
const agentMessagesPollBusy = ref(false);
const agentError = ref('');
const agentNotice = ref('');
const cancelingRunId = ref('');
let agentTimer: number | undefined;
const labels: Record<TaskStatus, string> = { TODO: 'К выполнению', IN_PROGRESS: 'В работе', DONE: 'Готово' };
const agentStatusLabels: Record<AgentRunStatus, string> = {
  QUEUED: 'В очереди', ASSESSING: 'Оценка', PLANNED: 'План готов', WORKING: 'В работе',
  REVIEW: 'Проверка', DONE: 'Готово', FAILED: 'Ошибка', CANCELLED: 'Отменено', NEEDS_INPUT: 'Нужно уточнение',
};
const activeAgentStatuses: AgentRunStatus[] = ['QUEUED', 'ASSESSING', 'PLANNED', 'WORKING', 'REVIEW'];
const columns = computed(() => (Object.keys(labels) as TaskStatus[]).filter(value => !statusFilter.value || value === statusFilter.value));
const agentActive = computed(() => agentRuns.value.some(run => activeAgentStatuses.includes(run.status)));
const latestAgentRun = computed(() => agentRuns.value[0] ?? null);
const hasChanges = computed(() => {
  const task = editing.value;
  if (!task) return false;
  return title.value.trim() !== task.title || description.value.trim() !== task.description || status.value !== task.status || project.value !== (task.project ?? '') || (assigneeId.value || null) !== task.assigneeId;
});
const agentChatDisabled = computed(() => agentChatBusy.value || agentBusy.value || busy.value || agentActive.value || conflicted.value || hasChanges.value || !editing.value?.project || Boolean(editing.value?.archivedAt));
const base = `/teams/${props.team.id}/tasks`;
function fail(cause: unknown) {
  if (cause instanceof ApiError && cause.status === 401) { emit('session-expired'); return; }
  if (cause instanceof ApiError && cause.code === 'TEAM_NOT_FOUND') emit('access-lost');
  const messages: Record<string, string> = {
    TASK_NOT_DONE: 'Архивировать можно только выполненные задачи.',
    TASK_ARCHIVED: 'Задача находится в архиве. Сначала восстановите её.',
    ASSIGNEE_NOT_MEMBER: 'Ответственный больше не состоит в команде. Обновите участников и выберите другого.',
    TASK_NOT_FOUND: 'Задача удалена. Ваш текст остаётся в форме; скопируйте его перед закрытием.',
    TEAM_NOT_FOUND: 'Доступ к команде закрыт.', INVALID_REQUEST: 'Проверьте поля формы.',
    INVALID_CURSOR: 'Список изменился. Нажмите «Применить / обновить», чтобы загрузить его заново.',
    TOO_MANY_REQUESTS: 'Слишком много запросов. Подождите минуту.',
    VERSION_CONFLICT: 'Задача изменилась. Ваш ввод сохранён. Сначала загрузите актуальную версию.',
  };
  error.value = cause instanceof ApiError ? messages[cause.code] ?? 'Ошибка сервера. Повторите действие.' : 'Нет соединения с сервером. Ваш ввод сохранён. Повторите действие.';
}
function agentFail(cause: unknown) {
  if (cause instanceof ApiError && cause.status === 401) { emit('session-expired'); return; }
  if (cause instanceof ApiError && cause.code === 'TEAM_NOT_FOUND') emit('access-lost');
  const messages: Record<string, string> = {
    AGENT_RUN_ACTIVE: 'Агент уже работает над этой задачей. Дождитесь завершения или отмените запуск.',
    AGENT_RUN_FINISHED: 'Этот запуск уже завершён. Обновите карточку задачи.',
    AGENT_RUN_NOT_FOUND: 'Запуск агента не найден. Обновите карточку задачи.',
    AGENT_NOT_CONFIGURED: 'Агент не настроен на сервере. Обратитесь к администратору.',
    AGENT_LEASE_EXPIRED: 'Сеанс агента истёк. Отправьте задачу ещё раз.',
    AGENT_STAGE_INVALID: 'Агент прислал этап в неверном порядке. Обновите карточку.',
    PROJECT_REQUIRED: 'Укажите проект задачи перед отправкой агенту.',
    TASK_ARCHIVED: 'Задача находится в архиве. Восстановите её, чтобы продолжить диалог.',
    TASK_NOT_FOUND: 'Задача удалена. Обновите список задач.',
    INVALID_REQUEST: 'Проверьте текст сообщения.',
    VERSION_CONFLICT: 'Задача изменилась. Сначала загрузите актуальную версию.',
    TEAM_NOT_FOUND: 'Доступ к команде закрыт.',
    TOO_MANY_REQUESTS: 'Слишком много запросов. Подождите минуту.',
  };
  agentError.value = cause instanceof ApiError ? messages[cause.code] ?? 'Не удалось выполнить действие агента. Повторите попытку.' : 'Нет соединения с сервером. Повторите попытку.';
}
function stopAgentPolling() {
  if (agentTimer !== undefined) { window.clearInterval(agentTimer); agentTimer = undefined; }
}
function ensureAgentPolling() {
  if (!agentActive.value) { stopAgentPolling(); return; }
  if (agentTimer !== undefined) return;
  agentTimer = window.setInterval(() => {
    if (!editing.value) return;
    void loadAgentRuns(editing.value.id, true);
    void loadAgentMessages(editing.value.id, true);
  }, 4000);
}
async function loadAgentRuns(taskId: string, polling = false) {
  if (polling && agentPollBusy.value) return;
  if (polling) agentPollBusy.value = true;
  try {
    const result = await api<{ runs: AgentRunItem[] }>(`${base}/${taskId}/agent-runs`);
    if (!editing.value || editing.value.id !== taskId) return;
    agentRuns.value = result.runs;
    ensureAgentPolling();
  } catch (cause) {
    if (!polling) agentFail(cause);
    else stopAgentPolling();
  } finally {
    if (polling) agentPollBusy.value = false;
  }
}
async function loadAgentMessages(taskId: string, polling = false) {
  if (polling && agentMessagesPollBusy.value) return;
  if (polling) agentMessagesPollBusy.value = true;
  try {
    const result = await api<{ messages: AgentMessageItem[] }>(`${base}/${taskId}/agent-messages`);
    if (!editing.value || editing.value.id !== taskId) return;
    agentMessages.value = result.messages;
  } catch (cause) {
    if (!polling) agentFail(cause);
  } finally {
    if (polling) agentMessagesPollBusy.value = false;
  }
}
function formattedDate(value: string) {
  return new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
async function load(more = false) {
  if (busy.value || pending.value.size) return;
  const sequence = ++loadSequence;
  busy.value = true; error.value = '';
  try {
    const query = new URLSearchParams();
    if (!archived.value && q.value.trim()) query.set('q', q.value.trim());
    if (!archived.value && statusFilter.value) query.set('status', statusFilter.value);
    if (!archived.value && assigneeFilter.value) query.set('assignee', assigneeFilter.value);
    if (more && cursor.value) query.set('cursor', cursor.value);
    const result = await api<{ tasks: TaskItem[]; nextCursor: string | null }>(`${archived.value ? `/teams/${props.team.id}/archive` : base}?${query}`);
    if (!mounted || sequence !== loadSequence) return;
    tasks.value = more ? [...tasks.value, ...result.tasks.filter(task => !tasks.value.some(old => old.id === task.id))] : result.tasks;
    cursor.value = result.nextCursor;
  } catch (cause) { fail(cause); }
  finally {
    busy.value = false;
    if (refreshPending.value) { refreshPending.value = false; void load(); }
  }
}
async function refreshMembers() {
  try { members.value = (await api<{ team: TeamDetail }>(`/teams/${props.team.id}`)).team.members; }
  catch (cause) { fail(cause); }
}
function open(task: TaskItem | null) {
  stopAgentPolling();
  editing.value = task; latest.value = null; conflicted.value = false; deleting.value = false;
  agentRuns.value = []; agentMessages.value = []; agentMessageText.value = ''; agentError.value = ''; agentNotice.value = ''; cancelingRunId.value = '';
  title.value = task?.title ?? ''; description.value = task?.description ?? '';
  status.value = task?.status ?? 'TODO';
  project.value = task?.project ?? (task ? '' : 'TG_BUDGET');
  assigneeId.value = task?.assigneeId ?? '';
  error.value = ''; notice.value = ''; sheet.value?.showModal();
  if (task) {
    void loadAgentRuns(task.id);
    void loadAgentMessages(task.id);
  }
  void refreshMembers();
}
async function fetchLatest() {
  if (!editing.value) return;
  busy.value = true;
  try { latest.value = (await api<{ task: TaskItem }>(`${base}/${editing.value.id}`)).task; error.value = ''; }
  catch (cause) { fail(cause); }
  finally { busy.value = false; }
}
function acceptLatest(keepDraft: boolean) {
  if (!latest.value) return;
  editing.value = latest.value;
  if (!keepDraft) {
    title.value = latest.value.title; description.value = latest.value.description;
    status.value = latest.value.status; project.value = latest.value.project ?? '';
    assigneeId.value = latest.value.assigneeId ?? '';
  }
  latest.value = null; conflicted.value = false; deleting.value = false;
  notice.value = keepDraft ? 'Ваш ввод сохранён. Проверьте его перед повторным сохранением.' : 'Загружены актуальные поля.';
}
async function save(remove = false) {
  if (busy.value || conflicted.value || (!remove && (!title.value.trim() || !project.value))) return;
  busy.value = true; error.value = '';
  try {
    const task = editing.value;
    const path = task ? `${base}/${task.id}` : base;
    await api(path, remove ? { version: task?.version } : { title: title.value.trim(), description: description.value.trim(), status: status.value, project: project.value, assigneeId: assigneeId.value || null, ...(task ? { version: task.version } : {}) }, remove ? 'DELETE' : task ? 'PATCH' : 'POST');
    sheet.value?.close(); notice.value = remove ? 'Задача удалена.' : 'Задача сохранена.';
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === 'VERSION_CONFLICT') { conflicted.value = true; latest.value = null; }
    fail(cause); return;
  } finally { busy.value = false; }
  await load();
}
async function sendToAgent() {
  const task = editing.value;
  if (!task || busy.value || agentBusy.value || agentChatBusy.value || agentActive.value || conflicted.value) return;
  if (task.archivedAt) { agentError.value = 'Задача находится в архиве. Восстановите её, чтобы продолжить диалог.'; return; }
  if (!task.project) { agentError.value = 'Укажите и сохраните проект задачи, чтобы отправить её агенту.'; return; }
  if (hasChanges.value) { agentError.value = 'Сначала сохраните изменения задачи, чтобы отправить её агенту.'; return; }
  if (agentMessageText.value.trim()) { await sendAgentMessage(); return; }
  agentBusy.value = true; agentError.value = ''; agentNotice.value = '';
  try {
    const result = await api<{ run: AgentRunItem; task: TaskItem }>(`${base}/${task.id}/agent-runs`, { version: task.version });
    editing.value = result.task;
    title.value = result.task.title; description.value = result.task.description;
    status.value = result.task.status; project.value = result.task.project ?? '';
    assigneeId.value = result.task.assigneeId ?? '';
    agentRuns.value = [result.run, ...agentRuns.value.filter(run => run.id !== result.run.id)];
    agentNotice.value = 'Задача отправлена агенту. Этапы будут появляться здесь.';
    ensureAgentPolling();
    void load();
  } catch (cause) {
    agentFail(cause);
  } finally {
    agentBusy.value = false;
  }
}
async function sendAgentMessage() {
  const task = editing.value;
  const body = agentMessageText.value.trim();
  if (!task || !body || agentChatDisabled.value) return;
  agentChatBusy.value = true; agentError.value = ''; agentNotice.value = '';
  try {
    const result = await api<{ message: AgentMessageItem; run: AgentRunItem; task: TaskItem }>(`${base}/${task.id}/agent-messages`, { body });
    editing.value = result.task;
    title.value = result.task.title; description.value = result.task.description;
    status.value = result.task.status; project.value = result.task.project ?? '';
    assigneeId.value = result.task.assigneeId ?? '';
    agentMessages.value = [...agentMessages.value.filter(message => message.id !== result.message.id), result.message];
    agentRuns.value = [result.run, ...agentRuns.value.filter(run => run.id !== result.run.id)];
    agentMessageText.value = '';
    agentNotice.value = 'Сообщение отправлено агенту. Дождитесь ответа.';
    ensureAgentPolling();
    void load();
  } catch (cause) {
    agentFail(cause);
  } finally {
    agentChatBusy.value = false;
  }
}
async function cancelAgentRun(run: AgentRunItem) {
  if (agentBusy.value) return;
  if (cancelingRunId.value !== run.id) {
    cancelingRunId.value = run.id;
    agentNotice.value = 'Нажмите «Подтвердить отмену», чтобы остановить агента.';
    return;
  }
  agentBusy.value = true; agentError.value = '';
  try {
    const result = await api<{ run: AgentRunItem }>(`${base}/${run.taskId}/agent-runs/${run.id}/cancel`, {}, 'POST');
    agentRuns.value = agentRuns.value.map(item => item.id === result.run.id ? result.run : item);
    cancelingRunId.value = '';
    agentNotice.value = 'Запуск агента отменён.';
    stopAgentPolling();
  } catch (cause) {
    agentFail(cause);
  } finally {
    agentBusy.value = false;
  }
}
onMounted(() => load());
onUnmounted(() => { mounted = false; stopAgentPolling(); });
defineExpose({ refresh: () => {
  if (busy.value) refreshPending.value = true;
  else void load();
} });
</script>

<template>
  <section
    class="tasks-panel"
    aria-labelledby="tasks-title"
  >
    <div class="section-header">
      <h3 id="tasks-title">
        {{ archived ? 'Архив задач' : 'Задачи' }}
      </h3>
      <button
        class="secondary archive-link"
        :disabled="busy || pending.size > 0"
        @click="switchArchive"
      >
        <ArchiveIcon />{{ archived ? 'К задачам' : 'Архив' }}
      </button>
      <button
        v-if="!archived"
        :disabled="busy || pending.size > 0"
        @click="open(null)"
      >
        + Задача
      </button>
    </div>
    <form
      v-if="!archived"
      class="task-filters"
      @submit.prevent="load()"
    >
      <label>Поиск<input
        v-model="q"
        maxlength="160"
        placeholder="Название или описание"
        :disabled="busy"
      ></label>
      <label>Статус<select
        v-model="statusFilter"
        :disabled="busy"
      ><option value="">Все статусы</option><option
        v-for="(label, value) in labels"
        :key="value"
        :value="value"
      >{{ label }}</option></select></label>
      <label>Ответственный<select
        v-model="assigneeFilter"
        :disabled="busy"
      ><option value="">Все участники</option><option value="me">Мои задачи</option><option value="unassigned">Без ответственного</option><option
        v-for="member in members"
        :key="member.userId"
        :value="member.userId"
      >{{ member.firstName }} {{ member.lastName }}</option></select></label>
      <button
        class="secondary"
        :disabled="busy"
      >
        {{ busy ? 'Загрузка…' : 'Применить / обновить' }}
      </button>
    </form>
    <p
      v-if="error"
      class="feedback error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-if="notice"
      class="feedback"
      role="status"
    >
      {{ notice }}
      <button
        v-if="undoTask"
        class="text-button"
        :disabled="busy || pending.size > 0"
        @click="setArchived(undoTask, false)"
      >
        Отменить
      </button>
    </p>
    <p
      v-if="busy"
      role="status"
      class="muted"
    >
      Загрузка…
    </p>
    <template v-if="archived">
      <button
        v-if="error"
        class="secondary"
        :disabled="busy"
        @click="load()"
      >
        Повторить
      </button>
      <p
        v-if="!busy && !error && !tasks.length"
        class="muted"
      >
        Архив пока пуст
      </p>
      <article
        v-for="task in tasks"
        :key="task.id"
        class="panel"
      >
        <h4>{{ task.title }}</h4>
        <p class="task-description">
          {{ task.description }}
        </p>
        <p>{{ members.find(member => member.userId === task.assigneeId)?.firstName ?? (task.assigneeId ? 'Участник' : 'Без ответственного') }}</p>
        <p class="muted">
          Завершена: {{ task.completedAt ? formattedDate(task.completedAt) : 'Не указана' }}
        </p>
        <p class="muted">
          В архиве: {{ task.archivedAt ? formattedDate(task.archivedAt) : '' }}
        </p>
        <button
          :disabled="busy || pending.size > 0"
          @click="setArchived(task, false)"
        >
          Восстановить
        </button>
      </article>
    </template>
    <div
      v-else
      class="kanban"
    >
      <section
        v-for="column in columns"
        :key="column"
        class="kanban-column"
        :aria-label="labels[column]"
      >
        <h4>{{ labels[column] }} · {{ tasks.filter(task => task.status === column).length }}</h4>
        <article
          v-for="task in tasks.filter(item => item.status === column)"
          :key="task.id"
          class="task-card-wrapper"
        >
          <button
            class="task-card"
            :disabled="busy || pending.size > 0"
            @click="open(task)"
          >
            <strong>{{ task.title }}</strong>
            <small
              class="project-badge"
              :class="{ 'project-missing': !task.project }"
            >{{ projectLabel(task.project) }}</small>
            <span v-if="task.description">{{ task.description.slice(0, 140) }}</span>
            <small>{{ members.find(member => member.userId === task.assigneeId)?.firstName ?? (task.assigneeId ? 'Участник' : 'Без ответственного') }}</small>
          </button>
          <button
            v-if="task.status === 'DONE'"
            class="secondary archive-action"
            :disabled="busy || pending.size > 0"
            :aria-label="`Архивировать: ${task.title}`"
            title="Архивировать"
            @click="setArchived(task, true)"
          >
            <ArchiveIcon />
          </button>
        </article>
        <p
          v-if="!tasks.some(task => task.status === column)"
          class="muted"
        >
          Задач пока нет
        </p>
      </section>
    </div>
    <button
      v-if="cursor"
      class="secondary"
      :disabled="busy"
      @click="load(true)"
    >
      Загрузить ещё
    </button>
    <dialog
      ref="sheet"
      class="sheet"
      aria-labelledby="task-editor-title"
      @cancel.prevent="!busy && sheet?.close()"
      @close="stopAgentPolling"
    >
      <form @submit.prevent="save()">
        <div class="section-header">
          <h2 id="task-editor-title">
            {{ editing ? 'Изменить задачу' : 'Новая задача' }}
          </h2><button
            type="button"
            class="text-button"
            :disabled="busy"
            aria-label="Закрыть"
            @click="sheet?.close()"
          >
            ✕
          </button>
        </div>
        <p
          v-if="error"
          role="alert"
          class="feedback error"
        >
          {{ error }}
        </p>
        <p
          v-if="notice"
          role="status"
          class="feedback"
        >
          {{ notice }}
        </p>
        <fieldset :disabled="busy">
          <label for="task-project">Проект</label><select
            id="task-project"
            v-model="project"
            required
            autofocus
          >
            <option
              value=""
              disabled
            >
              Выберите проект
            </option>
            <option
              v-for="option in projectOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
          <p class="muted">
            От проекта зависит, в каком репозитории агент создаст ветку и pull request.
          </p>
          <label for="task-title">Название</label><input
            id="task-title"
            v-model="title"
            maxlength="160"
            required
          >
          <label for="task-description">Описание</label><textarea
            id="task-description"
            v-model="description"
            maxlength="5000"
            rows="4"
          />
          <label for="task-status">Статус</label><select
            id="task-status"
            v-model="status"
          >
            <option
              v-for="(label, value) in labels"
              :key="value"
              :value="value"
            >
              {{ label }}
            </option>
          </select>
          <label for="task-assignee">Ответственный</label><select
            id="task-assignee"
            v-model="assigneeId"
          >
            <option value="">
              Без ответственного
            </option><option
              v-if="assigneeId && !members.some(member => member.userId === assigneeId)"
              :value="assigneeId"
            >
              Участник покинул команду — выберите другого
            </option><option
              v-for="member in members"
              :key="member.userId"
              :value="member.userId"
            >
              {{ member.firstName }} {{ member.lastName }}
            </option>
          </select>
          <button
            type="button"
            class="text-button"
            @click="refreshMembers"
          >
            Обновить участников
          </button>
        </fieldset>
        <div
          v-if="conflicted"
          class="feedback"
        >
          <p>Ваши поля сохранены. Загрузите актуальные данные для сравнения.</p>
          <button
            type="button"
            :disabled="busy"
            @click="fetchLatest"
          >
            Загрузить актуальную версию
          </button>
          <template v-if="latest">
            <h4>{{ latest.title }}</h4><p class="task-description">
              {{ latest.description }}
            </p><p>{{ labels[latest.status] }} · {{ projectLabel(latest.project) }} · {{ members.find(member => member.userId === latest?.assigneeId)?.firstName ?? 'Без ответственного' }}</p>
            <div class="dialog-actions">
              <button
                type="button"
                :disabled="busy"
                @click="acceptLatest(true)"
              >
                Сохранить мой ввод для повторной отправки
              </button><button
                type="button"
                class="secondary"
                :disabled="busy"
                @click="acceptLatest(false)"
              >
                Принять актуальные поля
              </button>
            </div>
          </template>
        </div>
        <button
          class="full-width"
          :disabled="busy || conflicted || !title.trim() || !project"
        >
          {{ busy ? 'Сохраняем…' : 'Сохранить' }}
        </button>
        <template v-if="editing">
          <section
            class="agent-panel"
            aria-labelledby="task-agent-title"
          >
            <div class="section-header">
              <h3 id="task-agent-title">
                Агент
              </h3>
              <span
                v-if="latestAgentRun"
                class="agent-status"
                :class="latestAgentRun.status.toLowerCase()"
              >{{ agentStatusLabels[latestAgentRun.status] }}</span>
            </div>
            <p class="muted">
              Агент оценит задачу, составит план, внесёт изменения в ветке проекта «{{ projectLabel(editing.project) }}» и откроет pull request. Автоматического слияния и деплоя нет.
            </p>
            <p
              v-if="agentError"
              class="feedback error"
              role="alert"
            >
              {{ agentError }}
            </p>
            <p
              v-if="agentNotice"
              class="feedback"
              role="status"
            >
              {{ agentNotice }}
            </p>
            <p
              v-if="editing.archivedAt"
              class="muted"
            >
              Задача находится в архиве. Восстановите её, чтобы продолжить диалог с агентом.
            </p>
            <p
              v-else-if="!editing.project"
              class="muted"
            >
              Укажите проект задачи и сохраните изменения, чтобы отправить её агенту.
            </p>
            <p
              v-else-if="hasChanges"
              class="muted"
            >
              Сначала сохраните изменения задачи, чтобы отправить её агенту.
            </p>
            <p
              v-else-if="latestAgentRun?.status === 'NEEDS_INPUT'"
              class="muted"
            >
              Агент ждёт ответа. Напишите его в диалоге ниже.
            </p>
            <section
              class="agent-chat"
              aria-labelledby="agent-chat-title"
            >
              <h4 id="agent-chat-title">
                Диалог
              </h4>
              <div
                v-if="agentMessages.length"
                class="agent-chat-messages"
                role="log"
                aria-live="polite"
              >
                <article
                  v-for="message in agentMessages"
                  :key="message.id"
                  class="agent-message"
                  :class="message.role.toLowerCase()"
                >
                  <div class="agent-message-meta">
                    <strong>{{ message.role === 'USER' ? 'Вы' : 'Агент' }}</strong>
                    <small class="muted">{{ formattedDate(message.createdAt) }}</small>
                  </div>
                  <p>{{ message.body }}</p>
                </article>
              </div>
              <p
                v-else
                class="muted"
              >
                Напишите агенту уточнение или ответ на его вопрос.
              </p>
              <label
                for="agent-chat-input"
                class="muted"
              >Сообщение агенту</label>
              <textarea
                id="agent-chat-input"
                v-model="agentMessageText"
                rows="3"
                maxlength="4000"
                :disabled="agentChatDisabled"
                :placeholder="latestAgentRun?.status === 'NEEDS_INPUT' ? 'Ответьте на вопрос агента…' : 'Уточните задачу или попросите внести изменения…'"
              />
              <button
                type="button"
                class="full-width"
                :disabled="agentChatDisabled || !agentMessageText.trim()"
                @click="sendAgentMessage"
              >
                {{ agentChatBusy ? 'Отправляем…' : agentActive ? 'Агент работает…' : latestAgentRun?.status === 'NEEDS_INPUT' ? 'Ответить агенту' : 'Отправить сообщение' }}
              </button>
            </section>
            <button
              type="button"
              class="secondary full-width agent-send"
              :disabled="agentBusy || busy || agentActive || conflicted || hasChanges || !editing.project || !!editing.archivedAt"
              @click="sendToAgent"
            >
              {{ agentBusy ? 'Отправляем…' : agentActive ? (latestAgentRun?.status === 'REVIEW' ? 'Pull request на проверке' : 'Агент работает…') : latestAgentRun ? 'Отправить агенту снова' : 'Отправить агенту' }}
            </button>
            <template v-if="latestAgentRun">
              <div class="agent-run-head">
                <strong>{{ latestAgentRun.taskTitle }}</strong>
                <small class="muted">{{ formattedDate(latestAgentRun.createdAt) }}</small>
              </div>
              <p
                v-if="latestAgentRun.summary"
                class="agent-summary"
              >
                {{ latestAgentRun.summary }}
              </p>
              <p
                v-if="latestAgentRun.error"
                class="feedback error"
              >
                {{ latestAgentRun.error }}
              </p>
              <p v-if="latestAgentRun.branch">
                Ветка: <code>{{ latestAgentRun.branch }}</code>
              </p>
              <p v-if="latestAgentRun.pullRequestUrl">
                <a
                  :href="latestAgentRun.pullRequestUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                >Открыть pull request</a>
              </p>
              <ol class="agent-timeline">
                <li
                  v-for="event in latestAgentRun.events"
                  :key="event.id"
                >
                  <span class="agent-event-stage">{{ event.stage ? agentStatusLabels[event.stage] : 'Сообщение' }}</span>
                  <span class="agent-event-message">{{ event.message }}</span>
                  <small class="muted">{{ formattedDate(event.createdAt) }}</small>
                </li>
              </ol>
              <div
                v-if="agentActive"
                class="dialog-actions"
              >
                <button
                  type="button"
                  class="text-button danger-text"
                  :disabled="agentBusy"
                  @click="cancelAgentRun(latestAgentRun)"
                >
                  {{ cancelingRunId === latestAgentRun.id ? 'Подтвердить отмену' : 'Отменить запуск' }}
                </button>
              </div>
              <details
                v-if="agentRuns.length > 1"
                class="agent-history"
              >
                <summary>История запусков</summary>
                <ul>
                  <li
                    v-for="run in agentRuns.slice(1)"
                    :key="run.id"
                  >
                    <span>{{ agentStatusLabels[run.status] }}</span>
                    <span class="muted">{{ formattedDate(run.createdAt) }}</span>
                    <a
                      v-if="run.pullRequestUrl"
                      :href="run.pullRequestUrl"
                      target="_blank"
                      rel="noopener noreferrer"
                    >PR</a>
                  </li>
                </ul>
              </details>
            </template>
            <p
              v-else
              class="muted"
            >
              Агент ещё не запускался.
            </p>
          </section>
          <button
            v-if="!deleting"
            type="button"
            class="text-button danger-text"
            :disabled="busy || conflicted"
            @click="deleting = true"
          >
            Удалить задачу
          </button>
          <div
            v-else
            class="feedback"
          >
            <p>Удалить задачу без возможности восстановления?</p><div class="dialog-actions">
              <button
                type="button"
                class="danger-button"
                :disabled="busy || conflicted"
                @click="save(true)"
              >
                Удалить
              </button><button
                type="button"
                class="secondary"
                :disabled="busy"
                @click="deleting = false"
              >
                Отмена
              </button>
            </div>
          </div>
        </template>
      </form>
    </dialog>
  </section>
</template>

