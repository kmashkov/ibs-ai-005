# HW-WEATHER-MASHKOV

## Идентичность и контрольная точка

Источник: `ЗАДАНИЕ.md`; проект: `weather-mcp`; идентификаторы `task_key` и `external_id` в `task.json` совпадают. Пользователь заказал только анализ и планирование. До явного одобрения `implementation-plan-v2.md` исходники, тесты, manifest/lock, конфигурация и README проекта не изменяются. Оркестратор отвечает за реестр и статус; готовый план не равен одобренному.

## Минимальные входы следующего этапа

- `task-spec.md`, `task-spec.json`, `questions.md` — требования и предложения к одобрению.
- `repository-map.md`, `dependency-map.md` — отдельные исследования; оркестратор прочитал обе карты и сверил с исходниками.
- `weather-mcp/src/index.ts`: `createServer` и три регистрации MCP, совместимость обработки ошибок и внедрения зависимостей.
- `weather-mcp/src/open-meteo.ts`: `OpenMeteoRiskService.assess`, разрешение города, HTTP, разбор полного ряда, кэш.
- `weather-mcp/src/time.ts`: `parseWorkPeriod`, `intersectsHour`, MSK→UTC и горизонт.
- `weather-mcp/src/risk.ts`: `assessRisk`, `HourlyWeather`, `RiskFactor` — единственный источник порогов.
- `weather-mcp/test/risk-time.test.mjs`, `open-meteo.test.mjs`, `compare-weather-windows.test.mjs`, `mcp-health.test.mjs` — тестовые шаблоны, инъекция времени/fetch, старые контракты.
- `weather-mcp/package.json`, `package-lock.json`, `README.md` — команды, существующие зависимости и документация.

Не передавать целиком `node_modules`, `dist`, двоичные файлы и посторонние промпты ролей.

## Факты, проверенные оркестратором

1. Весь интервал **поиска**, а не только выбранное окно, должен находиться в будущем и укладываться в `now + 5 суток`. Проверять до сетевых запросов; использовать единый снимок времени для проверки границ.
2. В текущем коде `parseWorkPeriod` допускает начало, равное `now`, и положительную дробную длительность. Не ужесточать этот контракт для старых инструментов.
3. Текущая оценка создаёт фактор для каждой нарушенной пары час/метрика. Пороговые правила не зависят от `work_type`. Новый критерий числа факторов разумно реализовать через `factors.length`.
4. `compare_weather_windows` при одинаковом уровне риска сохраняет ничью. Новый критерий факторов/времени нельзя переносить в старый инструмент.
5. `OpenMeteoRiskService.assess` геокодирует город и получает один forecast для своего периода. Вызов для каждого кандидата не подходит. Следует выбрать один общий путь получения полного ряда, затем оценивать кандидатов локально.
6. `parseForecast` требует покрытие каждого часа, пересекающего `[start,end)`, и получает прогноз с `timezone=UTC`, `wind_speed_unit=ms`, `forecast_days=6`. Проверка всего поиска должна включать часы вне собственно кандидатов на неполных границах.
7. Москва в текущем парсере — фиксированный UTC+3, поэтому выравнивание на :00 по MSK и UTC эквивалентно. Не нужно создавать различие правил выравнивания.
8. Кэш действующего риск-сервиса сохраняет исходный `fetched_at`. Не переписывать его при cache hit. Новый поиск может обойтись без своего кэша: это проектное решение, которое не требует изменения старого кэша.
9. `createServer` принимает внедряемый риск-сервис; старые тесты передают объект только с `assess`. Новая регистрация не должна требовать дополнительных методов от такого объекта при создании сервера или вызове старого инструмента.
10. В коде существуют пять assertions tools/list: точные массивы имён в `compare-weather-windows.test.mjs:56` и `mcp-health.test.mjs:64`, плюс три проверки длины в `mcp-health.test.mjs:78,126,228`. С v2 обновить все пять до состава из четырёх инструментов, сохранив три старых имени.

## Контракты v2 для Builder после одобрения

- `src/time.ts`: `SearchPeriod {start:Date,end:Date}`, `CandidatePeriod {start:Date,end:Date,duration_hours:number}`; экспорт `parseSearchPeriod(searchStart,searchEnd,now)` и `buildCandidatePeriods(period,durationHours)`. Только новый путь требует start строго после now; старый `parseWorkPeriod` не менять.
- `src/open-meteo.ts`: `SafeWindowSearchRequest` включает raw поля, `period: SearchPeriod` (весь поиск), `candidates: CandidatePeriod[]`; optional capability `findSafeWeatherWindow(request): Promise<SafeWindowSearchResult>`. Метод не получает requestNow и не перепроверяет границы. Отдельный exact resolver только нового пути; `assess` сохраняет fuzzy fallback.
- Внутреннее ранжирование: `AssessedCandidate {period: CandidatePeriod,risk_level,recommendation,factors}`; `rankSafeWindows(AssessedCandidate[])`, comparator по risk, `factors.length`, `period.start`. Публичный `SafeWindow` — только JSON-поля `start_at`, `end_at`, `duration_hours`, `risk_level`, `recommendation`, `factors`, без Date/period.
- Handler захватывает один `requestNow` для parse/build. Сервис использует полный `period` для проверки часов. Отдельный injected service clock читается после успешного forecast для `fetched_at`.
- Успешный structured payload также имеет `checked_candidates`, `city`, `source`, `fetched_at`, `input_timezone=Europe/Moscow`, `window_timezone=Europe/Moscow`, `factor_timezone=UTC`, `selected`, `alternatives`. Ошибки не имеют частичного payload. Пустые candidates — controlled отказ до сети; все HIGH — вернуть лучший с CANCEL.
- Геокодинг нового инструмента требует точное нормализованное имя + qualifiers; старые инструменты не меняют resolver. Forecast задаёт UTC, ms, три hourly поля и `forecast_days=6`, валидирует часы всего периода, даже вне candidates.
- Все пять tools/list assertions: exact names в `compare-weather-windows.test.mjs:56`, `mcp-health.test.mjs:64`, lengths в `mcp-health.test.mjs:78,126,228` обновить/усилить для четырёх инструментов.
- Граничный mock: now `2026-09-24T22:30Z`, start MSK `2026-09-29T20:15`, end `2026-09-30T01:30` (= +120h), duration 2; последний час `2026-09-29T22:00Z` должен требоваться, хотя он вне candidate windows.
- Роли после approval: Builder → Tester → Reviewer; отдельная личная ветка и baseline CI до реализации.

## Проверки и ограничения текущего этапа

Локально прочитаны версии Node `v22.23.0`, npm `10.9.8`. Исходная ветка — `master`, последний коммит `d1312bc`, начальный статус Git чистый; наличие личной копии либо создание отдельной ветки нужно подтвердить до реализации. Файлы проекта зафиксированы в `source-baseline.json`.

`npm run ci`, установка пакетов, Inspector и реальные погодные запросы на текущем этапе не выполнялись. Будущие команды выполняются из `weather-mcp`. Нужны базовая и итоговая `npm run ci`, целевые тесты из плана и ручные MCP успех/отказ с актуальными будущими датами.
