# HW-WEATHER-MASHKOV

# Weather MCP 2.0 — план реализации v2

**Цель:** добавить `find_safe_weather_window`: проверить весь московский поисковый интервал, получить один полный почасовой forecast, ранжировать в нём допустимые окна существующими правилами риска и вернуть выбранное окно с максимум тремя альтернативами.

**Решение:** расширить `OpenMeteoRiskService` отдельным методом поиска, не меняя `assess`, старый resolver или три существующих MCP-контракта. Для нового пути использовать строгий resolver по точному имени города и всем введённым уточнениям; после одного forecast оценивать кандидаты через `assessRisk`. Даты тестов фиксировать, реальные ручные примеры каждый раз вычислять от текущего времени.

**Файлы реализации:** `weather-mcp/src/{index,time,open-meteo,risk}.ts`, тесты `weather-mcp/test/{risk-time,open-meteo,mcp-health,compare-weather-windows,find-safe-weather-window}.test.mjs`, `weather-mcp/README.md`; итоговые доказательства — `artifacts/HW-WEATHER-MASHKOV/verification.md`, `reflection.md`, главный промпт — `prompts/homework-weather-mcp.md`. Новых пакетов не добавлять.

## Зафиксированные типы и контракты

В `src/time.ts` определить и экспортировать:

```ts
export interface SearchPeriod { start: Date; end: Date }
export interface CandidatePeriod { start: Date; end: Date; duration_hours: number }
export function parseSearchPeriod(searchStart: string, searchEnd: string, now: Date): SearchPeriod;
export function buildCandidatePeriods(period: SearchPeriod, durationHours: number): CandidatePeriod[];
```

`parseSearchPeriod` использует формат и календарную проверку `YYYY-MM-DDTHH:mm` MSK UTC+3 как `parseWorkPeriod`, но требует `start > now`, `end > start`, `end <= now + 120h`. Старый `parseWorkPeriod` и его нижняя граница `start >= now` остаются без изменений. `buildCandidatePeriods` трактует поиск как полуоткрытый `[start,end)`, вычисляет первый старт `ceil(startEpoch / 3600000) * 3600000`, далее шаг 3600000 ms; включает кандидат, если его end равен `search_end`.

В `src/open-meteo.ts` определить request/result/service capability типы. В `src/risk.ts` определить внутренний тип и ranking API:

```ts
export interface SafeWindowSearchRequest {
  city: string;
  work_type: "maintenance" | "installation" | "inspection";
  search_start: string;
  search_end: string;
  duration_hours: number;
  period: SearchPeriod; // полный разобранный [start,end), включая часы вне candidates
  candidates: CandidatePeriod[];
}
export interface SafeWindow {
  start_at: string; end_at: string; // MSK YYYY-MM-DDTHH:mm, end exclusive
  duration_hours: number;
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  recommendation: "PROCEED" | "REVIEW" | "CANCEL";
  factors: RiskFactor[]; // time внутри каждого RiskFactor остаётся ISO UTC
}
// src/risk.ts; внутренний Date-bearing тип, никогда не сериализовать напрямую
export interface AssessedCandidate {
  period: CandidatePeriod;
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  recommendation: "PROCEED" | "REVIEW" | "CANCEL";
  factors: RiskFactor[];
}
export function rankSafeWindows(windows: AssessedCandidate[]): AssessedCandidate[];
export interface SafeWindowSearchSuccess {
  kind: "success";
  checked_candidates: number;
  city: { name: string; region?: string; country: string; timezone: string };
  input_timezone: "Europe/Moscow";
  window_timezone: "Europe/Moscow";
  factor_timezone: "UTC";
  source: "Open-Meteo";
  fetched_at: string; // ISO UTC, clock snapshot после ответа forecast
  selected: SafeWindow;
  alternatives: SafeWindow[]; // от 0 до 3
}
export type SafeWindowSearchResult = SafeWindowSearchSuccess
  | { kind: "not_found"; message: string }
  | { kind: "ambiguous"; message: string; options: Array<{ city: string; region?: string; country: string; location_id?: number }> };
export interface SafeWindowSearchCapability {
  findSafeWeatherWindow(request: SafeWindowSearchRequest): Promise<SafeWindowSearchResult>;
}
export interface RiskServiceWithOptionalSearch {
  assess(request: RiskRequest): Promise<RiskResult>;
  findSafeWeatherWindow?: SafeWindowSearchCapability["findSafeWeatherWindow"];
}
```

