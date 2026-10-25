<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { TaskItem, TaskStatus, TeamDetail } from '@task-tg/shared';
import { api, ApiError } from '../api';
const props = defineProps<{ team: TeamDetail }>();
const emit = defineEmits<{ 'session-expired': []; 'access-lost': [] }>();
const tasks = ref<TaskItem[]>([]);
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
const assigneeId = ref('');
const deleting = ref(false);
const labels: Record<TaskStatus, string> = { TODO: 'К выполнению', IN_PROGRESS: 'В работе', DONE: 'Готово' };
const columns = computed(() => (Object.keys(labels) as TaskStatus[]).filter(value => !statusFilter.value || value === statusFilter.value));
const base = `/teams/${props.team.id}/tasks`;
function fail(cause: unknown) {
  if (cause instanceof ApiError && cause.status === 401) { emit('session-expired'); return; }
  if (cause instanceof ApiError && cause.code === 'TEAM_NOT_FOUND') emit('access-lost');
  const messages: Record<string, string> = {
    ASSIGNEE_NOT_MEMBER: 'Ответственный больше не состоит в команде. Обновите участников и выберите другого.',
    TASK_NOT_FOUND: 'Задача удалена. Ваш текст остаётся в форме; скопируйте его перед закрытием.',
    TEAM_NOT_FOUND: 'Доступ к команде закрыт.', INVALID_REQUEST: 'Проверьте поля формы.',
    INVALID_CURSOR: 'Список изменился. Нажмите «Применить / обновить», чтобы загрузить его заново.',
    TOO_MANY_REQUESTS: 'Слишком много запросов. Подождите минуту.',
    VERSION_CONFLICT: 'Задача изменилась. Ваш ввод сохранён. Сначала загрузите актуальную версию.',
  };
  error.value = cause instanceof ApiError ? messages[cause.code] ?? 'Ошибка сервера. Повторите действие.' : 'Нет соединения с сервером. Ваш ввод сохранён. Повторите действие.';
}
async function load(more = false) {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try {
    const query = new URLSearchParams();
    if (q.value.trim()) query.set('q', q.value.trim());
    if (statusFilter.value) query.set('status', statusFilter.value);
    if (assigneeFilter.value) query.set('assignee', assigneeFilter.value);
    if (more && cursor.value) query.set('cursor', cursor.value);
    const result = await api<{ tasks: TaskItem[]; nextCursor: string | null }>(`${base}?${query}`);
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
  editing.value = task; latest.value = null; conflicted.value = false; deleting.value = false;
  title.value = task?.title ?? ''; description.value = task?.description ?? '';
  status.value = task?.status ?? 'TODO'; assigneeId.value = task?.assigneeId ?? '';
  error.value = ''; notice.value = ''; sheet.value?.showModal();
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
    status.value = latest.value.status; assigneeId.value = latest.value.assigneeId ?? '';
  }
  latest.value = null; conflicted.value = false; deleting.value = false;
  notice.value = keepDraft ? 'Ваш ввод сохранён. Проверьте его перед повторным сохранением.' : 'Загружены актуальные поля.';
}
async function save(remove = false) {
  if (busy.value || conflicted.value || (!remove && !title.value.trim())) return;
  busy.value = true; error.value = '';
  try {
    const task = editing.value;
    const path = task ? `${base}/${task.id}` : base;
    await api(path, remove ? { version: task?.version } : { title: title.value.trim(), description: description.value.trim(), status: status.value, assigneeId: assigneeId.value || null, ...(task ? { version: task.version } : {}) }, remove ? 'DELETE' : task ? 'PATCH' : 'POST');
    sheet.value?.close(); notice.value = remove ? 'Задача удалена.' : 'Задача сохранена.';
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === 'VERSION_CONFLICT') { conflicted.value = true; latest.value = null; }
    fail(cause); return;
  } finally { busy.value = false; }
  await load();
}
onMounted(() => load());
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
        Задачи
      </h3>
      <button
        :disabled="busy"
        @click="open(null)"
      >
        + Задача
      </button>
    </div>
    <form
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
    </p>
    <div class="kanban">
      <section
        v-for="column in columns"
        :key="column"
        class="kanban-column"
        :aria-label="labels[column]"
      >
        <h4>{{ labels[column] }} · {{ tasks.filter(task => task.status === column).length }}</h4>
        <button
          v-for="task in tasks.filter(item => item.status === column)"
          :key="task.id"
          class="task-card"
          :disabled="busy"
          @click="open(task)"
        >
          <strong>{{ task.title }}</strong><span v-if="task.description">{{ task.description.slice(0, 140) }}</span>
          <small>{{ members.find(member => member.userId === task.assigneeId)?.firstName ?? (task.assigneeId ? 'Участник' : 'Без ответственного') }}</small>
        </button>
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
          <label for="task-title">Название</label><input
            id="task-title"
            v-model="title"
            maxlength="160"
            required
            autofocus
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
            </p><p>{{ labels[latest.status] }} · {{ members.find(member => member.userId === latest?.assigneeId)?.firstName ?? 'Без ответственного' }}</p>
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
          :disabled="busy || conflicted || !title.trim()"
        >
          {{ busy ? 'Сохраняем…' : 'Сохранить' }}
        </button>
        <template v-if="editing">
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

