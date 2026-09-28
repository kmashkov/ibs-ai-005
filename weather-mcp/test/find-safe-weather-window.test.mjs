import assert from 'node:assert/strict';
import test from 'node:test';
import { rankSafeWindows } from '../src/risk.ts';

const candidate = (hour, risk, factorCount = 0) => ({
  period: { start: new Date(Date.UTC(2026, 8, 24, hour)), end: new Date(Date.UTC(2026, 8, 24, hour + 1)), duration_hours: 1 },
  risk_level: risk, recommendation: risk === 'HIGH' ? 'CANCEL' : risk === 'MEDIUM' ? 'REVIEW' : 'PROCEED',
  factors: Array.from({ length: factorCount }, (_, index) => ({ time: String(index), metric: 'wind_speed_ms', value: 10, level: 'MEDIUM' }))
});

test('rankSafeWindows covers risk order, factor count, time ties, empty and HIGH candidates', () => {
  assert.deepEqual(rankSafeWindows([candidate(14, 'HIGH'), candidate(13, 'MEDIUM', 2), candidate(12, 'LOW'), candidate(11, 'MEDIUM', 1)]).map((x) => [x.risk_level, x.period.start.getUTCHours()]), [
    ['LOW', 12], ['MEDIUM', 11], ['MEDIUM', 13], ['HIGH', 14]
  ]);
  assert.deepEqual(rankSafeWindows([]), []);
  assert.deepEqual(rankSafeWindows([candidate(14, 'HIGH'), candidate(13, 'HIGH')]).map((x) => x.recommendation), ['CANCEL', 'CANCEL']);
});

test('deterministic randomized oracle checks winner, permutation stability and candidate containment', async () => {
  const { buildCandidatePeriods } = await import('../src/time.ts');
  let seed = 0x51afe;
  const random = (max) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  for (let sample = 0; sample < 240; sample++) {
    const start = Date.UTC(2026, 8, 24, random(20));
    const span = 1 + random(30);
    const duration = 1 + random(8);
    const period = { start: new Date(start + random(60) * 60_000), end: new Date(start + span * 3_600_000) };
    const actual = buildCandidatePeriods(period, duration);
    for (const window of actual) {
      assert.ok(window.start.getTime() >= period.start.getTime());
      assert.ok(window.end.getTime() <= period.end.getTime());
      assert.equal(window.start.getUTCMinutes(), 0);
      assert.equal(window.start.getUTCSeconds(), 0);
    }
    const scored = actual.map((candidate) => ({
      period: candidate,
      risk_level: ['LOW', 'MEDIUM', 'HIGH'][random(3)],
      recommendation: 'PROCEED',
      factors: Array.from({ length: random(5) }, () => ({}))
    }));
    const expected = [...scored].sort((a, b) => rank[a.risk_level] - rank[b.risk_level] || a.factors.length - b.factors.length || a.period.start - b.period.start);
    const shuffled = [...scored];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const other = random(index + 1);
      [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
    }
    const permutations = [scored, [...scored].reverse(), shuffled];
    for (const permutation of permutations) {
      assert.deepEqual(rankSafeWindows(permutation), expected);
    }
  }
});

test('independent ordering oracle distinguishes risk, factor count, earlier start and exclusive boundary', async () => {
  const badRisk = [candidate(10, 'HIGH'), candidate(11, 'LOW')];
  assert.equal(rankSafeWindows(badRisk)[0].risk_level, 'LOW');
  const badFactors = [candidate(10, 'MEDIUM', 2), candidate(11, 'MEDIUM', 0)];
  assert.equal(rankSafeWindows(badFactors)[0].factors.length, 0);
  const early = [candidate(11, 'LOW'), candidate(10, 'LOW')];
  assert.equal(rankSafeWindows(early)[0].period.start.getUTCHours(), 10);
  const { buildCandidatePeriods } = await import('../src/time.ts');
  assert.equal(buildCandidatePeriods({ start: new Date('2026-09-24T10:15:00Z'), end: new Date('2026-09-24T11:00:00Z') }, 1).length, 0);
  assert.equal(buildCandidatePeriods({ start: new Date('2026-09-24T10:00:00Z'), end: new Date('2026-09-24T11:00:00Z') }, 1).length, 1);
});

test('MCP handler validates a whole future search once and optional search stubs fail cleanly', async () => {
  const { createServer } = await import('../src/index.ts');
  const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
  const fixedNow = new Date('2026-09-24T12:00:00.000Z');
  const success = { kind: 'success', checked_candidates: 1, city: { name: 'Dubai', country: 'UAE', timezone: 'Asia/Dubai' },
    input_timezone: 'Europe/Moscow', window_timezone: 'Europe/Moscow', factor_timezone: 'UTC', source: 'Open-Meteo', fetched_at: '2026-09-24T12:00:01.000Z',
    selected: { start_at: '2026-09-24T16:00', end_at: '2026-09-24T17:00', duration_hours: 1, risk_level: 'LOW', recommendation: 'PROCEED', factors: [] }, alternatives: [] };
  const serve = async (riskService, callback, clock = () => fixedNow) => {
    const server = createServer(riskService, { now: clock, fetchImpl: async () => { throw new Error('unexpected fetch'); }, logger: { error() {} } });
    const client = new Client({ name: 'window-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try { await server.connect(serverTransport); await client.connect(clientTransport); await callback(client); }
    finally { await client.close(); await server.close(); }
  };
  const valid = { city: 'Dubai', work_type: 'inspection', search_start: '2026-09-24T16:00', search_end: '2026-09-24T17:00', duration_hours: 1 };
  let calls = 0;
  let nowReads = 0;
  await serve({ assess: async () => ({ kind: 'assessment' }), findSafeWeatherWindow: async (request) => {
    calls++;
    assert.equal(request.period.start.toISOString(), '2026-09-24T13:00:00.000Z');
    assert.equal(request.candidates.length, 1);
    return success;
  } }, async (client) => {
    const result = await client.callTool({ name: 'find_safe_weather_window', arguments: valid });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.selected.start_at, success.selected.start_at);
    assert.equal(JSON.stringify(result.structuredContent).includes('"period"'), false);
    for (const duration of [0, 1.5, 9]) {
      const invalid = await client.callTool({ name: 'find_safe_weather_window', arguments: { ...valid, duration_hours: duration } });
      assert.equal(invalid.isError, true);
      assert.equal(invalid.structuredContent, undefined);
    }
    assert.equal((await client.listTools()).tools.length, 4);
  }, () => { nowReads++; return fixedNow; });
  assert.equal(calls, 1);
  assert.equal(nowReads, 1, 'valid schema input takes a single request clock snapshot');
  await serve({ assess: async () => ({ kind: 'assessment' }) }, async (client) => {
    const unavailable = await client.callTool({ name: 'find_safe_weather_window', arguments: valid });
    assert.equal(unavailable.isError, true);
    assert.equal(unavailable.content[0].text, 'Поиск погодных окон недоступен в подключённом погодном сервисе.');
    assert.equal(unavailable.structuredContent, undefined);
    assert.equal((await client.listTools()).tools.length, 4);
    const noCandidates = await client.callTool({ name: 'find_safe_weather_window', arguments: { ...valid, search_end: '2026-09-24T16:30' } });
    assert.equal(noCandidates.content[0].text, 'В указанном интервале нет допустимых погодных окон.');
  });
});
