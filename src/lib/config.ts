type Env = Record<string, string | undefined>;

const num = (v: string | undefined, d: number) => (v === undefined || v.trim() === "" ? d : Number(v));
const numOrNull = (v: string | undefined, d: number | null) =>
  v === undefined ? d : v.trim() === "" ? null : Number(v);
const pick = <T extends string>(v: string | undefined, allowed: readonly T[], d: T): T =>
  (allowed as readonly string[]).includes(v ?? "") ? (v as T) : d;

export interface Config {
  modelAgent: string;
  modelClassifier: string;
  effortClassifier: string | null;
  effortAgent: string | null;
  prices: {
    classifierInPerMtok: number;
    classifierOutPerMtok: number;
    agentInPerMtok: number;
    agentOutPerMtok: number;
    voicePerMinInr: number;
    usdToInr: number;
  };
  /** Average project value range (INR) the cost panel compares against. Spec figure: Rs 8-14 lakh (an open question). */
  avgProjectValueInr: { low: number; high: number };
  // Open-question switches. See CHANGELOG.md.
  declineRule: "one_hard_fail" | "two_criteria";
  leadTimeHardMinWeeks: number;
  leadTimeTightUnderWeeks: number;
  commercialMinSqft: number | null;
  /** OPEN: a complaint from a caller who already has a lead note also sends the updated lead note to designers. */
  escalatedRepeatAlsoNotes: boolean;
  unlistedLocalityAction: "forward_with_flag" | "ask_one_question";
  booking: { enabled: boolean; provider: "internal" | "calcom"; slotMinutes: number; daysAhead: number; minNoticeHours: number; capacity: number; mode: string };
  calcom: { apiKey: string; eventTypeId: number | null; timeZone: string; attendeeEmail: string };
  hubspot: { token: string; createDeal: boolean };
  firstContactOfficeMinutes: number;
  afterHoursDeadline: string; // HH:MM local
  escalationCallbackOfficeMinutes: number;
  officeOpenHour: number;
  officeCloseHour: number;
  officeDays: number[]; // 0=Sun
  tzName: string;
  tzOffsetMinutes: number;
  appBaseUrl: string;
}

export function getConfig(env: Env = process.env): Config {
  const effort = (v: string | undefined, d: string) => (v === undefined ? d : v.trim() === "" ? null : v.trim());
  return {
    modelAgent: env.MODEL_AGENT ?? "",
    modelClassifier: env.MODEL_CLASSIFIER ?? "",
    effortClassifier: effort(env.EFFORT_CLASSIFIER, "low"),
    effortAgent: effort(env.EFFORT_AGENT, "low"),
    prices: {
      classifierInPerMtok: num(env.PRICE_INPUT_PER_MTOK_CLASSIFIER, 0),
      classifierOutPerMtok: num(env.PRICE_OUTPUT_PER_MTOK_CLASSIFIER, 0),
      agentInPerMtok: num(env.PRICE_INPUT_PER_MTOK_AGENT, 0),
      agentOutPerMtok: num(env.PRICE_OUTPUT_PER_MTOK_AGENT, 0),
      voicePerMinInr: num(env.PRICE_VOICE_PER_MIN_INR, 0),
      usdToInr: num(env.USD_TO_INR, 0),
    },
    avgProjectValueInr: { low: num(env.AVG_PROJECT_VALUE_LOW_INR, 800_000), high: num(env.AVG_PROJECT_VALUE_HIGH_INR, 1_400_000) },
    declineRule: pick(env.DECLINE_RULE, ["one_hard_fail", "two_criteria"] as const, "one_hard_fail"),
    leadTimeHardMinWeeks: num(env.LEAD_TIME_HARD_MIN_WEEKS, 6),
    leadTimeTightUnderWeeks: num(env.LEAD_TIME_TIGHT_UNDER_WEEKS, 10),
    commercialMinSqft: numOrNull(env.COMMERCIAL_MIN_SQFT, 500),
    escalatedRepeatAlsoNotes: (env.ESCALATED_REPEAT_ALSO_NOTES ?? "true").toLowerCase() !== "false",
    // Consultation booking (OPEN: capacity and hours are assumptions until the studio confirms how many designers can take a call at once)
    booking: {
      enabled: (env.BOOKING_ENABLED ?? "true").toLowerCase() !== "false",
      // Cal.com is the calendar of record when configured; otherwise the built-in scheduler
      provider: (env.BOOKING_PROVIDER === "internal" || env.BOOKING_PROVIDER === "calcom" ? env.BOOKING_PROVIDER : env.CAL_API_KEY && env.CAL_EVENT_TYPE_ID ? "calcom" : "internal") as "internal" | "calcom",
      slotMinutes: num(env.BOOKING_SLOT_MINUTES, 30),
      daysAhead: num(env.BOOKING_DAYS_AHEAD, 14),
      minNoticeHours: num(env.BOOKING_MIN_NOTICE_HOURS, 4),
      capacity: num(env.BOOKING_CAPACITY, 1),
      mode: env.BOOKING_MODE ?? "phone or video call",
    },
    calcom: {
      apiKey: env.CAL_API_KEY ?? "",
      eventTypeId: env.CAL_EVENT_TYPE_ID ? Number(env.CAL_EVENT_TYPE_ID) : null,
      timeZone: env.CAL_TIMEZONE ?? env.TZ_NAME ?? "Asia/Kolkata",
      attendeeEmail: env.CAL_ATTENDEE_EMAIL ?? "",
    },
    hubspot: { token: env.HUBSPOT_ACCESS_TOKEN ?? "", createDeal: (env.HUBSPOT_CREATE_DEAL ?? "false").toLowerCase() === "true" },
    unlistedLocalityAction: pick(
      env.UNLISTED_LOCALITY_ACTION,
      ["forward_with_flag", "ask_one_question"] as const,
      "forward_with_flag",
    ),
    firstContactOfficeMinutes: num(env.FIRST_CONTACT_OFFICE_MINUTES, 60),
    afterHoursDeadline: env.AFTER_HOURS_DEADLINE ?? "10:30",
    escalationCallbackOfficeMinutes: num(env.ESCALATION_CALLBACK_OFFICE_MINUTES, 15),
    officeOpenHour: num(env.OFFICE_OPEN_HOUR, 10),
    officeCloseHour: num(env.OFFICE_CLOSE_HOUR, 19),
    officeDays: (env.OFFICE_DAYS ?? "1,2,3,4,5,6").split(",").map((s) => Number(s.trim())),
    tzName: env.TZ_NAME ?? "Asia/Kolkata",
    tzOffsetMinutes: num(env.TZ_OFFSET_MINUTES, 330),
    appBaseUrl: (env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  };
}
