# Their Cut

**A brand pays for a family video. Their Cut measures how much of the video each child is in, applies their state's child-influencer law, and as soon as PayPal confirms the brand's payment, moves each child's legal share into their trust. Every step is recorded so the child can read it when they turn 18.**

Built with **PayPal** (Invoicing v2, Payouts, Webhooks, Orders v2) and **AI** (Gemini video understanding and transcription, plus LLM explanations of the rules).

> 🚧 Under active development for the PayPal AI Hackathon (deadline Nov 12, 2026).

## Why

Illinois (SB 1782), California (SB 764) and Utah (HB 322) now require parents who earn money from family-vlog content to set aside a share for the children in it. Illinois and California define that share by **time on screen or as the subject of narration**. Nobody measures it, and nothing moves the money. See [docs/LAWS.md](docs/LAWS.md) for exact citations and for which numbers we've checked against the statute text.

**Not legal advice; rules simplified for demo; verify with counsel.**

## Status

- [x] Deterministic state rule engine (IL, CA, UT preview) with tests: `npm test`
- [ ] PayPal sandbox spikes: [docs/SPIKES.md](docs/SPIKES.md)
- [ ] Video presence measurement and eval
- [ ] Web app and hosting

## License

MIT. See [LICENSE](LICENSE).
