// State rule configs. Every number here is cited; anything not checked against
// the statute text itself is marked `verified: false` and is shown that way in the UI.
// Not legal advice: rules are simplified for a demo. Verify with counsel.

export type StateCode = "IL" | "CA" | "UT";

export interface Citation {
  label: string;
  url: string;
  /** true only when the number was read from the statute/bill text itself */
  verified: boolean;
  note?: string;
}

export interface StateRule {
  state: StateCode;
  name: string;
  law: string;
  /** Minors strictly younger than this age are covered. */
  minorUnderAge: number;
  /** Minor must be in at least this fraction of compensated content (time-weighted) within the window. */
  presenceThreshold: number;
  /** How the eligibility window is measured. */
  window: { kind: "rolling-days"; days: number } | { kind: "calendar-month" } | { kind: "calendar-year" };
  /** Creator compensation floor within the window, in cents (0 = none). */
  creatorEarningsFloorCents: number;
  /** Share formula. */
  formula:
    | { kind: "presence-times-rate"; rate: number; text: string }
    | { kind: "flat-rate-split"; rate: number; text: string };
  /** When more than one qualifying minor is in one video, the combined percentage is split equally. */
  multiMinorEqualSplit: boolean;
  citations: Citation[];
}

export const STATE_RULES: Record<StateCode, StateRule> = {
  IL: {
    state: "IL",
    name: "Illinois",
    law: "SB 1782 (Public Act 103-0556), amending the Child Labor Law; effective July 1, 2024",
    minorUnderAge: 16,
    presenceThreshold: 0.3,
    window: { kind: "rolling-days", days: 30 },
    creatorEarningsFloorCents: 0,
    formula: {
      kind: "presence-times-rate",
      rate: 0.5,
      text:
        "The minor receives a share of gross compensation equal to half the share of content they are in: 100% of the content means at least 50% of gross, and 50% of the content means 25%.",
    },
    multiMinorEqualSplit: true,
    citations: [
      {
        label: "Fisher Phillips: Groundbreaking Illinois Law Protects Child Influencers (Aug 2024)",
        url: "https://www.fisherphillips.com/print/v2/content/36286/groundbreaking-illinois-law-protects-child-influencers-from-financial-exploitation.pdf",
        verified: false,
        note:
          "Law-firm summary. The ilga.gov text could not be reached from the build machine. The equal split between several minors mirrors California §6653(a)(2), which follows the Illinois text; verify it.",
      },
      {
        label: "SB 1782 enrolled text (ilga.gov)",
        url: "https://ilga.gov/legislation/103/SB/10300SB1782eng.htm",
        verified: false,
      },
    ],
  },
  CA: {
    state: "CA",
    name: "California",
    law: "SB 764 (Stats. 2024, ch. 611), Family Code §§ 6650–6656; effective Jan 1, 2025",
    minorUnderAge: 18,
    presenceThreshold: 0.3,
    window: { kind: "calendar-month" },
    creatorEarningsFloorCents: 125_000,
    formula: {
      kind: "presence-times-rate",
      rate: 0.65,
      text:
        "Deposit = (share of compensated minutes that feature the minor) × (total compensation) × 0.65 (Fam. Code § 6652(f)).",
    },
    multiMinorEqualSplit: true,
    citations: [
      {
        label: "SB 764 chaptered text, Fam. Code §§ 6651, 6652(f), 6653(a)",
        url: "https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202320240SB764",
        verified: true,
        note:
          "§6651: at least 30% by time on screen or as the subject of an oral narrative; at least $1,250 compensation in the month. §6652(f) gives the 0.65 multiplier. §6653(a)(2): when several minors qualify, their share is split equally. Read 2026-11-10.",
      },
    ],
  },
  UT: {
    state: "UT",
    name: "Utah",
    law: "HB 322 (2025 General Session), signed March 2025",
    minorUnderAge: 18,
    presenceThreshold: 0.3,
    window: { kind: "calendar-year" },
    creatorEarningsFloorCents: 15_000_000,
    formula: {
      kind: "flat-rate-split",
      rate: 0.15,
      text:
        "Creators earning more than $150,000 a year from content featuring minors set aside 15% of those earnings in trust (simplified; reporting conflicts on per-child thresholds).",
    },
    multiMinorEqualSplit: true,
    citations: [
      {
        label: "FOX 13: Utah adds protections for child influencers (Mar 2025)",
        url: "https://www.fox13now.com/news/politics/utah-adds-protections-for-child-influencers-following-youtuber-ruby-frankes-child-abuse-conviction",
        verified: false,
      },
      {
        label: "Deseret News: child influencer protections (Mar 7, 2025)",
        url: "https://www.deseret.com/utah/2025/03/07/child-influencer-protections/",
        verified: false,
        note:
          "Reports extra thresholds: a $20,000 per-child floor and a $40,000 floor for the 15%. These conflict with AP reporting, and the le.utah.gov text was unreachable. Treat the Utah rule as a preview.",
      },
    ],
  },
};

export const DISCLAIMER = "Not legal advice; rules simplified for demo; verify with counsel.";
