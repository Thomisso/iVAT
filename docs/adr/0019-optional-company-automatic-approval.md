# Companies may explicitly enable automatic Document approval

Human review remains the default, but a Company may explicitly enable automatic approval of eligible Documents without a human opening each one. This trades mandatory per-Document confirmation for faster processing under an opt-in policy; approval history must distinguish automatic approval from a human decision. AI output itself does not authorize approval or compute tax results.

This decision changes the mandatory-human-review clause of ADR-0003. The option defaults to disabled and only an Administrator or SuperAdmin can change it, with an audit record. Eligibility requires no errors, warnings or Duplicate Warning, supported VAT Report classification and an available unlocked Reporting Period. Missing required verification prevents automatic approval; provider confidence is not a criterion.

Automatic approval is attempted only on completion of a new AI Extraction, including an explicitly requested rerun. Enabling the setting does not approve a backlog, and manual corrections, Partial Claims and refreshed Bank Account Checks do not trigger it. Prior manual claim selection requires renewed human confirmation after a relevant data change or new Extraction; automatic approval must not restore a full claim. Ordinary incoming time eligibility also follows ADR-0020.

The decision was accepted during the Document review design session on 6 November 2026 and delivered by #241 in [PR #243](https://github.com/Thomisso/iVAT/pull/243), merged on 8 November 2026. Concurrency, failure and acceptance details remain in [the shared specification](../document-review.md). Later warnings do not revoke earlier approval automatically. Existing authorization, immutable Extraction Versions and Period Locks remain authoritative.
