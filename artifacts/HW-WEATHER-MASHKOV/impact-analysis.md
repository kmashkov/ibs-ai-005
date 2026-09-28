# HW-WEATHER-MASHKOV

# Анализ влияния v2

## Файлы и контракты

| Файл | Предложенное изменение | Воздействие и защита |
|---|---|---|
| `weather-mcp/src/time.ts` | Добавить `SearchPeriod`, `CandidatePeriod`, `parseSearchPeriod(searchStart,searchEnd,now)` и `buildCandidatePeriods(period,duration)` | Новый путь требует `start>now`, валидирует весь поиск до сети. Старый `parseWorkPeriod` сохраняет `start>=now`. |
| `weather-mcp/src/open-meteo.ts` | Добавить `findSafeWeatherWindow(request)` с `request.period: SearchPeriod`; exact-only resolver; один forecast | Сервис проверяет полное переданное окно, включая граничные часы вне candidates. Старый `assess` и fuzzy fallback остаются неизменны. |
| `weather-mcp/src/risk.ts` | Ранжировать внутренний `AssessedCandidate {period: CandidatePeriod, risk_level, recommendation, factors}` через `rankSafeWindows(AssessedCandidate[])` | Пороги остаются только в `assessRisk`; порядок risk, `factors.length`, `period.start`. `SafeWindow` — отдельная JSON-проекция без объектов Date. |
| `weather-mcp/src/index.ts` | Строгая Zod schema и новый handler с optional search capability | Legacy сервис `{assess}` продолжает создавать сервер и работать для старых tools; новый вызов на нём даёт контролируемую ошибку без сети/payload. |
| `weather-mcp/test/*.test.mjs` | Временные, geocoding, full forecast, ranking, MCP, legacy и генеративные проверки | Без новых зависимостей. Все точные tools/list ожидания обновляются и проверяются. |
| `weather-mcp/README.md` | Описать новый tool, JSON schema, часовые зоны, сортировку и ошибки | Существующие инструкции старых инструментов сохраняют корректность. |

## Точная граница ответа и сервиса

Сервисный request включает raw input для данных/документации, `period: SearchPeriod` для проверки полного `[start,end)` и `candidates: CandidatePeriod[]`. Сервис не получает `requestNow`, не валидирует его повторно и не ограничивает forecast набором кандидатов. Handler один раз читает request clock, валидирует и строит candidates. Сервис один раз читает свой injected clock после успешного полного forecast для `fetched_at`.

Внутренний `AssessedCandidate` содержит `Date`-период для ранжирования. Публичный `SafeWindow` содержит только `start_at`, `end_at`, `duration_hours`, `risk_level`, `recommendation`, `factors`; serializer не может случайно раскрыть `Date` поля. Успешный объект также называет `input_timezone=Europe/Moscow`, `window_timezone=Europe/Moscow`, `factor_timezone=UTC`.

Новый resolver требует точного нормализованного совпадения имени и всех comma qualifiers с `admin1` или `country`: ноль — not_found, один — продолжить, несколько — ambiguous. Старый `assess` сохраняет прежний fuzzy fallback. Forecast URL явно задаёт UTC, ms, перечисленные hourly fields и `forecast_days=6`; validator покрывает каждый час полного search period. Ошибка не даёт частичного результата. Нет миграций/новых пакетов/нового cache.

## Регрессии и критерии

- Инструментов ровно четыре, старые три остаются на месте; compare tie не меняется. Существующие пять проверок списка: точный список в `compare-weather-windows.test.mjs:56`, точный список в `mcp-health.test.mjs:64`, числовые length assertions там же на строках 78, 126, 228. Обновить весь набор, сохранить проверку старых имён.
- Крайний UTC час проверяется отдельным фиксированным примером: now `2026-09-24T22:30Z`; start MSK `2026-09-29T20:15`, end `2026-09-30T01:30`, duration 2. Час `2026-09-29T22:00Z` лежит в search, но вне candidates; его отсутствие отклоняет весь ответ.
- Horizon input имеет минутную точность: ровно `now+120h` допустим, следующая представимая MSK минута на 60 минут дальше отклоняется. Не заявлять MCP test на +1ms.
- Генеративная проверка применяет независимый oracle и production candidate generator; ответ гарантирует containment и устойчивость ранжирования.
- Ручной отказ воспроизводится `duration_hours: 0`; Inspector выполняется после успешного `npm run ci` через `npm run inspect`. Сохраняются реальные аргументы, ответы и timestamp.

Статус остаётся `ANALYZED`, approval `pending`. Реализация запрещена до явного одобрения `implementation-plan-v2.md`; после него роли идут строго последовательно Builder → Tester → Reviewer.
