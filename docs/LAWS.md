# The laws, and how sure we are of each number

Checked on 2026-11-10. **Not legal advice; rules simplified for demo; verify with counsel.**

| State | Law | Who is covered | Threshold | Share into trust | Checked against statute text? |
|---|---|---|---|---|---|
| Illinois | SB 1782 (P.A. 103-0556), effective July 1, 2024 | under 16 | ≥30% of compensated content within a 30-day period | half the minor's content percentage (100% → 50% of gross, 50% → 25%) | **No.** ilga.gov was unreachable from the build machine. Figures come from Fisher Phillips. |
| California | SB 764, Fam. Code §§ 6650–6656, effective Jan 1, 2025 | under 18 | ≥30% in a month, **and** ≥ $1,250 creator compensation in the month, **and** ≥ $0.10/view or the platform's payout threshold | minutes-share × compensation × **0.65** (§ 6652(f)) | **Yes.** Read on leginfo.legislature.ca.gov. |
| Utah | HB 322 (2025) | under 18 | creator earns > $150,000/yr from content with minors; ≥30% of content | 15% | **No.** le.utah.gov was unreachable, and reports conflict (Deseret News adds $20k and $40k per-child floors). Shown as a preview. |

## How presence is measured (identical wording in IL and CA)

> "…the amount of time the likeness, name, or photograph of the minor visually appears or is the subject of an oral narrative in a video segment, as compared to the total length of the segment." (Cal. Fam. Code § 6651(a)(2))

So Their Cut counts two kinds of seconds: those where the child is on screen, and those where the child is the subject of what's being said.

## Several children in one video

Cal. Fam. Code § 6653(a)(2), which follows the Illinois text:

> "…the percentage … for all minors in any segment shall be equally divided between the minors, regardless of the differences in percentage of content provided by the individual minors."

The engine takes the **union** of the qualifying children's presence in the video and splits that percentage equally among them.

## Interpretations we made (flagged in the UI)

1. **Brand deals.** A flat brand fee is treated as "compensation" for the video. The per-view test (≥ $0.10/view or the platform threshold) is treated as met, because the deal itself is the compensation.
2. **Rounding.** Each child's share is rounded *up* to the cent, because Illinois says "at least".
3. **Catch-up.** When a child first crosses 30% in a window, earlier deals in that window that featured them may now be owed. The agent proposes these amounts and the parent approves them; they are never paid automatically.
4. **California deposits** must happen at least every three months (§ 6653(b)(4)). Their Cut deposits as soon as the brand pays.
5. **Utah** is computed but flagged "unverified". The demo uses IL and CA for real payouts.

## Sources

- Cal. SB 764 chaptered text: https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202320240SB764
- Illinois SB 1782 (Fisher Phillips summary): https://www.fisherphillips.com/print/v2/content/36286/groundbreaking-illinois-law-protects-child-influencers-from-financial-exploitation.pdf
- Illinois SB 1782 text: https://ilga.gov/legislation/103/SB/10300SB1782eng.htm
- Utah HB 322, FOX 13: https://www.fox13now.com/news/politics/utah-adds-protections-for-child-influencers-following-youtuber-ruby-frankes-child-abuse-conviction
- Utah HB 322, Deseret News: https://www.deseret.com/utah/2025/03/07/child-influencer-protections/
- Other states: https://techpolicy.press/the-coming-wave-of-child-influencer-regulation (counts differ between sources, so we don't claim a number)
