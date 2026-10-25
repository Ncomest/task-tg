# Развёртывание на текущем VPS

Сервер: `45.9.116.46`, Ubuntu 24.04. Каталог приложения: `/opt/task-tg`.
Инфраструктурный каркас дополнен Telegram-авторизацией.

## Сеть

- Веб-вход: `https://task-tg.45-9-116-46.sslip.io:8443`.
- Порт 443 занят необходимым пользователю сервисом. Не менять его настройки,
  не останавливать и не занимать этот порт при последующих развёртываниях.
- Платного домена нет: sslip.io автоматически разрешает имя в IP сервера.
  Имя зависит от доступности стороннего DNS-сервиса.
- Caddy получает и обновляет публичный сертификат через HTTP-01 на порту 80.
  TLS-ALPN challenge отключён, порт 443 не используется.
- Порт 80 перенаправляет на HTTPS:8443. Старый 8080 доступен только на loopback.
- API и PostgreSQL не публикуют порты хоста в VPS-конфигурации.
- Используются `compose.yaml`, `compose.vps.yaml` и `compose.https.yaml` вместе.

## Управление

Выполнять на VPS из `/opt/task-tg`:

```sh
docker compose -f compose.yaml -f compose.vps.yaml -f compose.https.yaml --profile app ps
docker compose -f compose.yaml -f compose.vps.yaml -f compose.https.yaml --profile app logs --tail=100 api caddy
docker compose -f compose.yaml -f compose.vps.yaml -f compose.https.yaml --profile app restart api web
```

Обновление после загрузки новых исходников (не перезаписывать `.env`):

```sh
# Последовательная сборка уменьшает пиковое потребление памяти на VPS с 1 ГБ RAM.
docker compose -f compose.yaml -f compose.vps.yaml -f compose.https.yaml --profile app build api
docker compose -f compose.yaml -f compose.vps.yaml -f compose.https.yaml --profile app build web
docker compose -f compose.yaml -f compose.vps.yaml -f compose.https.yaml --profile app up -d --wait --wait-timeout 180
curl --fail https://task-tg.45-9-116-46.sslip.io:8443/api/ready
```

API автоматически применяет миграции перед запуском. После запуска проверить
логи и таблицу миграций. Это не заменяет резервное копирование перед изменениями БД.
Не применять `down -v`: это удалит данные проекта.

## Секреты и данные

Серверный `.env` создаётся на VPS со случайным паролем БД и правами `600`.
В нём также хранятся `TELEGRAM_BOT_TOKEN` и публичный
`PUBLIC_HOST=task-tg.45-9-116-46.sslip.io`. Bot token передаётся только контейнеру API.
Реквизиты SSH и содержимое `.env` в документацию и исходники не записываются.
Данные PostgreSQL находятся в Docker volume `task-tg_postgres_data`.
Сертификаты Caddy сохраняются в volume `task-tg_caddy_data` — не удалять его.
Перед авторизацией сохранены копия БД и исходников в `/opt/task-tg/.backups`,
старые образы имеют тег `before-auth-20261023`. Каталог бэкапов исключён из сборки.
Автоматические бэкапы и окончательная production-сборка относятся к этапу 6.

## Ограничения

Проверка в настоящем Telegram требует открытия меню бота с аккаунта пользователя.
Синтетические initData в изолированных тестах не подтверждают реальный вход в Telegram.
Одна доступность страницы не подтверждает выполнение всех этапов проекта.

## Проверенное восстановление в отдельной БД

2026-10-25 свежий дамп восстановлен с `pg_restore --exit-on-error` в новую
`task_tg_restore_test`. Четыре миграции и таблицы восстановлены, все внешние
ключи validated. После успеха удалена только созданная проверочная БД.
Рабочая БД не перезаписывалась. Это проверка восстановления данных, не учение
полного переноса сервера на другой VPS.

Перед каждой проверкой из /opt/task-tg с тремя файлами Compose убедиться,
что `task_tg_restore_test` не существует. Если существует — остановиться
и выяснить владельца/назначение, не удалять вслепую.

```sh
compose=(docker compose -f compose.yaml -f compose.vps.yaml -f compose.https.yaml --profile app)
"${compose[@]}" exec -T postgres psql -U task_tg -d postgres -Atqc "SELECT datname FROM pg_database WHERE datname='task_tg_restore_test'" </dev/null
# Продолжать только при пустом результате и успешном выполнении команды.
"${compose[@]}" exec -T postgres psql -U task_tg -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE task_tg_restore_test OWNER task_tg' </dev/null
# Выбрать существующий проверяемый бэкап; ниже проверенный в этой сессии.
backup_dir=.backups/stage6-20261025T203731Z
"${compose[@]}" exec -T postgres pg_restore --exit-on-error --no-owner -U task_tg -d task_tg_restore_test < "$backup_dir/database.dump"
"${compose[@]}" exec -T postgres psql -U task_tg -d task_tg_restore_test -v ON_ERROR_STOP=1 -c 'SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name' -c "SELECT count(*) FROM pg_constraint WHERE contype='f' AND NOT convalidated" </dev/null
# Только после успешной проверки; удаляется собственная проверочная БД, не рабочая.
"${compose[@]}" exec -T postgres psql -U task_tg -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE task_tg_restore_test' </dev/null
```

При ошибке восстановления сохранить диагностический лог, остановиться; не применять
эти команды к task_tg и не удалять тестовую БД без выяснения причины.
При восстановлении на другом сервере потребуются отдельно Docker volumes Caddy,
копия серверного .env с правами 600 и соответствующие исходники/образы.
Текущие резервные копии локальны этому VPS; внешнее хранилище не настроено.

## Откат релиза

Перед обновлением сохранены исходники, .env, дамп БД и теги API/web. Для отката
кода выбрать проверенный тег API и web, а не пересобирать неизвестные исходники.
Сначала оценить совместимость схемы: Prisma не выполняет автоматический down.
Для этапов 5–6 новых миграций нет; общая схема задач/идей уже была применена раньше.
Образы before-stage6-20261025 сохраняют состояние до исправлений финализации.
Не запускать down -v, не удалять volumes, не заменять рабочий .env.

Полный откат данных рабочей БД требует согласованного окна, остановки пишущих
контейнеров, отдельного бэкапа текущих данных и явного плана восстановления.
В этой сессии рабочая БД не восстанавливалась и не очищалась.

## Финальная приёмка

Проверенные сценарии и ручные шаги Telegram: [acceptance.md](acceptance.md).
Кандидаты production-изменений и постоянных бэкапов находятся в
[stage6-proposal/plan.md](stage6-proposal/plan.md); до подтверждения по AGENTS.md
они не применяются. Установка таймера не подразумевается одним наличием файлов.

