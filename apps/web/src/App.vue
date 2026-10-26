<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import type { CurrentUser, MeResponse } from '@task-tg/shared';
import { api, ApiError } from './api';
import { connectTelegram } from './telegram';
import TeamWorkspace from './components/TeamWorkspace.vue';

const user = ref<CurrentUser | null>(null);
const state = ref<'loading' | 'outside' | 'ready' | 'error' | 'logged-out'>('loading');
const message = ref('Проверяем вход…');
const busy = ref(false);
const logoutError = ref('');
let telegram = { initData: '', disconnect: () => {} };

async function signIn() {
  if (busy.value) return;
  busy.value = true;
  state.value = 'loading';
  message.value = 'Проверяем вход…';
  try {
    // Fresh initData contains the current Telegram profile. Sign in with it even
    // when a session cookie exists, otherwise a changed name is applied only
    // after the old session expires. A used or stale grant keeps the session.
    if (telegram.initData) {
      try {
        await api<MeResponse>('/auth/telegram', { initData: telegram.initData });
      } catch {
        // Profile refresh is best-effort; a valid session still works below.
      }
    }
    // Verify that the webview actually retained the session cookie.
    let profile: MeResponse;
    try { profile = await api<MeResponse>('/me'); } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      if (!telegram.initData) {
        state.value = 'outside';
        message.value = 'Откройте приложение через кнопку меню нашего бота в Telegram.';
        return;
      }
      throw error;
    }
    user.value = profile.user;
    state.value = 'ready';
    message.value = 'Вход через Telegram выполнен';
  } catch (error) {
    user.value = null;
    state.value = 'error';
    message.value = error instanceof ApiError && error.status === 429
      ? 'Слишком много попыток. Подождите минуту и попробуйте снова.'
      : error instanceof ApiError && error.status === 401
        ? 'Сессия не подтверждена. Закройте и снова откройте приложение в Telegram.'
        : 'Не удалось войти. Проверьте соединение и попробуйте снова.';
  } finally { busy.value = false; }
}

async function signOut() {
  busy.value = true;
  logoutError.value = '';
  try {
    await api('/auth/logout', {});
    user.value = null;
    state.value = 'logged-out';
    message.value = 'Вы вышли. Для нового входа закройте и снова откройте приложение в Telegram.';
  } catch { logoutError.value = 'Не удалось выйти. Попробуйте ещё раз.'; }
  finally { busy.value = false; }
}

onMounted(() => { telegram = connectTelegram(); void signIn(); });
onUnmounted(() => telegram.disconnect());

function expireSession() {
  user.value = null;
  state.value = 'error';
  message.value = 'Сессия истекла. Закройте и снова откройте приложение в Telegram.';
}
</script>

<template>
  <main class="shell">
    <p class="eyebrow">
      TASK TG
    </p>
    <div class="section-header">
      <h1>{{ user ? 'Ваше пространство' : 'Работа команды — рядом' }}</h1><button
        v-if="user"
        class="text-button"
        :disabled="busy"
        @click="signOut"
      >
        Выйти
      </button>
    </div>
    <p class="intro">
      {{ user ? `Привет, ${user.firstName}. Выберите команду или создайте новую.` : 'Задачи и идеи вашей команды прямо в Telegram.' }}
    </p>
    <section
      v-if="!user"
      class="card"
      aria-labelledby="account-title"
    >
      <div
        class="account-icon"
        aria-hidden="true"
      >
        ↗
      </div>
      <h2 id="account-title">
        Вход через Telegram
      </h2>
      <p
        role="status"
        aria-live="polite"
      >
        {{ message }}
      </p>
      <button
        v-if="state === 'error'"
        :disabled="busy"
        @click="signIn"
      >
        Попробовать снова
      </button>
      <a
        v-else-if="state === 'outside' || state === 'logged-out'"
        class="button"
        href="https://t.me/task_finc_bot"
        target="_blank"
        rel="noopener noreferrer"
      >Открыть бота</a>
    </section>
    <p
      v-if="user && logoutError"
      role="alert"
      class="feedback error"
    >
      {{ logoutError }}
    </p>
    <TeamWorkspace
      v-if="user"
      :current-user-id="user.id"
      @session-expired="expireSession"
    />
    <p
      v-else
      class="note"
    >
      Вход доступен только через @task_finc_bot.
    </p>
  </main>
</template>
