# HW-WEATHER-MASHKOV

# Weather MCP 2.0 — план реализации v1

**Цель:** добавить `find_safe_weather_window`, который за один прогноз оценивает все допустимые целочасовые окна и возвращает лучший вариант с тремя или меньшим числом альтернатив.

**Архитектура:** в `src/index.ts` добавить отдельный MCP handler и схему; время поиска валидировать отдельно от старых `parseWorkPeriod` контрактов. В `src/open-meteo.ts` добавить отдельный метод поиска, который геокодирует город существующей логикой, один раз получает и проверяет полный прогноз диапазона, а затем передаёт локальные часы кандидатов в общий `assessRisk`. Небольшие чистые функции построения кандидатов и ранжирования размещаются в `src/time.ts` и `src/risk.ts` соответственно.

**Стек:** Node.js 20+, TypeScript strict, MCP SDK 2, Zod 4, Node test runner; без новых зависимостей.

**Расположение:** `artifacts/HW-WEATHER-MASHKOV/` согласно запросу пользователя; до реализации требуется отдельная ветка/личная копия и baseline `npm run ci`.

## Рассмотренные подходы

1. **Повторно вызвать `assess` для каждого кандидата.** Отклонён: делает геокодирование/forecast многократно и нарушает требование единственного forecast-запроса.
2. **Добавить независимый сервис поиска с локальным разбором API и порогов.** Отклонён: дублирует схему Open-Meteo/риск и может разойтись с `assessRisk`.
3. **Добавить новый метод в текущий Open-Meteo сервис, переиспользовав геокодирование, fetch/timeout/error helpers и `assessRisk`; старые методы оставить неизменными.** Выбран: минимально расширяет границы модулей, позволяет проверить весь прогноз один раз и не требует от старых тестовых stub-объектов нового метода.

## Фиксируемые предложения API для одобрения v2

Вход нового tool — строгий объект:

```ts
type FindSafeWeatherWindowInput = {
  city: string; // trim, длина 1..120
  work_type: "maintenance" | "installation" | "inspection";
  search_start: string; // YYYY-MM-DDTHH:mm, MSK UTC+3
  search_end: string;   // YYYY-MM-DDTHH:mm, MSK UTC+3
  duration_hours: number; // integer 1..8
};
```

Предлагаемая стабильная успешная схема `structuredContent`:

```ts
type SafeWindow = {
  start_at: string; // YYYY-MM-DDTHH:mm MSK
  end_at: string;   // YYYY-MM-DDTHH:mm MSK, exclusive
  duration_hours: number;
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  recommendation: "PROCEED" | "REVIEW" | "CANCEL";
  factors: RiskFactor[];
};
type FindSafeWeatherWindowResult = {
  checked_candidates: number;
  city: { name: string; region?: string; country: string; timezone: string };
  source: "Open-Meteo";
  fetched_at: string; // ISO UTC, время получения единственного forecast
  selected: SafeWindow;
  alternatives: SafeWindow[]; // 0..3
};
```

Город — однозначно разрешённый Open-Meteo location. `checked_candidates` равно числу всех допустимых окон, переданных ранжировщику. Риски/факторы — результат `assessRisk` без модификации. При одинаковых ключах остаётся детерминированный порядок генерации (раньше раньше); критерий входа уже делает start различным.

**Время и генерация:** взять ровно один `now` из внедрённого clock; разобрать обе строки тем же календарным форматом/MSK UTC+3, что `parseWorkPeriod`, но новым helper-ом без изменения старого. Требовать `search_start > now`, `search_end > search_start`, `search_end <= now + 120h`. Диапазон поиска трактуется как `[start,end)`. Первый кандидат — `ceil(search_start / 1h) * 1h`; затем шаг 1h, пока `candidate_start + duration <= search_end`. Если список пуст — вернуть MCP error с `isError:true`, текстом `В указанном интервале нет допустимых погодных окон.`, без `structuredContent` и до геокодинга/fetch. Успешно разрешённые кандидаты сортируются по `(risk rank LOW=0/MEDIUM=1/HIGH=2, factors.length, start timestamp)`. HIGH не отфильтровываются: возвращается лучший по сортировке с честным `CANCEL`.

**Полный прогноз:** forecast interval — `[search_start, search_end)`, а не оболочка крайних кандидатов. Проверить каждый UTC час, пересекающий этот интервал (`hourStart < end && hourStart + 1h > start`), включая крайние часы, лежащие вне кандидатов. Так сохраняется контракт полного почасового покрытия на неполных границах. Один часовой ряд запрашивается одним HTTP forecast после успешного geocoding; сохранить существующие 5-секундный timeout, проверку HTTP/JSON/полей, `WeatherDataError` и единицы UTC/ms. `fetched_at` снимается после успешного разбора этого ответа. Новый путь вправе не использовать новый кэш; старый кэш и его `fetched_at` не меняются.

## Файлы и ответственность

