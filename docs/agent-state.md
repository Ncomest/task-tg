# Состояние проекта

Дата: 2026-10-26 (Europe/Moscow). Фактический путь в текущей сессии:
`C:\Users\ПК\task-tg`; AGENTS.md всё ещё указывает `E:\Programming\Vue\task-tg`.

## Проекты задач и маршрутизация (2026-10-26)

Цель: не отправлять задачи не в тот репозиторий. У задачи и идеи появился
`project` (`TG_BUDGET` или `TASK_TG`); в UI первым и по умолчанию выбран
`TG_BUDGET`. Worker выбирает worktree по `run.project`; при отсутствии проекта
запуск отклоняется. Для tg-budget временно создаётся отдельный
`.opencode/agents/task-agent.md` с разрешениями на `node` и read-only git,
который удаляется до коммита. Клон финансового проекта:
`C:\Users\ПК\tg-budget`, `main` `229bcac`.

Состояние:
- Ветка `feature/task-projects`; миграция `20261026130000_task_projects` и
  поля `Task.project`, `Idea.project`, `AgentRun.project` (nullable для старых
  строк).
- API требует проект при создании задачи/идеи; старые строки можно назначить
  через PATCH. `PROJECT_REQUIRED` возвращается для отправки агенту и
  преобразования идеи без проекта.
- Worker: `AGENT_REPO_DIR_TASK_TG`/`AGENT_REPO_DIR_TG_BUDGET`,
  `AGENT_INSTALL_TG_BUDGET=false`; профили проверок task-tg и tg-budget.
- Проверки: generate, typecheck, lint, unit, build, integration
  (`task_tg_auth_test`) и agent-integration (`task_tg_agent_test`) — PASS.
- `tg-budget`: `node --test` — 135 PASS; `node --check src/app.js`,
  `git diff --cached --check` — PASS (после staging).
- Не задеплоено и не запушено. Старый worker PID 14596 всё ещё работает на
  старом коде; не перезапускать до деплоя API/UI и назначения проекта
  финансовой задаче `b3711249-240b-41fb-b8d0-5c0d4f2fa8a3`.

## Агент-исполнитель (2026-10-26)

Цель: кнопка «Отправить агенту» в редакторе выбранной задачи; локальный worker
оценивает задачу, планирует, вносит изменения в отдельной ветке, запускает
проверки и открывает PR без автоматического merge. Статус и этапы видны в
менеджере задач.

Подтверждённое состояние:
- Добавлены общие типы `AgentRun*`, Prisma-модели `AgentRun`/`AgentEvent`,
  миграция `20261026090000_agent_runs` и индексы.
- API: создание/список/отмена запуска участником команды; worker-маршруты
  claim/heartbeat/complete защищены `AGENT_WORKER_TOKEN`; `/events` защищён
  per-run lease; lease 180 с; истёкшие запуски переходят в `FAILED`
  с `LEASE_EXPIRED`; задача переходит в `IN_PROGRESS` при создании запуска.
  Worker-операции и отмена сериализуются блокировкой строки Team, а reaper
  обновляет только всё ещё истёкший активный запуск, поэтому поздний
  heartbeat/report/complete не перезаписывает отмену.
- UI: панель агента в редакторе задачи, отправка, подтверждаемая отмена,
  статус, summary/error, ветка/PR, журнал этапов, история, опрос активного
  запуска каждые 4 секунды.
- Worker `scripts/agent-worker.mjs`: worktree, `npm ci`/`db:generate`,
  OpenCode CLI с агентом `task-agent`, heartbeat с начала работы, отчёты
  этапов через `scripts/agent-report.mjs`, проверки в очищенном окружении,
  скан защищённых файлов и секретов, коммит, push/PR, без merge.
- Агент `task-agent` ограничен: чтение/правка worktree, разрешённые
  `npm`/`npm.cmd`/`git`/helper; запрещены сеть, subagents, skills, `.env`,
  `.git`, `package.json`, lockfile и generated Prisma.
- Документация: README, docs/acceptance.md и этот файл.

Проверки:
- `npm run lint`, `npm run typecheck`, `npm test` — PASS; 14 unit-тестов.
- `npm run build` — PASS (финальные исходники).
- `test:integration` на отдельной `task_tg_auth_test` — PASS:
  auth/teams/tasks/ideas с новой миграцией.
- `test:agent-integration` на отдельной `task_tg_agent_test` — PASS:
  создание, изоляция, claim/lease, heartbeat, этапы, завершение, отмена,
  поздние heartbeat/complete/report после отмены, истечение аренды, каскад.
