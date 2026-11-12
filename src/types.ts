export interface Env {
  DB: D1Database;
  SAUNA: DurableObjectNamespace<import('./sauna').SaunaDO>;
  ASSETS: Fetcher;

  HARVIA_MOCK: string;
  HARVIA_UNITS: string;
  HARVIA_DEVICE_ID: string;
  HARVIA_CABIN: string;
  MOCK_SPEED: string;
  VAPID_SUBJECT: string;

  OWNER_PASSPHRASE: string;
  SESSION_SECRET: string;
  HARVIA_USERNAME: string;
  HARVIA_PASSWORD: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
}

export interface Settings {
  bakeoutMin: number;
  bakeoutF: number;
  ratePerKwh: number;
  cookieDays: number;
  /** Shown to friends: "Benjy got a notification". */
  ownerName: string;
  /** "Gentle Reminders" shown to friends after they put their name down. */
  reminders: string[];
  /** For times in the owner's push notifications (Workers run in UTC). */
  timeZone: string;
}

export const DEFAULT_SETTINGS: Settings = {
  bakeoutMin: 30,
  bakeoutF: 194,
  ratePerKwh: 0.15,
  cookieDays: 30,
  ownerName: 'Benjy',
  reminders: [
    'Rinse off before you get in.',
    'Sit on a towel.',
    'Bring water and drink it.',
    'Keep the door shut so the heat stays in.',
    'Get out if you feel dizzy, and cool down slowly.',
  ],
  timeZone: 'America/Los_Angeles',
};

export const HEATER_KW = 9;
