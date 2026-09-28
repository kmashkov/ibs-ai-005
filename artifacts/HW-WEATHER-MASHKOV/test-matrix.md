# HW-WEATHER-MASHKOV

# Матрица тестирования v2

Все автоматические тесты используют фиксированные даты и внедрённый clock. Публичный формат имеет точность до минуты; ручная проверка пересчитывает даты непосредственно перед вызовом.

| Область | Сценарии | Ожидание | Файл/команда |
|---|---|---|---|
| Входная схема | duration 1 и 8; отклонить 0, 9, дробное, строку; неизвестный enum; пустой/121-символьный город; extra keys | Zod отвергает до сетевых запросов | `mcp-health.test.mjs` |
| Валидация времени | `start==now` отвергается новым API, старый `parseWorkPeriod` принимает; формат/календарь; reversed/empty interval | новый `parseSearchPeriod(searchStart,searchEnd,now)` использует один `requestNow`; старый контракт без изменений | `risk-time.test.mjs` |
| Horizon на минутной точности | `now=2026-09-24T12:00:00.000Z`; MSK `search_end=2026-09-29T15:00` ровно +120h проходит; `15:01` на 60 минут больше — отклоняется | нет невоспроизводимого MCP +1ms входа | `risk-time.test.mjs` |
| Candidate generator | начало :00 и :15; последний оконный end равен `search_end`; следующее окно за пределом; непомещающаяся длительность | первый start округляется вверх, шаг 1h; пусто возвращается чистой функцией | `risk-time.test.mjs` |
| Ранжирование | каждый risk rank, каждый tie-break, 0 factors; 0/1/3/4+ windows; все HIGH | кортеж `(risk rank, factors.length, start)`; top + max 3; HIGH winner честно `CANCEL` | `find-safe-weather-window.test.mjs` |
| JSON shape | Inspect selected/alternatives exact keys | Ни один `Date`, `period.start` или `period.end` не попадает в `structuredContent`; только публичные поля SafeWindow | `find-safe-weather-window.test.mjs`, MCP test |
| Генеративные свойства | deterministic seed, не менее 200 наборов; independent expected oracle; минимум две перестановки тех же оценок; случайные интервалы/duration проходят production generator | ranking/permutation и containment подтверждены независимо; конкретные отрицательные примеры ломают ошибочный comparator/boundary; transient mutation проверки без сохранения дефекта | `find-safe-weather-window.test.mjs` |
| Новый resolver | typo `Dubia` → единственный похожий `Dubai`; exact city; qualifiers match/mismatch; несколько exact; пустой результат | typo/mismatch/empty = not_found до forecast; multiple = ambiguous; только exact unique продолжает | `open-meteo.test.mjs` |
| Старый resolver | тот же fuzzy fallback через старый `assess` | прежнее поведение сохраняется | `open-meteo.test.mjs`, существующая regression |
| Forecast один и полный | URL с `timezone=UTC`, `wind_speed_unit=ms`, `forecast_days=6`; один forecast после exact geocode; interval пересекает крайние часы вне candidate | полный ряд для всего search `[start,end)` обязателен | `open-meteo.test.mjs` |
| Максимальный forecast horizon | `requestNow=2026-09-24T22:30Z`; start MSK `2026-09-29T20:15`, end `2026-09-30T01:30` (= UTC `2026-09-29T22:30`, +120h), duration 2; час 22:00Z вне candidates | Request несёт полный разобранный `SearchPeriod`; URL просит 6 дней; удаление именно `2026-09-29T22:00Z` даёт controlled error | `open-meteo.test.mjs` |
| Разделение clock | Handler clock читается один раз для parse/build; service method не принимает `requestNow`; service clock читается после forecast | `fetched_at` равен пост-forecast clock; полный period проверяется без повторного clock; ошибка не даёт payload | `open-meteo.test.mjs` / MCP test |
| Provider failures | not found/ambiguous, network, timeout, HTTP, bad JSON, malformed arrays, missing крайний час | все ошибки controlled, `structuredContent` отсутствует, частичный набор окон невозможен | `open-meteo.test.mjs` |
| Legacy stub | один `{assess}` обслуживает старые tools; вызвать на том же stub новый tool | server создаётся; новый вызов даёт `isError:true`, текст `Поиск погодных окон недоступен в подключённом погодном сервисе.`, нет structuredContent и сети | `mcp-health.test.mjs` |
| tools/list assertions | `compare-weather-windows.test.mjs:56` exact array; `mcp-health.test.mjs:64` exact array; `mcp-health.test.mjs:78,126,228` post-error length assertions | все пять assertions отражают четыре tools, включая ровно три legacy имени; после ошибок все доступны | `mcp-health.test.mjs`, `compare-weather-windows.test.mjs` |
| Старый compare | tie по каждому risk level, payload, индексы; состав tools | равный `risk_level` всё ещё оставляет оба окна tied | `compare-weather-windows.test.mjs` |
| Целевые тесты | после реализации | все выбранные тесты PASS | `node --import tsx --test test/risk-time.test.mjs test/open-meteo.test.mjs test/mcp-health.test.mjs test/compare-weather-windows.test.mjs test/find-safe-weather-window.test.mjs` из `weather-mcp/` |
| Полный CI | build и все тесты | оба этапа PASS; записать фактические результаты и число тестов | `npm run ci` |
| Ручная MCP проверка | после успешного CI: `npm run inspect`; вычисленные на момент вызова MSK даты: success с duration 1–2; отказ duration 0 | фактические inputs/output/errors/timestamp и ограничения сохранить в `verification.md`; никаких выдуманных результатов | Inspector запускает `node dist/index.js` |

Порядок ручных команд строго такой: из `weather-mcp/` `npm run ci`, затем при успехе `npm run inspect`. В рамках этапов анализа и v2 проектные команды не запускались.
