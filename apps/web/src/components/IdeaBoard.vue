<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { IdeaItem, TaskItem } from '@task-tg/shared';
import { api, ApiError } from '../api';
const props = defineProps<{ teamId: string }>();
const emit = defineEmits<{ 'session-expired': []; 'access-lost': []; converted: [] }>();
const ideas = ref<IdeaItem[]>([]);
const q = ref('');
const cursor = ref<string | null>(null);
watch(q, () => { cursor.value = null; });
const busy = ref(false);
const error = ref('');
const notice = ref('');
const sheet = ref<HTMLDialogElement | null>(null);
const editing = ref<IdeaItem | null>(null);
const latest = ref<IdeaItem | null>(null);
const linkedTask = ref<TaskItem | null>(null);
const conflicted = ref(false);
const title = ref('');
const description = ref('');
const confirmation = ref<'delete' | 'convert' | null>(null);
const dirty = computed(() => title.value.trim() !== editing.value?.title || description.value.trim() !== editing.value?.description);
const base = `/teams/${props.teamId}/ideas`;
const statusLabels = { TODO: 'К выполнению', IN_PROGRESS: 'В работе', DONE: 'Готово' };
function fail(cause: unknown) {
  if (cause instanceof ApiError && cause.status === 401) { emit('session-expired'); return; }
  if (cause instanceof ApiError && cause.code === 'TEAM_NOT_FOUND') emit('access-lost');
  const messages: Record<string, string> = {
    IDEA_NOT_FOUND: 'Идея удалена. Ваш текст остаётся в форме; скопируйте его перед закрытием.',
    TASK_NOT_FOUND: 'Связанная задача удалена. Обновите идею.',
    TEAM_NOT_FOUND: 'Доступ к команде закрыт.', INVALID_REQUEST: 'Проверьте поля формы.',
    INVALID_CURSOR: 'Список изменился. Нажмите «Найти / обновить», чтобы загрузить его заново.',
    VERSION_CONFLICT: 'Идея изменилась. Ваш ввод сохранён. Загрузите актуальную версию для сравнения.',
    IDEA_CONVERTED: 'Идея уже преобразована в задачу. Ваш ввод сохранён. Загрузите актуальную версию.',
    CONVERTED_TASK_DELETED: 'Созданная из идеи задача удалена. Повторное преобразование не создаёт новую задачу.',
    TOO_MANY_REQUESTS: 'Слишком много запросов. Подождите минуту.',
  };
  error.value = cause instanceof ApiError ? messages[cause.code] ?? 'Ошибка сервера. Повторите действие.' : 'Нет соединения с сервером. Ваш ввод сохранён. Повторите действие.';
  if (cause instanceof ApiError && ['VERSION_CONFLICT', 'IDEA_CONVERTED'].includes(cause.code)) {
    conflicted.value = true; latest.value = null; confirmation.value = null;
  }
}
async function load(more = false) {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try {
    const query = new URLSearchParams();
    if (q.value.trim()) query.set('q', q.value.trim());
    if (more && cursor.value) query.set('cursor', cursor.value);
    const result = await api<{ ideas: IdeaItem[]; nextCursor: string | null }>(`${base}?${query}`);
    ideas.value = more ? [...ideas.value, ...result.ideas.filter(idea => !ideas.value.some(old => old.id === idea.id))] : result.ideas;
    cursor.value = result.nextCursor;
  } catch (cause) { fail(cause); }
  finally { busy.value = false; }
}
function open(idea: IdeaItem | null) {
  editing.value = idea; latest.value = null; linkedTask.value = null;
  conflicted.value = false; confirmation.value = null;
  title.value = idea?.title ?? ''; description.value = idea?.description ?? '';
  error.value = ''; notice.value = ''; sheet.value?.showModal();
}
async function fetchLatest() {
  if (!editing.value || busy.value) return;
  busy.value = true;
  try { latest.value = (await api<{ idea: IdeaItem }>(`${base}/${editing.value.id}`)).idea; error.value = ''; }
  catch (cause) { fail(cause); }
  finally { busy.value = false; }
}
function acceptLatest(keepDraft: boolean) {
  if (!latest.value) return;
  editing.value = latest.value;
  if (!keepDraft) { title.value = latest.value.title; description.value = latest.value.description; }
  latest.value = null; linkedTask.value = null; conflicted.value = false; confirmation.value = null;
  notice.value = keepDraft
    ? editing.value.convertedAt ? 'Идея уже преобразована. Ваш текст сохранён в полях для копирования.' : 'Ваш ввод сохранён. Проверьте его перед повторным сохранением.'
    : 'Загружены актуальные поля.';
}
async function showTask() {
  if (!editing.value?.taskId || busy.value) return;
  busy.value = true; error.value = '';
  try { linkedTask.value = (await api<{ task: TaskItem }>(`/teams/${props.teamId}/tasks/${editing.value.taskId}`)).task; }
  catch (cause) { fail(cause); }
  finally { busy.value = false; }
}
async function run(action: 'save' | 'delete' | 'convert') {
  const idea = editing.value;
  if (busy.value || conflicted.value || (action !== 'save' && !idea)) return;
  if (action === 'save' && (!title.value.trim() || idea?.convertedAt)) return;
  if (action === 'convert' && dirty.value) return;
  busy.value = true; error.value = '';
  try {
    if (action === 'convert' && idea) {
      const result = await api<{ idea: IdeaItem; task: TaskItem }>(`${base}/${idea.id}/convert`, { version: idea.version });
      editing.value = result.idea; title.value = result.idea.title; description.value = result.idea.description;
      linkedTask.value = result.task; confirmation.value = null;
      ideas.value = ideas.value.map(item => item.id === result.idea.id ? result.idea : item);
      notice.value = 'Идея преобразована. Задача доступна на доске.'; emit('converted');
    } else {
      await api(idea ? `${base}/${idea.id}` : base, action === 'delete' ? { version: idea?.version } : { title: title.value.trim(), description: description.value.trim(), ...(idea ? { version: idea.version } : {}) }, action === 'delete' ? 'DELETE' : idea ? 'PATCH' : 'POST');
      sheet.value?.close(); notice.value = action === 'delete' ? 'Идея удалена. Связанная задача сохранена, если она существовала.' : 'Идея сохранена.';
    }
  } catch (cause) { fail(cause); return; }
  finally { busy.value = false; }
  if (action !== 'convert') await load();
}
onMounted(() => load());
</script>

