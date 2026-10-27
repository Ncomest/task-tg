<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import type { CreatedTeamInvite, TeamDetail, TeamInviteSummary, TeamMember, TeamRole, TeamSummary } from '@task-tg/shared';
import { api, ApiError } from '../api';
import { launchInviteCode } from '../telegram';
import TaskBoard from './TaskBoard.vue';
import IdeaBoard from './IdeaBoard.vue';

const props = defineProps<{ currentUserId: string }>();
const emit = defineEmits<{ 'session-expired': [] }>();
const teams = ref<TeamSummary[]>([]);
const selected = ref<TeamDetail | null>(null);
const archiveView = ref(false);
watch(() => selected.value?.id, () => { archiveView.value = false; });
const taskBoard = ref<InstanceType<typeof TaskBoard> | null>(null);
const invites = ref<TeamInviteSummary[]>([]);
const freshInvite = ref<CreatedTeamInvite | null>(null);
const busy = ref(false);
const loading = ref(true);
const error = ref('');
const notice = ref('');
const joinCode = ref(launchInviteCode());
const editor = ref<HTMLDialogElement | null>(null);
const confirmDialog = ref<HTMLDialogElement | null>(null);
const editing = ref(false);
const name = ref('');
const description = ref('');
const confirmName = ref('');
const confirmation = ref<{ title: string; text: string; button: string; requiredName?: string; run: () => Promise<void> } | null>(null);
const roleLabels: Record<TeamRole, string> = { OWNER: 'Владелец', ADMIN: 'Администратор', MEMBER: 'Участник' };
const inviteLabels: Record<TeamInviteSummary['status'], string> = { ACTIVE: 'Действует', USED: 'Использовано', REVOKED: 'Отозвано', EXPIRED: 'Истекло' };
const errors: Record<string, string> = {
  TEAM_NOT_FOUND: 'Команда не найдена или доступ к ней закрыт.',
  FORBIDDEN: 'У вас нет прав на это действие.',
  INVITE_UNAVAILABLE: 'Приглашение недействительно, использовано или отозвано.',
  ALREADY_MEMBER: 'Вы уже состоите в этой команде.',
  OWNER_CANNOT_LEAVE: 'Владелец не может выйти из команды. Доступно удаление команды.',
  TOO_MANY_ACTIVE_INVITES: 'У команды уже 20 активных приглашений. Отзовите ненужные.',
  INVALID_REQUEST: 'Проверьте введённые данные.',
  MEMBER_NOT_FOUND: 'Участник уже покинул команду.',
  TOO_MANY_REQUESTS: 'Слишком много запросов. Подождите минуту.',
};

function showError(cause: unknown) {
  if (cause instanceof ApiError && cause.status === 401) { emit('session-expired'); return; }
  if (cause instanceof ApiError && cause.code === 'TEAM_NOT_FOUND') {
    selected.value = null;
    freshInvite.value = null;
    invites.value = [];
    void refreshTeams().catch(() => {});
  }
  error.value = cause instanceof ApiError ? errors[cause.code] ?? 'Не удалось выполнить действие. Обновите данные и попробуйте снова.' : 'Нет соединения с сервером. Попробуйте снова.';
}

async function refreshTeams() { teams.value = (await api<{ teams: TeamSummary[] }>('/teams')).teams; }

async function loadTeams() {
  loading.value = true;
  error.value = '';
  try { await refreshTeams(); } catch (cause) { showError(cause); }
  finally { loading.value = false; }
}

async function loadDetail(teamId: string) {
  const team = (await api<{ team: TeamDetail }>(`/teams/${teamId}`)).team;
  selected.value = team;
  invites.value = team.role === 'MEMBER' ? [] : (await api<{ invites: TeamInviteSummary[] }>(`/teams/${teamId}/invites`)).invites;
}

async function selectTeam(teamId: string) {
  busy.value = true;
  error.value = '';
  notice.value = '';
  freshInvite.value = null;
  try { await loadDetail(teamId); } catch (cause) { showError(cause); }
  finally { busy.value = false; }
}

function openEditor(isEditing: boolean) {
  editing.value = isEditing;
  name.value = isEditing ? selected.value?.name ?? '' : '';
  description.value = isEditing ? selected.value?.description ?? '' : '';
  error.value = '';
  editor.value?.showModal();
}

async function saveTeam() {
  if (!name.value.trim() || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const path = editing.value ? `/teams/${selected.value?.id}` : '/teams';
    const result = await api<{ team: TeamSummary }>(path, { name: name.value.trim(), description: description.value.trim() }, editing.value ? 'PATCH' : 'POST');
    editor.value?.close();
    await refreshTeams();
    await loadDetail(result.team.id);
    freshInvite.value = null;
    notice.value = editing.value ? 'Изменения сохранены.' : 'Команда создана. Пригласите первого участника.';
  } catch (cause) { showError(cause); }
  finally { busy.value = false; }
}