- Worker smoke с фиктивным OpenCode — PASS: этапы, проверки, коммит ветки,
  `DONE` без push/PR.
- Worker smoke с настоящим OpenCode CLI и моделью
  `opencode/deepseek-v4.1-flash-free` — PASS: `task-agent` создал файл,
  отчитался об этапах, выполнил `npm.cmd test`; worker выполнил проверки и
  закоммитил ветку. Ранее `opencode/flint-40b-free` вернул upstream error —
  внешняя проблема модели, не кода.
- Worker на реальном репозитории, `AGENT_INSTALL=true`, база
  `feature/agent-runs` — установка зависимостей и `db:generate` PASS; агент
  создал `docs/agent-smoke.md`; worker выполнил test/lint/typecheck/build и
  коммит. OpenCode завершился с кодом 1 из-за временных `ECONNRESET` от
  провайдера, поэтому запуск помечен `FAILED`, хотя проверки прошли. Ветка и
  коммит проверены и удалены; push/PR не выполнялись.
- GitHub-авторизация проверена через `git ls-remote` с токеном `gh`.

Решения:
- Worker локальный, опрашивает API; OpenCode CLI установлен на этом ПК.
- Отдельный git worktree на запуск; база `AGENT_BASE_BRANCH`, ветка
  `agent/<run>-<task>`; задача остаётся `IN_PROGRESS` после PR до проверки.
- Этапы: `QUEUED → ASSESSING → PLANNED → WORKING → REVIEW → DONE`;
  также `FAILED`, `CANCELLED`, `NEEDS_INPUT`.
- `AGENT_WORKER_TOKEN` нужен для claim/heartbeat/complete; для `/events`
  достаточно lease. Без серверного токена создание запуска возвращает 503.
- Проверки worker-а и `npm ci`/`db:generate` выполняются без production-секретов;
  это снижает утечку, но не является жёсткой песочницей.
- Автоматического merge нет.

НЕ ЗАПУЩЕНО / блокеры:
- Реальный `git push` и `gh pr create` в worker-прогоне не выполнялись:
  smoke-тесты шли с `AGENT_PUSH=false`/`AGENT_PR=false`. Нужен отдельный
  прогон на feature-ветке после коммита.
- Production API, `.env` VPS и Telegram UI агента не проверены; production
  `AGENT_WORKER_TOKEN` не задан. Деплой только после явного согласования.
- Worker не является песочницей: тесты/сборка агента выполняются локально
  и потенциально имеют доступ к файлам/сети. Остаточный prompt-injection риск.
- Feature закоммичен на ветке `feature/agent-runs`; `main` до merge не содержит
  конфигурацию агента и helper-скрипты. Для реального прогона до merge
  указывать `AGENT_BASE_BRANCH=feature/agent-runs`.

Следующий шаг:
1. Финальные проверки выполнены; временные smoke-файлы удалены.
2. Feature закоммичен на `feature/agent-runs`, без merge/deploy.
3. Реальный прогон с `AGENT_INSTALL=true` и базой `feature/agent-runs`
   выполнен; install, агент и проверки прошли, но OpenCode завершился с
   кодом 1 из-за временного `ECONNRESET`. Проверить push/PR отдельно на
   тестовой ветке/репозитории с `AGENT_PUSH=true`, `AGENT_PR=true` после
   согласования; текущий прогон был без push/PR.
4. После согласования настроить `AGENT_WORKER_TOKEN` на production,
   проверить Telegram UI и только затем деплоить.

## Этап 6: текущая граница (2026-10-25)
Этапы 1–5 реализованы и развёрнуты. Этап 6 начат: независимые проверки,
восстановление БД, исправления мобильного UI и документация выполнены.
Этап 6 ЦЕЛИКОМ НЕ ЗАВЕРШЁН: ожидается подтверждение постоянной конфигурации
по п. 12 AGENTS.md. Пользователю показан docs/stage6-proposal/plan.md и задан
асинхронный вопрос; на момент записи подтверждение не получено.
Не применять кандидаты до ответа. Не считать отсутствие ответа согласием.

## Подтверждённое приложение
- npm workspaces: Vue 3/Vite, Fastify 5, TypeScript strict, Prisma 7.10.1/PostgreSQL.
- Telegram initData: HMAC, срок и одноразовость; HttpOnly Secure SameSite=None
  Partitioned cookie на HTTPS; Origin обязателен для изменяющих запросов.
- Команды: OWNER/ADMIN/MEMBER, одноразовые хешированные приглашения, членство.
- Задачи: API CRUD, Kanban, редактор, assignee только из своей команды,
  q/status/assignee/cursor, PATCH/DELETE по версии. Выход/исключение снимает
  назначения и повышает версии; авторство сохраняется.
