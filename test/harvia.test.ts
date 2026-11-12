import { describe, expect, it } from 'vitest';
import { parseReading } from '../src/harvia';

const cToF = (c: number) => (c * 9) / 5 + 32;

// Trimmed from the owner's real FX45 (Nov 2026), location removed.
const state = {
  deviceId: '00000000-aaaa-4bbb-8ccc-000000000001',
  shadowName: 'C1',
  state: {
    displayName: 'Sauna',
    heater: { on: 0, state: 0 },
    settings: { maxOnTime: 60, maxTemp: 90, remoteControl: 'on' },
    profiles: { '3': { name: '', targetTemp: 80, targetHum: 20, duration: 30, heater: { on: 1 } } },
    activeProfile: 3,
    saunaStatus: 0,
    targetTemp: 80,
    targetHum: 10,
  },
  connectionState: { connected: true, updatedTimestamp: 1794000406338 },
};
const latest = {
  deviceId: '00000000-aaaa-4bbb-8ccc-000000000001',
  data: { temp: 18, hum: 0, heatOn: 0, targetTemp: 80, panelTemp: 20 },
};

describe('parseReading (real FX45 payload)', () => {
  it('reads temperature, target and limits in °F', () => {
    const r = parseReading(state, latest, cToF);
    expect(r.connected).toBe(true);
    expect(r.tempF).toBeCloseTo(64.4);
    expect(r.targetF).toBe(176);
    expect(r.heaterOn).toBe(false);
    expect(r.humidity).toBeNull(); // 0 = no sensor
    expect(r.controllerMaxOnMin).toBe(60);
    expect(r.profileDurationMin).toBe(30);
  });

  it('reads heater.on as the session switch, not the cycling element', () => {
    const on = { ...state, state: { ...state.state, heater: { on: 1, state: 1 } } };
    const r = parseReading(on, { data: { ...latest.data, heatOn: 0 } }, cToF);
    expect(r.heaterOn).toBe(true);
  });

  it('reads the auto-off countdown and controller estimate while running', () => {
    // Two minutes into the first real session: autoOffTime had dropped 60 → 58 during preheat.
    const on = { ...state, state: { ...state.state, heater: { on: 1, state: 0 } } };
    const r = parseReading(on, { data: { ...latest.data, heatOn: 1, autoOffTime: 58, timeToTarget: 60 } }, cToF);
    expect(r.autoOffMin).toBe(58);
    expect(r.controllerEtaMin).toBe(60);
  });

  it('ignores the auto-off countdown when the heater is off', () => {
    const r = parseReading(state, { data: { ...latest.data, autoOffTime: 60 } }, cToF);
    expect(r.autoOffMin).toBeNull();
  });

  it('reads whether the element is energized right now (for cost)', () => {
    const on = { ...state, state: { ...state.state, heater: { on: 1, state: 0 } } };
    expect(parseReading(on, { data: { ...latest.data, heatOn: 1 } }, cToF).elementOn).toBe(true);
    expect(parseReading(on, { data: { ...latest.data, heatOn: 0 } }, cToF).elementOn).toBe(false);
    const { heatOn, ...noHeat } = latest.data as any;
    expect(parseReading(on, { data: noHeat }, cToF).elementOn).toBeNull();
  });
});
