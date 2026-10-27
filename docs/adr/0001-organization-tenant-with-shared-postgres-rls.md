# Organization is the tenant; shared PostgreSQL with Row-Level Security

The tenant is the **Organization**, which owns one or more **Companies**. The model stays the same whether a business manages its own VAT (one Company) or an accounting office manages many clients. A User can hold Memberships in several Companies with a different Role in each. All tenants share one PostgreSQL database. Every tenant-owned row carries `organization_id` (and `company_id` where applicable), and Row-Level Security policies enforce isolation in the database as a second line of defence behind application authorization.

_Where access is enforced is superseded by ADR-0008: the database is the single authority, not a second line behind application authorization._

## Considered Options

- Users belonging directly to Companies with no Organization layer. Rejected: billing, BYOK keys and accounting-office staff need a level above Company, and adding it later would require a painful migration.
- Schema-per-tenant or database-per-tenant. Rejected: operationally heavy for a solo developer, and RLS gives database-enforced isolation without it.