`OpenMeteoRiskService.findSafeWeatherWindow(request)` получает проверенный handler-ом полный `period: SearchPeriod` и candidates; повторно время не валидирует и clock не читает. Forecast validator использует весь `request.period`. Для ranking использовать внутренний `AssessedCandidate {period: CandidatePeriod, risk_level, recommendation, factors}` и `rankSafeWindows(windows: AssessedCandidate[]): AssessedCandidate[]`, сравнивая `period.start.getTime()`. Перед ответом явно спроецировать в публичный `SafeWindow` только JSON-поля `start_at`, `end_at`, `duration_hours`, `risk_level`, `recommendation`, `factors`; `Date` и `period` не попадают в structuredContent. Риск берётся исключительно из `assessRisk(hours)`; сортировка по риску, `factors.length`, затем `period.start`.

Схема нового MCP-входа — strict object: `city` trim 1..120, `work_type` enum из трёх действующих типов, две строки времени, `duration_hours` integer 1..8. В handler взять один `requestNow = weatherNow()`; вызвать `parseSearchPeriod`, затем `buildCandidatePeriods`; пустой список немедленно вернуть `{isError:true}`, текст `В указанном интервале нет допустимых погодных окон.`, без `structuredContent` и без сетевых вызовов. Для legacy injected service с `{assess(...)}` новый tool остаётся зарегистрированным, но его вызов возвращает `{isError:true}`, текст `Поиск погодных окон недоступен в подключённом погодном сервисе.`, без `structuredContent`, не вызывая fetch/методы отсутствующей capability. Старые инструменты продолжают обращаться только к `assess`.

Успешный ответ имеет указанные поля `SafeWindowSearchSuccess`; `selected` — первый отсортированный, `alternatives` — следующие до трёх. Если все окна HIGH, всё равно вернуть лучший и оставить `recommendation: "CANCEL"`. Ошибки любого этапа не возвращают частичные окна или `structuredContent`. Handler читает `requestNow` единожды для parse/build и передаёт сервису готовый period. Сервис читает собственный внедрённый clock один раз для `fetched_at` только после успешного получения и проверки forecast; при ошибке timestamp/result не возвращаются.

## Геокодинг, прогноз и границы

Старый `assess` сохраняет прежний fuzzy fallback, включая текущий выбор единственного кандидата, если exact name отсутствует. Новый `findSafeWeatherWindow` использует отдельный resolver, построенный на `parseLocations` и текущих normalization helpers, но не fallback: запрос разбирается на имя и запятые-qualifiers; candidate должен иметь нормализованное точное равенство `location.name` с именем и удовлетворять каждому qualifier равенством `admin1` или `country`. Ноль точных кандидатов — `not_found`, один — продолжить, больше одного — `ambiguous` с максимум пятью вариантами. Недоверенное приблизительное совпадение никогда не становится прогнозируемым городом.

После ровно одного geocoding отправить один forecast URL с параметрами: `hourly=temperature_2m,precipitation_probability,wind_speed_10m`, `wind_speed_unit=ms`, `timezone=UTC`, **явно `forecast_days=6`**. Шесть UTC календарных дней покрывают любой интервал до `now+120h`: максимальный интервал в 120 часов плюс неполный граничный UTC час укладывается в окно шести суток, если forecast выдаёт текущий UTC день и следующие пять. Повторно использовать текущие timeout/error/row validators, расширив period validation на полный `[search_start,search_end)`: требовать каждый час `[floor(start/hour), ceil(end/hour))`, включая граничные часы, которые ни один candidate не оценивает. Недостающий крайний час — controlled `WeatherDataError`, без результата. `fetched_at` снимается внедрённым service clock только после успешного forecast response+validation. Новый кэш не нужен; старый cache behavior и timestamp не трогать.

## Порядок работ

### Этап 0 — после одобрения: личная копия и baseline

- [ ] Работать в отдельной личной ветке/копии, не в общей демонстрационной папке. Перед кодом зафиксировать `git status --short` и идентификатор baseline.
- [ ] Из `weather-mcp/` выполнить `npm run ci`; сохранить точную команду, выходной статус и реальные build/test counts в change-set/будущий verification. Если baseline не проходит, остановить реализацию до разрешения причины; не объявлять его успешным.

### Этап 1 — время и production generator