<template>
  <section
    class="panel ideas-panel"
    aria-labelledby="ideas-title"
  >
    <div class="section-header">
      <h3 id="ideas-title">
        Идеи
      </h3><button
        :disabled="busy"
        @click="open(null)"
      >
        + Идея
      </button>
    </div>
    <p class="muted">
      Сохраняйте предложения и превращайте готовые идеи в задачи команды.
    </p>
    <form @submit.prevent="load()">
      <label for="idea-search">Поиск идей</label><input
        id="idea-search"
        v-model="q"
        maxlength="160"
        placeholder="Название или описание"
        :disabled="busy"
      >
      <button
        class="secondary"
        :disabled="busy"
      >
        {{ busy ? 'Загрузка…' : 'Найти / обновить' }}
      </button>
    </form>
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
    <p
      v-if="!ideas.length && !busy"
      class="muted"
    >
      Идей пока нет или по запросу ничего не найдено.
    </p>
    <div class="idea-list">
      <button
        v-for="idea in ideas"
        :key="idea.id"
        class="task-card"
        :disabled="busy"
        @click="open(idea)"
      >
        <strong>{{ idea.title }}</strong><span v-if="idea.description">{{ idea.description.slice(0, 180) }}</span>
        <small>{{ idea.convertedAt ? idea.taskId ? 'Преобразована в задачу' : 'Преобразована · задача удалена' : 'Идея' }}</small>
      </button>
    </div>
    <button
      v-if="cursor"
      class="secondary"
      :disabled="busy"
      @click="load(true)"
    >
      Ещё идеи
    </button>
    <dialog
      ref="sheet"
      class="sheet"
      aria-labelledby="idea-editor-title"
      @cancel.prevent="!busy && sheet?.close()"
    >
      <form @submit.prevent="run('save')">
        <div class="section-header">
          <h2 id="idea-editor-title">
            {{ editing?.convertedAt ? 'Преобразованная идея' : editing ? 'Изменить идею' : 'Новая идея' }}
          </h2><button
            type="button"
            class="text-button"
            :disabled="busy"
            aria-label="Закрыть идею"
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
          <label for="idea-title">Название идеи</label><input
            id="idea-title"
            v-model="title"
            maxlength="160"
            required
            autofocus
            :readonly="!!editing?.convertedAt"
          >
          <label for="idea-description">Описание идеи</label><textarea
            id="idea-description"
            v-model="description"
            maxlength="5000"
            rows="4"
            :readonly="!!editing?.convertedAt"
          />
        </fieldset>
        <div
          v-if="editing?.convertedAt"
          class="feedback"
        >
          <p>Идея преобразована и больше не редактируется. {{ editing.taskId ? 'Дальнейшие изменения вносите в задачу.' : 'Связанная задача удалена; новая при повторе не создаётся.' }} {{ dirty ? 'Ваш несохранённый текст остаётся в полях: скопируйте его перед закрытием.' : '' }}</p>
          <button
            v-if="editing.taskId"
            type="button"
            class="secondary"
            :disabled="busy"
            @click="showTask"
          >
            Показать задачу
          </button>
        </div>
        <div
          v-if="linkedTask"
          class="feedback"
        >
          <h3>{{ linkedTask.title }}</h3><p class="task-description">
            {{ linkedTask.description }}
          </p><p>{{ statusLabels[linkedTask.status] }}</p>
        </div>
        <div
          v-if="conflicted"
          class="feedback"
        >
          <p>Ваши поля сохранены. Загрузите актуальные данные для сравнения.</p><button
            type="button"
            :disabled="busy"
            @click="fetchLatest"
          >
            Загрузить актуальную идею
          </button>
          <template v-if="latest">
            <h4>{{ latest.title }}</h4><p class="task-description">
              {{ latest.description }}
            </p><p>{{ latest.convertedAt ? 'Уже преобразована в задачу' : 'Ещё не преобразована' }}</p><div class="dialog-actions">
              <button
                type="button"
                :disabled="busy"
                @click="acceptLatest(true)"
              >
                Оставить мой ввод
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
          v-if="!editing?.convertedAt"
          class="full-width"
          :disabled="busy || conflicted || !title.trim()"
        >
          {{ busy ? 'Сохраняем…' : 'Сохранить идею' }}
        </button>
        <template v-if="editing">
          <p
            v-if="!editing.convertedAt && dirty"
            class="muted"
          >
            Перед преобразованием сохраните изменения.
          </p>
          <div
            v-if="!confirmation"
            class="dialog-actions"
          >
            <button
              v-if="!editing.convertedAt"
              type="button"
              class="secondary"
              :disabled="busy || conflicted || dirty"
              @click="confirmation = 'convert'"
            >
              Преобразовать в задачу
            </button><button
              type="button"
              class="text-button danger-text"
              :disabled="busy || conflicted"
              @click="confirmation = 'delete'"
            >
              Удалить идею
            </button><button
              type="button"
              class="text-button"
              :disabled="busy"
              @click="conflicted = true; fetchLatest()"
            >
              Обновить идею
            </button>
          </div>
          <div
            v-else
            class="feedback"
          >
            <p>{{ confirmation === 'convert' ? 'Создать задачу из сохранённых названия и описания? Идея останется в списке и станет доступна только для чтения.' : 'Удалить идею без возможности восстановления? Связанная задача останется.' }}</p><div class="dialog-actions">
              <button
                type="button"
                :disabled="busy || conflicted || (confirmation === 'convert' && dirty)"
                @click="run(confirmation)"
              >
                {{ confirmation === 'convert' ? 'Создать задачу' : 'Удалить' }}
              </button><button
                type="button"
                class="secondary"
                :disabled="busy"
                @click="confirmation = null"
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
