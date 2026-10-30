import { systemClient } from "./worker";

/** Durable usage history for checking read models above the API row limit. */
export async function addAiUsageModelsFixture(
  target: { organizationId: string; companyId: string; configurationId: string },
  count: number,
) {
  const system = systemClient();
  for (let offset = 0; offset < count; offset += 50) {
    await Promise.all(Array.from({ length: Math.min(50, count - offset) }, async (_, index) => {
      const { error } = await system.rpc("record_ai_usage", {
        target_organization_id: target.organizationId,
        target_company_id: target.companyId,
        target_configuration_id: target.configurationId,
        target_provider: "fake",
        target_model: `many-model-${offset + index}`,
        target_operation: "extract",
        target_input_tokens: 1,
        target_output_tokens: 1,
        target_job_name: "extract-document",
        target_job_id: crypto.randomUUID(),
        target_provider_cost_usd: 1,
      });
      if (error) throw error;
    }));
  }
}