- Идеи: CRUD, поиск/страницы, редактор, атомарное преобразование в TODO-задачу.
  Повтор и конкуренция возвращают одну задачу. Преобразованная идея read-only;
  удаление идеи оставляет задачу; удаление задачи сохраняет convertedAt и
  повтор convert возвращает CONVERTED_TASK_DELETED без новой задачи.
- Все три роли могут работать с задачами/идеями своей команды. Посторонним — 404.
  Все операции команды сериализуются одной блокировкой строки Team.
- Конфликты/сеть сохраняют ввод внутри открытой формы, не после reload.
- Git инициализирован, ветка main. Публичный репозиторий:
  https://github.com/Ncomest/task-tg (создан по запросу пользователя 2026-10-25).
  .env, зависимости, generated/dist и архив деплоя исключены из Git;
  публикуемые файлы проверены на секреты. Миграции и схема в этапе 6 НЕ менялись.

## Исправления этапа 6, уже развёрнутые
- apps/web/src/style.css: overflow-wrap:anywhere у shell — длинное допустимое
  имя больше не растягивает страницу. max-width:100% у sheet — устранён
  стандартный отступ браузерного dialog; на 320 px sheet действительно от x=0
  до x=320. Горизонтальная прокрутка остаётся только у Kanban.
- apps/web/src/components/TeamWorkspace.vue: доступные названия обоих диалогов
  команды через aria-labelledby и соответствующие id заголовков.
- apps/api/test/boundaries.test.ts: изоляция rate limit пользователей за одним
  прокси, игнорирование поддельного X-Forwarded-For, Origin для PATCH/DELETE,
  отсутствие внутренних деталей в ответах 500.
- Production-конфигурация пока ПРЕЖНЯЯ. API-образ не менялся; web пересобран.
- README.md, docs/acceptance.md, docs/vps.md — проверки, ручная приёмка,
  безопасная процедура восстановления и ограничения.

## Проверено в этапе 6
- npm run lint, npm run typecheck, npm run build — PASS финальных исходников.
- npm test — PASS, 10 unit-тестов. Также эти 10 тестов прошли на VPS в одноразовом
  API-контейнере с подключённым новым тестовым файлом, не в рабочем API-процессе.
- npm audit и npm audit --omit=dev — 0 известных уязвимостей на 2026-10-25.
- bash run-auth-integration.sh на VPS — PASS: auth/teams/tasks/ideas,
  строго в отдельной task_tg_auth_test. После успеха тестовая БД удалена.
- Покрыты права, изоляция, assignee, выход/исключение, версии, страницы,
  гонки edit/delete/convert, повторы без дубликатов, удаление связанной задачи,
  искусственная ошибка второй записи и полный rollback конверсии.
- Свежий production pg_dump восстановлен через pg_restore --exit-on-error
  в НОВУЮ task_tg_restore_test. Четыре миграции/таблицы восстановлены,
  все внешние ключи validated; после проверки удалена только созданная тестовая БД.
  Рабочая БД не перезаписывалась. Это полное восстановление данных в отдельную БД,
  но не полное учение переноса всего VPS.
- UI на изолированном стенде: 320×640, 390×844, 768×1024, 1280×800;
  тёмная/светлая палитры Telegram, длинные имена/названия, прокрутка sheet,
  заголовки диалогов, Tab между полями, Escape и возврат фокуса к кнопке открытия.
- На 320 px после фикса нет переполнения всей страницы; sheet x=0,width=320,
  нижняя граница равна высоте viewport. Доска прокручивается отдельно.
- UI-гейты ролей: MEMBER без управления командой/приглашениями; ADMIN без
  удаления команды и назначения ролей. Сетевой сбой формы сохраняет ввод.
- Временный stage6-check.html удалён, на VPS не передавался. Собственные
  Vite-стенды 5180/5174 остановлены, исходный чужой процесс 5173 не затронут.
  Размер браузера сброшен, вкладка стенда закрыта.
- Серверная сборка web и Compose up --wait web — PASS,
  stage6-web-deploy.exit = 0, stage6-integration.exit = 0.
- Публичный HTTPS /api/ready: {"status":"ok","database":"connected"};
  /api/me без cookie — 401. HTTP 80 перенаправляет на HTTPS 8443.
- Публичный клиент /assets/index-BWgjyuhW.js соответствует финальной сборке,
  содержит team-editor-title. API/web/postgres healthy, Caddy running.