async function joinTeam() {
  const token = joinCode.value.trim();
  if (!/^[\w-]{43}$/.test(token)) { error.value = 'Вставьте полный код приглашения из 43 символов.'; return; }
  busy.value = true;
  error.value = '';
  try {
    const result = await api<{ team: TeamDetail }>('/teams/join', { token });
    selected.value = result.team;
    invites.value = [];
    freshInvite.value = null;
    joinCode.value = '';
    notice.value = 'Вы вступили в команду.';
    await refreshTeams();
  } catch (cause) { showError(cause); }
  finally { busy.value = false; }
}

async function createInvite() {
  if (!selected.value) return;
  busy.value = true;
  error.value = '';
  try {
    freshInvite.value = (await api<{ invite: CreatedTeamInvite }>(`/teams/${selected.value.id}/invites`, {})).invite;
    invites.value = (await api<{ invites: TeamInviteSummary[] }>(`/teams/${selected.value.id}/invites`)).invites;
    notice.value = '';
  } catch (cause) { showError(cause); }
  finally { busy.value = false; }
}

async function copyInvite() {
  if (!freshInvite.value) return;
  try { await navigator.clipboard.writeText(freshInvite.value.token); notice.value = 'Код скопирован. Отправьте его будущему участнику.'; }
  catch { notice.value = 'Выделите код и скопируйте его вручную.'; }
}

async function copyInviteLink() {
  if (!freshInvite.value) return;
  try {
    await navigator.clipboard.writeText(`https://t.me/task_finc_bot?startapp=join_${freshInvite.value.token}`);
    notice.value = 'Ссылка скопирована. По ней можно вступить в команду один раз.';
  } catch { notice.value = 'Не удалось скопировать ссылку. Скопируйте код вручную.'; }
}

async function revokeInvite(inviteId: string) {
  if (!selected.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api(`/teams/${selected.value.id}/invites/${inviteId}`, undefined, 'DELETE');
    if (freshInvite.value?.id === inviteId) freshInvite.value = null;
    invites.value = (await api<{ invites: TeamInviteSummary[] }>(`/teams/${selected.value.id}/invites`)).invites;
    notice.value = 'Приглашение отозвано.';
  } catch (cause) { showError(cause); }
  finally { busy.value = false; }
}

async function changeRole(member: TeamMember) {
  if (!selected.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api(`/teams/${selected.value.id}/members/${member.userId}`, { role: member.role === 'ADMIN' ? 'MEMBER' : 'ADMIN' }, 'PATCH');
    await loadDetail(selected.value.id);
    notice.value = 'Роль обновлена.';
  } catch (cause) { showError(cause); }
  finally { busy.value = false; }
}

function askConfirmation(kind: 'leave' | 'delete' | 'remove', member?: TeamMember) {
  const team = selected.value;
  if (!team) return;
  confirmName.value = '';
  error.value = '';
  if (kind === 'remove' && member) {
    confirmation.value = { title: 'Удалить участника?', text: `${member.firstName} потеряет доступ к команде. Для возвращения понадобится новое приглашение.`, button: 'Удалить участника', run: async () => {
      await api(`/teams/${team.id}/members/${member.userId}`, undefined, 'DELETE');
      await loadDetail(team.id);
      await refreshTeams();
    } };
  } else {
    const deleting = kind === 'delete';
    confirmation.value = { title: deleting ? 'Удалить команду?' : 'Выйти из команды?', text: deleting ? 'Команда и её данные будут удалены для всех участников. Введите название команды для подтверждения.' : 'Вы потеряете доступ к команде. Для возвращения понадобится новое приглашение.', button: deleting ? 'Удалить команду' : 'Выйти из команды', ...(deleting ? { requiredName: team.name } : {}), run: async () => {
      await api(`/teams/${team.id}${deleting ? '' : '/leave'}`, deleting ? undefined : {}, deleting ? 'DELETE' : 'POST');
      selected.value = null;
      freshInvite.value = null;
      await refreshTeams();
    } };
  }
  confirmDialog.value?.showModal();
}

async function confirmAction() {
  const action = confirmation.value;
  if (!action || busy.value || (action.requiredName && confirmName.value !== action.requiredName)) return;
  busy.value = true;
  error.value = '';
  try { await action.run(); confirmDialog.value?.close(); notice.value = 'Готово.'; }
  catch (cause) { showError(cause); }
  finally { busy.value = false; }
}

function canRemove(member: TeamMember) {
  return member.userId !== props.currentUserId && member.role !== 'OWNER' && (selected.value?.role === 'OWNER' || (selected.value?.role === 'ADMIN' && member.role === 'MEMBER'));
}