- [ ] В `src/time.ts` добавить `SearchPeriod`, `CandidatePeriod`, `parseSearchPeriod` и `buildCandidatePeriods` ровно с сигнатурами выше. Вынести только низкоуровневую проверку календарной строки в общий helper при условии, что сообщения и поведение `parseWorkPeriod` не меняются.
- [ ] Добавить фиксированные тесты в `test/risk-time.test.mjs`: `start == now` отвергается новым parser-ом, но существующий `parseWorkPeriod` принимает равное начало; upper bound ровно `now+120h` проходит; неверная дата, обратный/нулевой интервал, next minute за границей не проходят; candidate округляется вверх с `:15`, полный кандидат на точном end включается, следующий исключается.
- [ ] Граничный публичный тест использовать минутную точность. Например `now=2026-09-24T12:00:00.000Z`; `search_end=2026-09-29T15:00` (MSK) ровно равен `now+120h` и проходит, а `2026-09-29T15:01` позже на 60 минут и отклоняется. Если тестируется внутреннее сравнение `Date`, назвать его отдельным unit test и не приписывать миллисекундный вход MCP.
- [ ] Запустить `node --import tsx --test test/risk-time.test.mjs` из `weather-mcp`; ожидание — целевой файл PASS, включая прежние временные проверки.

### Этап 2 — ranking и независимый generator oracle

- [ ] В `src/risk.ts` экспортировать `AssessedCandidate` и реализовать `rankSafeWindows` с точной сигнатурой выше. Тип опирается на `CandidatePeriod` из `src/time.ts`, не импортируется из `open-meteo.ts`; comparator используется только новым search путём. Перенести в candidate поля `assessRisk`, не копируя пороги.
- [ ] Создать `test/find-safe-weather-window.test.mjs`. Зафиксировать примеры с LOW/MEDIUM/HIGH, factors count, start tie-break, 0/1/3/4+ кандидатами, пустыми factors и всеми HIGH/CANCEL.
- [ ] Добавить deterministic seeded PRNG без пакетов, не менее 200 случаев. Для ranking expected winner считать отдельной тестовой функцией, не импортирующей `rankSafeWindows`, буквально сравнением ключа `(riskRank, factors.length, start timestamp)`. Сравнить его с production ranking и с минимум двумя перестановками того же массива оценок. Для containment PRNG генерирует валидные search interval и duration, вызывает production `buildCandidatePeriods`, затем проверяет каждый выданный `[start,end)` против исходного интервала и часовой сетки. Включить конкретные отрицательные образцы для перепутанного risk order, перепутанного factor order, раннего старта и окна ровно/чуть за границей; коротко проверить тестовую чувствительность временной локальной мутацией comparator/boundary и сразу вернуть mutation, не сохраняя дефект.
- [ ] Запустить `node --import tsx --test test/find-safe-weather-window.test.mjs`; ожидание — все примеры и seeded cases PASS.

### Этап 3 — Open-Meteo поиск

- [ ] В `src/open-meteo.ts` добавить опубликованные request/result/capability типы, `findSafeWeatherWindow(request)` и новый strict exact resolver. Не менять текущий resolver в `assess`.
- [ ] Request несёт полный `period: SearchPeriod` и candidates; метод передаёт period в forecast validator, делает один UTC URL с `forecast_days=6`, оценивает candidates через `assessRisk`, ранжирует внутренние `AssessedCandidate`, затем проецирует в JSON-only `SafeWindow`. Окна форматируются как MSK строки, факторы сохраняют UTC ISO.
- [ ] В `test/open-meteo.test.mjs` зафиксировать: (a) typo `Dubia, United Arab Emirates` при единственном похожем `Dubai` даёт not_found и 0 forecast; (b) точное имя + qualifiers выбирает точную локацию; (c) qualifier mismatch not_found; (d) несколько exact matches ambiguous; (e) пустая выдача not_found; (f) исходный `assess` остаётся с прежним fuzzy fallback (проверить прежний контракт отдельно).
- [ ] Тест полного горизонта: `requestNow=2026-09-24T22:30:00.000Z`, `search_start=2026-09-29T20:15` MSK, `search_end=2026-09-30T01:30` MSK (= `2026-09-29T22:30Z`, ровно +120h), `duration_hours=2`. Последний candidate заканчивается в 22:00Z, поэтому час 22:00Z лежит в поиске, но вне всех окон. Mock с ним проходит; удаление именно `2026-09-29T22:00Z` даёт controlled error. Проверить UTC/`forecast_days=6` и ровно один forecast.
- [ ] Добавить clock test: handler request clock даёт `requestNow`, затем после успешного ответа service clock даёт отличное значение `fetched_at`; доказать, что поиск валидирован по первому снимку, response содержит второе, а при forecast failure `structuredContent` отсутствует.
- [ ] Прогнать `node --import tsx --test test/open-meteo.test.mjs`; ожидание — PASS, включая timeout, bad JSON, malformed и incomplete rows.

