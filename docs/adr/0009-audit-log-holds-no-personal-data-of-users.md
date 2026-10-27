# The audit log holds no personal data of Users

`audit_event` is append-only, so anything written to it cannot be erased later. Audit payloads therefore never contain personal data of Users, such as email or name. A User appears only as an id (`actor_user_id`, `target_id`), and names are resolved when the log is read, so an erasure request is handled by anonymizing the account without touching the log. Business data of Companies and Documents may appear in payloads, even when the Company is a natural person, because it falls under the 10-year VAT retention obligation, which is an exception to the right to erasure (GDPR Art. 17(3)(b)).

## Considered Options

- Allowing personal data and pseudonymizing it on request through a privileged procedure. Rejected: it would need an exception to the append-only rule, the one property that makes the log trustworthy.