function formattedDate(value: string) {
  return new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

onMounted(loadTeams);
</script>

<template>
  <div class="workspace">
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
    <template v-if="!selected">
      <div class="section-header">
        <h2>Мои команды</h2>
        <button
          :disabled="busy || loading"
          @click="openEditor(false)"
        >
          + Создать
        </button>
      </div>
      <p
        v-if="loading"
        role="status"
      >
        Загружаем команды…
      </p>
      <div
        v-else-if="!teams.length"
        class="empty-state"
      >
        <span
          class="empty-icon"
          aria-hidden="true"
        >◎</span>
        <h3>Вместе — проще</h3>
        <p>Создайте команду или вступите по приглашению коллеги.</p>
        <button
          v-if="error"
          class="secondary"
          @click="loadTeams"
        >
          Обновить
        </button>
      </div>
      <div
        v-else
        class="team-grid"
      >
        <button
          v-for="team in teams"
          :key="team.id"
          class="team-tile"
          :disabled="busy"
          @click="selectTeam(team.id)"
        >
          <span
            class="team-avatar"
            aria-hidden="true"
          >{{ team.name.slice(0, 1) }}</span>
          <span class="team-tile-copy"><strong>{{ team.name }}</strong><span>{{ team.memberCount }} чел. · {{ roleLabels[team.role] }}</span></span>
          <span aria-hidden="true">›</span>
        </button>
      </div>
      <section
        class="panel join-panel"
        aria-labelledby="join-title"
      >
        <h3 id="join-title">
          Есть приглашение?
        </h3>
        <p class="muted">
          {{ launchInviteCode() ? 'Код из Telegram-ссылки уже заполнен. Подтвердите вступление.' : 'Попросите приглашение у владельца или администратора команды.' }}
        </p>
        <form @submit.prevent="joinTeam">
          <label for="join-code">Код приглашения</label>
          <input
            id="join-code"
            v-model="joinCode"
            name="invite-code"
            autocomplete="off"
            spellcheck="false"
            maxlength="128"
            placeholder="Вставьте код"
            required
            :disabled="busy"
          >
          <button :disabled="busy || !joinCode.trim()">
            Вступить в команду
          </button>
        </form>
      </section>
    </template>
    <template v-else>
      <button
        class="back-button"
        :disabled="busy"
        @click="selected = null; freshInvite = null; error = ''; notice = ''"
      >
        ← Все команды
      </button>
      <div class="section-header team-heading">
        <div><span class="role-badge">{{ roleLabels[selected.role] }}</span><h2>{{ selected.name }}</h2></div>
        <button
          v-if="selected.role !== 'MEMBER'"
          class="secondary"
          :disabled="busy"
          @click="openEditor(true)"
        >
          Изменить
        </button>
      </div>
      <p
        v-if="selected.description"
        class="team-description"
      >
        {{ selected.description }}
      </p>
      <TaskBoard
        ref="taskBoard"
        :key="selected.id"
        :team="selected"
        :current-user-id="currentUserId"
        @archive-view="archiveView = $event"
        @session-expired="emit('session-expired')"
        @access-lost="selected = null; loadTeams()"
      />
      <IdeaBoard
        v-if="!archiveView"
        :key="selected.id"
        :team-id="selected.id"
        @session-expired="emit('session-expired')"
        @access-lost="selected = null; loadTeams()"
        @converted="taskBoard?.refresh()"
      />
      <section
        v-if="!archiveView"
        class="panel"
        aria-labelledby="members-title"
      >
        <div class="section-header">
          <h3 id="members-title">
            Участники
          </h3><span class="count-badge">{{ selected.members.length }}</span>
        </div>
        <ul class="member-list">
          <li
            v-for="member in selected.members"
            :key="member.userId"
          >
            <div class="member-main">
              <span
                class="team-avatar small"
                aria-hidden="true"
              >{{ member.firstName.slice(0, 1) }}</span><div><strong>{{ member.firstName }} {{ member.lastName }}{{ member.userId === currentUserId ? ' (вы)' : '' }}</strong><span class="muted">{{ roleLabels[member.role] }}{{ member.username ? ` · @${member.username}` : '' }}</span></div>
            </div>
            <div class="member-actions">
              <button
                v-if="selected.role === 'OWNER' && member.role !== 'OWNER'"
                class="text-button"
                :disabled="busy"
                @click="changeRole(member)"
              >
                {{ member.role === 'ADMIN' ? 'Снять права' : 'Сделать администратором' }}
              </button>
              <button
                v-if="canRemove(member)"
                class="text-button danger-text"
                :disabled="busy"
                :aria-label="`Удалить участника ${member.firstName}`"
                @click="askConfirmation('remove', member)"
              >
                Удалить
              </button>
            </div>
          </li>
        </ul>
      </section>
      <section
        v-if="!archiveView && selected.role !== 'MEMBER'"
        class="panel"
        aria-labelledby="invites-title"
      >
        <div class="section-header">
          <h3 id="invites-title">
            Приглашения
          </h3><button
            :disabled="busy"
            @click="createInvite"
          >
            + Пригласить
          </button>
        </div>
        <p class="muted">
          Приглашение действует 24 часа для одного нового участника. Отправьте ссылку в Telegram или поделитесь кодом.
        </p>
        <div
          v-if="freshInvite"
          class="invite-code-card"
        >
          <label for="fresh-code">Скопируйте код: повторно он не показывается</label>
          <textarea
            id="fresh-code"
            :value="freshInvite.token"
            readonly
            rows="2"
            spellcheck="false"
          />
          <small>До {{ formattedDate(freshInvite.expiresAt) }}</small>
          <div class="dialog-actions">
            <button @click="copyInviteLink">
              Скопировать ссылку
            </button><button
              class="secondary"
              @click="copyInvite"
            >
              Скопировать код
            </button>
          </div>
        </div>
        <ul
          v-if="invites.length"
          class="invite-list"
        >
          <li
            v-for="invite in invites"
            :key="invite.id"
          >
            <div><strong>{{ inviteLabels[invite.status] }}</strong><small class="muted">Создано {{ formattedDate(invite.createdAt) }}</small></div><button
              v-if="invite.status === 'ACTIVE'"
              class="text-button danger-text"
              :disabled="busy"
              @click="revokeInvite(invite.id)"
            >
              Отозвать
            </button>
          </li>
        </ul>
        <p
          v-else
          class="muted"
        >
          Приглашений пока нет.
        </p>
      </section>
      <div class="team-footer">
        <button
          v-if="selected.role === 'OWNER'"
          class="secondary danger-text"
          :disabled="busy"
          @click="askConfirmation('delete')"
        >
          Удалить команду
        </button>
        <button
          v-else
          class="secondary"
          :disabled="busy"
          @click="askConfirmation('leave')"
        >
          Выйти из команды
        </button>
        <button
          class="text-button"
          :disabled="busy"
          @click="selectTeam(selected.id)"
        >
          Обновить
        </button>
      </div>
    </template>
    <dialog
      ref="editor"
      class="sheet"
      aria-labelledby="team-editor-title"
      @cancel.prevent="!busy && editor?.close()"
    >
      <form @submit.prevent="saveTeam">
        <div class="section-header">
          <h2 id="team-editor-title">
            {{ editing ? 'Настройки команды' : 'Новая команда' }}
          </h2><button
            type="button"
            class="text-button"
            :disabled="busy"
            aria-label="Закрыть"
            @click="editor?.close()"
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
        <label for="team-name">Название</label><input
          id="team-name"
          v-model="name"
          maxlength="80"
          required
          autofocus
          :disabled="busy"
          placeholder="Например, Дизайн-команда"
        >
        <label for="team-description">Описание <span class="muted">· необязательно</span></label><textarea
          id="team-description"
          v-model="description"
          maxlength="500"
          rows="3"
          :disabled="busy"
          placeholder="Чем занимается ваша команда?"
        />
        <button
          class="full-width"
          :disabled="busy || !name.trim()"
        >
          {{ busy ? 'Сохраняем…' : editing ? 'Сохранить' : 'Создать команду' }}
        </button>
      </form>
    </dialog>
    <dialog
      ref="confirmDialog"
      class="sheet"
      aria-labelledby="team-confirm-title"
      @cancel.prevent="!busy && confirmDialog?.close()"
    >
      <form
        v-if="confirmation"
        @submit.prevent="confirmAction"
      >
        <h2 id="team-confirm-title">
          {{ confirmation.title }}
        </h2><p>{{ confirmation.text }}</p>
        <p
          v-if="error"
          role="alert"
          class="feedback error"
        >
          {{ error }}
        </p>
        <template v-if="confirmation.requiredName">
          <label for="confirm-name">{{ confirmation.requiredName }}</label><input
            id="confirm-name"
            v-model="confirmName"
            required
            autocomplete="off"
            :disabled="busy"
          >
        </template>
        <div class="dialog-actions">
          <button
            type="button"
            class="secondary"
            :disabled="busy"
            @click="confirmDialog?.close()"
          >
            Отмена
          </button><button
            class="danger-button"
            :disabled="busy || (!!confirmation.requiredName && confirmName !== confirmation.requiredName)"
          >
            {{ confirmation.button }}
          </button>
        </div>
      </form>
    </dialog>
  </div>
</template>