- .env до/после: SHA256 совпал; web без TELEGRAM_BOT_TOKEN и DATABASE_URL.
- Слушатель порта 443 до/после идентичен (PORT443_UNCHANGED).

## Что требует подтверждения, НЕ применено
Конкретный план и кандидаты: docs/stage6-proposal/plan.md.
1. Многостадийный Docker API: build/test/runtime, production-зависимости,
   скомпилированный API без исходников/тестов/tsx/typescript. Prisma CLI нужна
   для миграций при старте: перенести уже используемый пакет из devDependencies
   в dependencies и пересчитать lockfile без обновления разрешённых версий.
   Отдельная test-стадия/runner должны сохранить возможность интеграции.
2. compose.vps.yaml: только API — init, cap_drop ALL, no-new-privileges,
   grace 20s, exec node после миграций. Порты/volumes/.env не менять.
3. nginx: server_tokens off, HTML без устаревшего кеша, immutable для хешированных
   assets, 404 отсутствующих assets/скрытых файлов.
4. .dockerignore: .env.*, архивы и временные UI-стенды вне контекста.
5. Ежедневный локальный бэкап, новый systemd timer: 03:15 UTC / 06:15 Москва,
   до 5 минут jitter, Persistent, каталог .backups/automatic (700), файлы 600,
   БД/исходники/.env/Caddy-сертификаты, flock. Хранение 7 суток, удаление только
   собственных auto-* в новом каталоге; старые ручные копии не трогать.
Кандидаты НЕ собраны/не установлены и не выдаются за проверенную конфигурацию.
Таймер НЕ установлен. После согласования сначала проверить кандидаты,
интеграцию/test-образ, первый бэкап и восстановление, потом разворачивать.

## НЕ ЗАПУЩЕНО / ограничения
- Реальный Telegram webview, физические телефоны и экранная клавиатура:
  НЕ ЗАПУЩЕНО, нужен пользовательский Telegram-сеанс. До этого пользователь
  подтверждал реальный вход, но не полную приёмку задач/идей.
- Браузерный стенд с фиктивным транспортом не является полным Telegram E2E;
  его палитры не подтверждают все возможные темы пользователя.
- Production hardening, автоматические бэкапы, восстановление сертификатов
  и полный перенос на новый VPS — пока НЕ ЗАПУЩЕНО/ожидают согласования.
- Внешний бэкап не настроен: внешнее хранилище пользователь не предоставлял.
- Полную готовность этапа 6 не объявлять до разрешения конфигурационной границы;
  недоступные реальные устройства даже после этого явно отмечать как непроверенные.

## VPS и резервные копии
URL: https://task-tg.45-9-116-46.sslip.io:8443/
root@45.9.116.46, /opt/task-tg, Ubuntu 24.04, 1 ГБ RAM, swap 2 ГБ.
Перед этапом около 2.2 ГБ свободно; тяжёлые сборки последовательно, проверять диск.
Compose ВСЕГДА три файла:
`docker compose -f compose.yaml -f compose.vps.yaml -f compose.https.yaml --profile app ...`
443 занят необходимой программой: не трогать её, Docker daemon и системные сервисы.
Caddy — 80/8443; web 8080 loopback, API/Postgres не опубликованы наружу.
Не использовать down -v и широкую очистку образов/бэкапов.
Серверный .env не выводить/не перезаписывать. Доступ SSH подтверждён;
в новой сессии при отсутствии доступа запросить безопасно, секреты в проект не писать.

До правок этапа 6: /opt/task-tg/.backups/stage6-20261025T203731Z/
source.tar.gz, server.env, env.sha256, port443.txt, database.dump, database.contents.
.backups/stage6-latest указывает этот каталог. Образы до правок:
task-tg-api:before-stage6-20261025, task-tg-web:before-stage6-20261025.
Предыдущие stage5/stage4/auth/teams копии и образы сохранены.
Логи: /tmp/task-stage6-restore.log, task-stage6-integration.log,
 task-stage6-unit.log, task-stage6-web-build.log, task-stage6-web-deploy.log.
Скрипт текущей интеграции /opt/task-tg/run-auth-integration.sh требует старого
полного API-образа (tsx/исходники). После облегчения runtime нужен отдельный test-образ.
Не удалять существующие неизвестные тестовые БД вслепую.

## Продолжение
Промпт: docs/next-agent-prompt.md. Один агент, короткий прогресс минимум раз
в минуту. После двух попыток без прогресса одной проблемы остановиться и сообщить.
Постоянные инструкции/конфигурация — план и согласование (AGENTS.md, п. 12).
Telegram/BotFather выполняет пользователь: настройки не менять, сообщения не отправлять.
