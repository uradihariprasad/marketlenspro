import {
  pgTable,
  text,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  serial,
  index,
} from "drizzle-orm/pg-core";

/**
 * Persistent storage for the F&O intelligence system.
 *
 * Provenance notes:
 *  - `settings` holds server-side secrets (Upstox access token). The token is
 *    NEVER select-exposed through any API route; routes only read it on the
 *    server. Frontend receives only a boolean connection status.
 *  - `oi_snapshots` stores timestamped futures/option OI snapshots so that
 *    "change in OI" is always computed against an explicitly defined
 *    reference time (tag = SESSION_REF for the session's first snapshot).
 *  - `zones` / `signals` / `alerts` are the audit trail for the S/R engine
 *    and the trade-decision engine (rule 14: every signal traceable).
 */

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const oiSnapshots = pgTable(
  "oi_snapshots",
  {
    id: serial("id").primaryKey(),
    instrumentKey: text("instrument_key").notNull(),
    kind: text("kind").notNull(), // 'FUT' | 'OPT'
    underlyingKey: text("underlying_key"),
    expiry: text("expiry"),
    strike: doublePrecision("strike"),
    optionType: text("option_type"), // 'CE' | 'PE' | null
    oi: doublePrecision("oi"),
    volume: doublePrecision("volume"),
    ltp: doublePrecision("ltp"),
    tag: text("tag").notNull(), // 'SESSION_REF' | 'LIVE'
    sessionDate: text("session_date").notNull(), // YYYY-MM-DD (IST)
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("oi_snap_key_idx").on(t.instrumentKey, t.sessionDate, t.tag)]
);

export const zones = pgTable(
  "zones_table",
  {
    id: text("id").primaryKey(), // stable engine-zone id
    instrumentKey: text("instrument_key").notNull(),
    timeframeMin: integer("timeframe_min").notNull(),
    side: text("side").notNull(), // 'SUPPORT' | 'RESISTANCE' | 'BOTH'
    lower: doublePrecision("lower").notNull(),
    upper: doublePrecision("upper").notNull(),
    mid: doublePrecision("mid").notNull(),
    provenanceGroup: text("provenance_group").notNull(), // 'STRUCTURAL' | 'OI_CANDIDATE'
    confirmationStatus: text("confirmation_status").notNull(), // 'CANDIDATE' | 'CONFIRMED'
    state: text("state").notNull(),
    score: doublePrecision("score").notNull(),
    breakdown: jsonb("breakdown").notNull(),
    sources: jsonb("sources").notNull(),
    invalidation: doublePrecision("invalidation"),
    sessionDate: text("session_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("zones_key_idx").on(t.instrumentKey, t.sessionDate)]
);

export const signals = pgTable(
  "signals",
  {
    id: text("id").primaryKey(),
    instrumentKey: text("instrument_key").notNull(),
    timeframeMin: integer("timeframe_min").notNull(),
    direction: text("direction").notNull(), // 'LONG' | 'SHORT'
    scenario: text("scenario").notNull(),
    status: text("status").notNull(), // 'WATCH' | 'ACTIVE' | 'INVALIDATED' | 'EXPIRED'
    entry: doublePrecision("entry"),
    stop: doublePrecision("stop"),
    targets: jsonb("targets").notNull(),
    rr: doublePrecision("rr"),
    score: doublePrecision("score").notNull(),
    breakdown: jsonb("breakdown").notNull(),
    trace: jsonb("trace").notNull(),
    capabilityTags: jsonb("capability_tags").notNull(),
    dataQuality: text("data_quality").notNull(),
    sessionDate: text("session_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("signals_session_idx").on(t.sessionDate)]
);

export const alerts = pgTable(
  "alerts",
  {
    id: serial("id").primaryKey(),
    level: text("level").notNull(), // 'INFO' | 'WARN' | 'ERROR'
    message: text("message").notNull(),
    context: jsonb("context"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("alerts_created_idx").on(t.createdAt)]
);
