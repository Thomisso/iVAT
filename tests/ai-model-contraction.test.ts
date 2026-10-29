import { Client as DatabaseClient } from "pg";
import { describe, expect, inject, it } from "vitest";

describe("platform-owned AI model contraction", () => {
  it("removes Organization credential storage and every legacy credential-source contract", async () => {
    const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
    await database.connect();
    try {
      const relations = await database.query<{ name: string | null }>(`
        select to_regclass('public.organization_ai_provider_key')::text as name
        union all
        select to_regclass('public.organization_platform_ai_access')::text
      `);
      expect(relations.rows.map(({ name }) => name)).toEqual([null, null]);

      const legacyFunctions = await database.query<{ proname: string }>(`
        select procedure.proname
        from pg_proc procedure
        join pg_namespace namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'public'
          and procedure.proname = any(array[
            'configure_company_ai_processing',
            'configure_platform_ai_provider',
            'disable_company_ai_processing',
            'list_available_ai_providers',
            'list_company_ai_options',
            'list_organization_ai_provider_keys',
            'list_organization_ai_usage',
            'list_platform_ai_providers',
            'list_platform_organizations',
            'list_platform_organizations_complete',
            'remove_organization_ai_provider_key',
            'resolve_company_ai_provider',
            'resolve_platform_ai_provider',
            'save_organization_ai_provider_key',
            'set_organization_platform_ai_access'
          ])
      `);
      expect(legacyFunctions.rows).toEqual([]);

      const credentialSource = await database.query<{ exists: boolean }>(`
        select exists (
          select 1 from pg_type type
          join pg_namespace namespace on namespace.oid = type.typnamespace
          where namespace.nspname = 'public' and type.typname = 'ai_credential_source'
        )
      `);
      expect(credentialSource.rows[0].exists).toBe(false);

      const legacyCompanyColumn = await database.query<{ exists: boolean }>(`
        select exists (
          select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name = 'company'
            and column_name = 'ai_credential_source'
        )
      `);
      expect(legacyCompanyColumn.rows[0].exists).toBe(false);

      const providerColumns = await database.query<{ column_name: string }>(`
        select column_name
        from information_schema.columns
        where table_schema = 'public' and table_name = 'platform_ai_provider'
        order by ordinal_position
      `);
      expect(providerColumns.rows.map(({ column_name }) => column_name)).toEqual(["provider"]);

      const organizationSecrets = await database.query<{ count: string }>(`
        select count(*)::text
        from vault.secrets
        where name like 'organization_ai_%'
      `);
      expect(organizationSecrets.rows[0].count).toBe("0");
    } finally {
      await database.end();
    }
  });
});
