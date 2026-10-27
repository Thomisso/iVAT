# The database is the single authority for access and Roles

Who can see a row and which Role may perform an action are enforced only in PostgreSQL. Row-Level Security policies enforce visibility. Actions that depend on a Role are enforced by RLS policies with Role predicates when they write a single row, and by `security definer` database functions when a command changes several rows atomically or its rule is a state transition, such as Finalization or accepting an invitation. A refused function raises `42501`, the same error as an RLS refusal. The application layer validates input and translates refusals into results. It does not re-check access. The UI may read a user's Roles to decide what to show, but never to authorize.

This replaces ADR-0001's framing of RLS as "a second line of defence behind application authorization". Application-layer tests call the database as a specific user, so they exercise the only place the rules live.

## Considered Options

- Role checks in the application layer, with RLS behind them as a safety net. Rejected: every rule would exist twice, in TypeScript and SQL, and the two would drift. A missing application check would go unnoticed because RLS would still refuse.