- `weather-mcp/src/time.ts` — новый поиск-специфичный parser/validator и генератор кандидатов; `parseWorkPeriod` и `intersectsHour` остаются с прежним контрактом.
- `weather-mcp/src/open-meteo.ts` — типы input/result, общий/выделенный метод получения полного поиска, повторное использование геокодирования и текущих HTTP/forecast validators; никаких копий риск-порогов.
- `weather-mcp/src/index.ts` — регистрация нового tool, вызов только если предоставленный risk service имеет новый метод, сериализация стабильного результата и контролируемых ошибок. `createServer` с legacy stub `{ assess(...) }` должен продолжить создавать сервер; старые tools продолжают обращаться только к `assess`.
- `weather-mcp/src/risk.ts` — экспортировать/использовать узкий общий helper для оценки уже выбранных `HourlyWeather[]` через `assessRisk`, если нужен для типизации; бизнес-логика `assessRisk` не изменяется.
- `weather-mcp/test/risk-time.test.mjs` — фиксированные даты новых границ и генерации.
- `weather-mcp/test/open-meteo.test.mjs` — фиксированные mocks: геокодирование отдельно, один forecast, полный интервал, контролируемые ошибки/timeout/неполнота.
- `weather-mcp/test/compare-weather-windows.test.mjs` — обновить ровно ожидание count с 3 на 4 и добавить проверку сохранения compare tie/результатов.
- `weather-mcp/test/mcp-health.test.mjs` — MCP schema, registration, legacy stub совместимость.
- Создать `weather-mcp/test/find-safe-weather-window.test.mjs` для end-to-end handler/ranking и генеративных инвариантов (без зависимости): seeded deterministic PRNG + циклы по наборам кандидатов; даты фиксированные.
- `weather-mcp/README.md` — схема аргументов/результата, часовая семантика, сортировка, HIGH/CANCEL, no-candidate ошибка, пример с датами, динамически сдвигаемыми относительно даты чтения.
- После реализации создать `artifacts/HW-WEATHER-MASHKOV/verification.md`, `reflection.md` (5–10 предложений) и главный промпт `prompts/homework-weather-mcp.md`, если их ещё нет. Эти deliverables не создавать на этапе v1.

## Малые шаги реализации

Все команды выполняются из `weather-mcp/`; даты тестов фиксированные, ручные MCP примеры вычисляются на момент запуска и не копируются как будущие после срока.

### Этап 0 — рабочая копия и baseline (до кода)

- [ ] Перейти на отдельную личную ветку/копию после согласования `implementation-plan-v2.md`; текущая общая ветка не является местом реализации.
- [ ] Выполнить `npm run ci` и записать baseline в change-set/verification. Ожидаемо: `tsc` завершился с кодом 0, Node test runner сообщил pass для всего исходного набора; число взять из реального вывода.

### Этап 1 — чистые правила времени

- [ ] В `src/time.ts` добавить именованные типы `SearchPeriod`, `CandidatePeriod`; helper парсинга строки того же формата и проверку полного поиска одним `now`: `start > now`, `end > start`, `end <= now + 120h`; ошибки — `InputError` с конкретными русскими сообщениями.
- [ ] Добавить `buildCandidatePeriods(period, durationHours)`: выравнивание `ceil(start / 3600000) * 3600000`; генерировать пока `start + duration*3600000 <= end`; вернуть `[]`, не сетевую ошибку.
- [ ] В `test/risk-time.test.mjs` проверить fixed timestamps: строгое `start==now` отклонено, `start>now` проходит, `end==now+120h` проходит, +1ms/обратный интервал/календарно невозможная дата отклоняются; кандидат `:15` округляется вверх, последний с окончанием ровно на end включён, превышающий end отсутствует, ноль возвращён при слишком коротком диапазоне. Запустить `node --import tsx --test test/risk-time.test.mjs`; ожидание — PASS.

### Этап 2 — локальное ранжирование

- [ ] В `src/risk.ts` определить тип `AssessedWindow` (период + поля `assessRisk`) и чистую функцию `rankWindows`; использовать comparator ранга риска, затем `factors.length`, затем числовой timestamp старта. Каждый кандидат оценивать существующим `assessRisk(hours)`.
- [ ] Создать тесты фиксированных кандидатных оценок в `test/find-safe-weather-window.test.mjs`: сравнить каждый ключ, 0 factors, ранний tie-break, все HIGH с сохранённым победителем/CANCEL, вернуть top-4. Запустить целевой тест через `node --import tsx --test test/find-safe-weather-window.test.mjs`; ожидание — PASS.
- [ ] В этом же тестовом файле добавить генеративный тест без пакетов: PRNG с константным seed порождает минимум 200 наборов различного размера из уникальных timestamps/уровней/factor counts; утверждать (a) победитель не хуже любого элемента по comparator, (b) перестановки одного набора дают того же победителя, (c) каждый сгенерированный период укладывается в search period. Для полностью идентичных ключей допускается любой идентичный кандидат.

### Этап 3 — единственный forecast на поиск