### Этап 4 — MCP handler и совместимость

- [ ] В `src/index.ts` типизировать `createServer` с обязательным legacy `assess` и optional `findSafeWeatherWindow(request)`; default остаётся `OpenMeteoRiskService`. Capability проверять только в handler нового tool. После схемы взять `requestNow = weatherNow()` один раз, выполнить parse/build и передать сервису request с разобранным полным `period`; сервис не получает now и не перепроверяет границы своим clock.
- [ ] Тестировать один legacy stub `{assess}` через MCP: он создаёт server; `get_weather` и `assess_weather_risk` обслуживаются тем же stub/зависимостями; вызов нового tool даёт `isError:true`, ровно утверждённое сообщение, нет `structuredContent`, нет необработанного исключения и сетевых вызовов. Не встраивать этот тестовый сценарий в реальный продуктовый поток.
- [ ] В `test/compare-weather-windows.test.mjs` обновить exact tools list с сохранением всех трёх старых имён + нового.
- [ ] В `test/mcp-health.test.mjs` обновить exact tools list и все три существующие post-call length assertions (после ошибки: строки текущих проверок для нормального error, malformed date и повторяемых внешних ошибок) до полного состава из четырёх; предпочтительно на каждой точке сверять массив имён, либо оставить length assertion дополнительно к exact assertion. Добавить проверки нового tool invalid duration 0 и schema cases; после ошибки инструменты остаются доступны.
- [ ] Запустить `node --import tsx --test test/mcp-health.test.mjs test/compare-weather-windows.test.mjs`; ожидание — PASS, exact tool name assertions и старый compare tie/payload сохранены.

### Этап 5 — README, полный CI и реальная ручная проверка

- [ ] Обновить `weather-mcp/README.md`: аргументы, MSK input, `search_start > now`, `[start,end)`, округление старта, полный 120-hour interval, точный resolver нового tool, схема результата с MSK/UTC timezone полями, comparator, HIGH/CANCEL, no candidates и ошибки без частичного payload. Пример дат пометить как образец, который надо пересчитать для запуска.
- [ ] Из `weather-mcp/` запустить `npm run ci`; ожидание — TypeScript build и весь Node test suite PASS. Записать из фактического лога команды/код возврата/число тестов; не переносить ожидаемое число до реального запуска.
- [ ] Только после успешного build запустить `npm run inspect` (скрипт вызывает `node dist/index.js`). Динамически вычислить две MSK даты на момент ручного запуска: успех — окно начинается через 1–2 часа и заканчивается не позже `now+120h`, duration 1–2; отказ — тот же допустимый интервал, но `duration_hours: 0`, ожидается schema error до сети. Выполнить оба вызова через Inspector и сохранить фактические аргументы, ответы/ошибки, timestamp проверки и известные ограничения в `verification.md`; никаких секретов.
- [ ] Создать `reflection.md` на 5–10 предложений по четырём вопросам ЗАДАНИЕ.md и `prompts/homework-weather-mcp.md` с целью, ограничениями, критериями, артефактами, командами и запретом менять старые контракты.

### Этап 6 — роли после одобрения

- [ ] После явного одобрения v2 передать реализацию роли **Builder** по утверждённой области; Builder делает изменения и целевые тесты/CI, пишет change-set.
- [ ] По завершении Builder передать независимую проверку роли **Tester**: сверить acceptance matrix, выполнить недостающие/повторяемые тесты и записать реальные результаты; Tester не меняет продуктовые исходники без возврата Builder.
- [ ] После Tester передать diff, спецификацию и фактические доказательства роли **Reviewer** для независимой проверки; замечания закрываются последовательно до VERIFIED.

## Таблица закрытия замечаний Critic v1

| ID | Решение v2 | Где реализовать/описать | Проверка |
|---|---|---|---|
| CRIT-01 | Новый путь имеет отдельный exact resolver (имя + каждый qualifier); старый fuzzy fallback `assess` неизменен | Геокодинг, этап 3 | typo с одним похожим результатом отказывает до forecast; exact, qualifier, ambiguous, empty; legacy assess regression |
| CRIT-02 | Optional capability `findSafeWeatherWindow(request)`; request несёт parsed full `period: SearchPeriod` и candidates | Типы/этап 4 | build; MCP вызов настоящего сервиса и assess-only stub |
| CRIT-03 | Один handler `requestNow` для parse/build; отдельный service clock вызывается для `fetched_at` только после успешного forecast | Контракты/этапы 3–4 | различающиеся последовательные clock reads; failure без результата |
| CRIT-04 | Явный `forecast_days=6`, UTC, hourly variables/ms; validator принимает полный period | Прогноз/этап 3 | `start=2026-09-29T20:15` MSK, `end=2026-09-30T01:30`, duration 2 оставляют час 22:00Z вне candidates; его отсутствие — controlled failure |
| CRIT-05 | Публичные тесты ограничены минутным форматом: ровно +120h и ближайшая следующая минута +60m; миллисекунды — только отдельный внутренний Date test | Этап 1 | фиксированные computed timestamps; никакого фиктивного MSK string с миллисекундами |
| CRIT-06 | Независимый тестовый oracle; containment проверяет выдачу production generator; фиксированный seed + негативные примеры | Этап 2 | 200+ наборов и перестановок; локальная transient mutation чувствительности comparator/boundary |
| CRIT-07 | Новый tool на `{assess}` даёт строго заданную controlled unavailable ошибку без payload и сети; старые инструменты доступны | Этап 4 | MCP test вызывает старые инструменты и новый на одном stub |
| CRIT-08 | Все 5 текущих tools/list assertions обновляются: exact list в compare и mcp-health, три числовых length в mcp-health | Этап 4 | после каждого invalid/error вызова проверяются имена трёх старых плюс новый; целевые два тестовых файла |
| CRIT-09 | Последовательность воспроизводима: `npm run ci`, затем `npm run inspect`; Inspector реально вызывается с динамическими датами success и duration=0 refusal | Этап 5 | verification содержит фактические inputs, output/error, время и ограничения |

## Сводная матрица требований → шаги

| Требование | Этап / тест |
|---|---|
| Весь поиск future и в пределах 120h; строгий `start > now` только новый путь | 1; `risk-time.test.mjs`; старый parser regression |
| duration integer 1..8, schema strict, enum/city | 4; `mcp-health.test.mjs` |
| Целые MSK часовые candidates внутри `[start,end)`; no candidates до сети | 1 и 4; `risk-time.test.mjs`, `mcp-health.test.mjs` |
| Один forecast на полный search, включая часы вне кандидатов | 3; `open-meteo.test.mjs` |
| Геокодинг exact; неизвестный/ambiguous не выбирается | 3; `open-meteo.test.mjs` |
| Риск через `assessRisk`, ранжирование risk/factors/start | 2; independent oracle tests |
| Лучший HIGH также возвращается с CANCEL | 2; `find-safe-weather-window.test.mjs` |
| Успешная стабильная structuredContent и ошибки без partial result | типы и этапы 3–4; service/MCP tests |
| Старые три инструмента и compare tie неизменны | 4; все пять tools/list assertions + regression tests |
| README, CI, Inspector, verification, reflection, prompt | 5 |
| Дополнительные три генеративных инварианта без dependency | 2 |

## Согласование и статус

Проектные решения для явного одобрения:

1. Строго `search_start > requestNow` только для нового tool; весь search interval ограничен `requestNow + 120h`.
2. Кандидаты и forecast используют полуоткрытый `[start,end)`; первый целый MSK час округляется вверх.
3. Для нового resolver принимать только точные city-name/qualifier matches; старый fuzzy fallback остаётся для старых инструментов.
4. Stable response содержит `selected`, `alternatives`, `checked_candidates`, `city`, `source`, `fetched_at`, явные `input_timezone/window_timezone/factor_timezone`.
5. Ранжирование использует `assessRisk(...).factors.length`; ноль candidates — controlled ошибка до сети; все HIGH — лучший с `CANCEL`.
6. Один явный `forecast_days=6` UTC запрос; отсутствие любого часа полного search interval — controlled отказ.

После одобрения выполняются отдельная личная ветка/копия и baseline `npm run ci`; затем роли Builder → Tester → Reviewer. Пока статус `ANALYZED`, approval `pending`; исходники не изменяются.