- [ ] В `src/open-meteo.ts` добавить `SafeWindowSearchRequest`, `SafeWindowSearchResult` и метод поиска, отдельный от `assess`. Общий geocoding вынести в приватный helper без изменения его matching/ambiguous/not-found поведения; общий validator hourly response принимать как запрошенный `WorkPeriod`.
- [ ] Метод: получить location один раз; если не однозначен, вернуть существующий discriminated error result до forecast; вызвать forecast ровно раз на координаты; получить весь полный почасовой ряд `[search_start,search_end)` включая внешние крайние часы; для каждого кандидата выбрать часы через `intersectsHour` и вызвать `assessRisk`; после успеха вернуть result с location/source/fetched_at.
- [ ] Не менять cache key/TTL и timestamp semantics действующего `assess`; новому методу можно не добавлять кэш.
- [ ] В `test/open-meteo.test.mjs` добавить фиксированные mocks: однозначный город → геокодирование + ровно 1 forecast; неполный крайний час, даже вне кандидатов → controlled `WeatherDataError`; ambiguous/not-found → forecast count 0; network, timeout, HTTP, invalid JSON, invalid rows → один controlled error без окон. Запустить целевой файл; ожидание — PASS.

### Этап 4 — MCP инструмент и совместимость

- [ ] В `src/index.ts` зарегистрировать `find_safe_weather_window` с `.strict()` input: city trimmed 1..120, enum прежний, даты string, duration integer 1..8.
- [ ] Для даты взять `weatherNow()` ровно один раз и передать этот снимок в поисковый service. Ноль окон вернуть указанной controlled MCP ошибкой до сервисного вызова. Результат формировать без `structuredContent` на любом отказе.
- [ ] Добавить optional interface/проверку наличия метода поиска: legacy injected stub с одним `assess` создаёт сервер и продолжает обслуживать старые инструменты. Если новый tool вызван на таком stub — понятная контролируемая недоступность; само создание сервера не бросает.
- [ ] В `test/mcp-health.test.mjs` проверить schema reject (0,9,1.5, string, bad enum, empty/121-char city, unknown keys), tools/list содержит 4, legacy stub работает. В `compare-weather-windows.test.mjs` обновить только length ожидание, сохранить test равенства как `selected_indices: []`, `tie:true`; добавить проверку прежних payload. Прогнать эти два файла; PASS.

### Этап 5 — документация, регрессия и сдаваемые артефакты

- [ ] В `weather-mcp/README.md` добавить ровно утверждённый JSON schema/пример и описать сортировку, половинчатые границы, пятисуточную проверку, ambiguity/errors, один forecast и смысл `HIGH/CANCEL`.
- [ ] Выполнить целевые тесты командой `node --import tsx --test test/risk-time.test.mjs test/open-meteo.test.mjs test/mcp-health.test.mjs test/compare-weather-windows.test.mjs test/find-safe-weather-window.test.mjs`; ожидание — все целевые тесты PASS.
- [ ] Выполнить `npm run ci`; ожидание — TypeScript build PASS, полный Node test runner PASS. Записать реальные число тестов и команду.
- [ ] Ручной Inspector вызов сделать с датами, полученными как текущий MSK `now + 1h..+6h`, duration `1..2`; сохранить один success и один controlled отказ (например неизвестный город, либо неподдерживаемый stub) без токенов.
- [ ] Создать verification.md с фактическими доказательствами, reflection.md на 5–10 предложений по четырём вопросам, и `prompts/homework-weather-mcp.md` по ЗАДАНИЕ.md. Не вписывать запланированные результаты до выполнения.

## Критерии готовности

- Четыре старых/новый tool перечисляются; для старых схемы/ответы остаются прежними.
- Новая проверка всего интервала выполняется до внешней сети и использует единый `now`; только новый путь требует строгое `search_start > now`.
- Нулевые кандидаты прерываются до геокодирования/forecast; все HIGH всё равно сортируются и возвращают лучший с фактическим `CANCEL`.
- Один успешный поиск делает один geocoding и ровно один forecast; прогноз валидирован на каждый час полного search interval, включая граничные часы вне кандидатов.
- `assessRisk` остаётся единственным источником факторов/порогов; comparator старого `compare_weather_windows` не меняется.
- Дополнительные три инварианта проверяются генеративно фиксированным seed без новой зависимости.
- `npm run ci`, ручные MCP примеры и сдаваемые документы имеют реальные записи; неизвестные/неполные/внешние ошибки не дают частичного результата.

## Откат и approvals

Изменений данных/инфраструктуры нет. Откат — revert только перечисленных source/test/README файлов отдельной ветки. До baseline сначала создать личную копию/ветку и подтвердить исходный diff чистым. Требуется явное одобрение пользователя `implementation-plan-v2.md` прежде любых изменений кода. Предложения v2: строгая граница `search_start > now`, полуоткрытый `[start,end)`, округление первого старта вверх до целого часа, factors=`assessRisk(...).factors.length`, точная схема результата выше, controlled no-candidate error до fetch, возврат лучшего HIGH с `CANCEL`.
