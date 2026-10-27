
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {

  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "audit_event": {
                  Row: {
                    "action": string,"actor_user_id": string | null,"company_id": string | null,"id": number,"occurred_at": string,"organization_id": string,"payload": NonNullable<Json>,"target_id": string | null,"target_type": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_user_id"?: string | null,"company_id"?: string | null,"id"?: never,"occurred_at"?: string,"organization_id": string,"payload"?: NonNullable<Json>,"target_id"?: string | null,"target_type": string
                  }
                  Update: {
                    "action"?: string,"actor_user_id"?: string | null,"company_id"?: string | null,"id"?: never,"occurred_at"?: string,"organization_id"?: string,"payload"?: NonNullable<Json>,"target_id"?: string | null,"target_type"?: string
                  }
                  Relationships: [

                  ]
                },"company": {
                  Row: {
                    "ai_processing_enabled": boolean,"ai_provider": string | null,"ai_region": string | null,"city": string,"created_at": string,"created_by": string | null,"ico": string,"id": string,"name": string,"organization_id": string,"person_type": Database["public"]['Enums']["person_type"],"postal_code": string,"street": string,"vat_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "ai_processing_enabled"?: boolean,"ai_provider"?: string | null,"ai_region"?: string | null,"city": string,"created_at"?: string,"created_by"?: string | null,"ico": string,"id"?: string,"name": string,"organization_id": string,"person_type"?: Database["public"]['Enums']["person_type"],"postal_code": string,"street": string,"vat_id": string
                  }
                  Update: {
                    "ai_processing_enabled"?: boolean,"ai_provider"?: string | null,"ai_region"?: string | null,"city"?: string,"created_at"?: string,"created_by"?: string | null,"ico"?: string,"id"?: string,"name"?: string,"organization_id"?: string,"person_type"?: Database["public"]['Enums']["person_type"],"postal_code"?: string,"street"?: string,"vat_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "company_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organization"
      referencedColumns: ["id"]
    }
                  ]
                },"company_filing_frequency": {
                  Row: {
                    "company_id": string,"created_at": string,"effective_from": string,"frequency": Database["public"]['Enums']["filing_frequency"],"organization_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"created_at"?: string,"effective_from": string,"frequency": Database["public"]['Enums']["filing_frequency"],"organization_id": string
                  }
                  Update: {
                    "company_id"?: string,"created_at"?: string,"effective_from"?: string,"frequency"?: Database["public"]['Enums']["filing_frequency"],"organization_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "company_filing_frequency_company_id_organization_id_fkey"
      columns: ["company_id","organization_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"document": {
                  Row: {
                    "company_id": string,"created_at": string,"extraction_request_id": string,"first_page": number,"id": string,"last_page": number,"organization_id": string,"source_file_id": string,"status": Database["public"]['Enums']["document_status"]
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"created_at"?: string,"extraction_request_id"?: string,"first_page": number,"id"?: string,"last_page": number,"organization_id": string,"source_file_id": string,"status"?: Database["public"]['Enums']["document_status"]
                  }
                  Update: {
                    "company_id"?: string,"created_at"?: string,"extraction_request_id"?: string,"first_page"?: number,"id"?: string,"last_page"?: number,"organization_id"?: string,"source_file_id"?: string,"status"?: Database["public"]['Enums']["document_status"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "document_source_file_id_company_id_organization_id_fkey"
      columns: ["source_file_id","company_id","organization_id"]
isOneToOne: false
      referencedRelation: "source_file"
      referencedColumns: ["id","company_id","organization_id"]
    }
                  ]
                },"extraction_version": {
                  Row: {
                    "author_user_id": string | null,"company_id": string,"created_at": string,"document_id": string,"extraction_request_id": string | null,"id": string,"model": string | null,"organization_id": string,"payload": NonNullable<Json>,"provider": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "author_user_id"?: string | null,"company_id": string,"created_at"?: string,"document_id": string,"extraction_request_id"?: string | null,"id"?: string,"model"?: string | null,"organization_id": string,"payload": NonNullable<Json>,"provider"?: string | null,"version": number
                  }
                  Update: {
                    "author_user_id"?: string | null,"company_id"?: string,"created_at"?: string,"document_id"?: string,"extraction_request_id"?: string | null,"id"?: string,"model"?: string | null,"organization_id"?: string,"payload"?: NonNullable<Json>,"provider"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "extraction_version_document_id_company_id_organization_id_fkey"
      columns: ["document_id","company_id","organization_id"]
isOneToOne: false
      referencedRelation: "document"
      referencedColumns: ["id","company_id","organization_id"]
    },{
      foreignKeyName: "extraction_version_document_id_company_id_organization_id_fkey"
      columns: ["document_id","company_id","organization_id"]
isOneToOne: false
      referencedRelation: "document_overview"
      referencedColumns: ["id","company_id","organization_id"]
    },{
      foreignKeyName: "extraction_version_document_id_company_id_organization_id_fkey"
      columns: ["document_id","company_id","organization_id"]
isOneToOne: false
      referencedRelation: "vat_report_document"
      referencedColumns: ["id","company_id","organization_id"]
    }
                  ]
                },"invitation": {
                  Row: {
                    "accepted_at": string | null,"accepted_by": string | null,"company_id": string | null,"created_at": string,"created_by": string,"email": string,"expires_at": string,"id": string,"organization_id": string,"role": Database["public"]['Enums']["membership_role"],"token_hash": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"company_id"?: string | null,"created_at"?: string,"created_by"?: string,"email": string,"expires_at"?: string,"id"?: string,"organization_id": string,"role": Database["public"]['Enums']["membership_role"],"token_hash": string
                  }
                  Update: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"company_id"?: string | null,"created_at"?: string,"created_by"?: string,"email"?: string,"expires_at"?: string,"id"?: string,"organization_id"?: string,"role"?: Database["public"]['Enums']["membership_role"],"token_hash"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "invitation_company_id_organization_id_fkey"
      columns: ["company_id","organization_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "invitation_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organization"
      referencedColumns: ["id"]
    }
                  ]
                },"membership": {
                  Row: {
                    "company_id": string | null,"created_at": string,"email": string,"id": string,"organization_id": string,"role": Database["public"]['Enums']["membership_role"],"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id"?: string | null,"created_at"?: string,"email": string,"id"?: string,"organization_id": string,"role": Database["public"]['Enums']["membership_role"],"user_id": string
                  }
                  Update: {
                    "company_id"?: string | null,"created_at"?: string,"email"?: string,"id"?: string,"organization_id"?: string,"role"?: Database["public"]['Enums']["membership_role"],"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "membership_company_id_organization_id_fkey"
      columns: ["company_id","organization_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "membership_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organization"
      referencedColumns: ["id"]
    }
                  ]
                },"organization": {
                  Row: {
                    "created_at": string,"id": string,"mfa_required": boolean,"name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"mfa_required"?: boolean,"name": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"mfa_required"?: boolean,"name"?: string
                  }
                  Relationships: [

                  ]
                },"platform_user": {
                  Row: {
                    "created_at": string,"role": Database["public"]['Enums']["platform_role"],"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"role": Database["public"]['Enums']["platform_role"],"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"role"?: Database["public"]['Enums']["platform_role"],"user_id"?: string
                  }
                  Relationships: [

                  ]
                },"source_file": {
                  Row: {
                    "byte_size": number,"company_id": string,"file_name": string,"format": Database["public"]['Enums']["source_file_format"],"id": string,"organization_id": string,"page_count": number,"sha256": string,"status": Database["public"]['Enums']["source_file_status"],"uploaded_at": string,"uploaded_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "byte_size": number,"company_id": string,"file_name": string,"format": Database["public"]['Enums']["source_file_format"],"id": string,"organization_id": string,"page_count": number,"sha256": string,"status"?: Database["public"]['Enums']["source_file_status"],"uploaded_at"?: string,"uploaded_by"?: string | null
                  }
                  Update: {
                    "byte_size"?: number,"company_id"?: string,"file_name"?: string,"format"?: Database["public"]['Enums']["source_file_format"],"id"?: string,"organization_id"?: string,"page_count"?: number,"sha256"?: string,"status"?: Database["public"]['Enums']["source_file_status"],"uploaded_at"?: string,"uploaded_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "source_file_company_id_organization_id_fkey"
      columns: ["company_id","organization_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"vat_report": {
                  Row: {
                    "company_id": string,"documents": NonNullable<Json>,"generated_at": string,"generated_by": string,"id": string,"organization_id": string,"period": string,"result": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"documents": NonNullable<Json>,"generated_at"?: string,"generated_by": string,"id"?: string,"organization_id": string,"period": string,"result": NonNullable<Json>
                  }
                  Update: {
                    "company_id"?: string,"documents"?: NonNullable<Json>,"generated_at"?: string,"generated_by"?: string,"id"?: string,"organization_id"?: string,"period"?: string,"result"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "vat_report_company_id_organization_id_fkey"
      columns: ["company_id","organization_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "vat_report_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organization"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            "document_overview": {
                  Row: {
                    "company_id": string,"counterparty_ico": string | null,"counterparty_name": string | null,"counterparty_search": string | null,"counterparty_vat_id": string | null,"created_at": string,"currency": string | null,"direction": string | null,"document_number": string | null,"first_page": number,"gross_amount": string | null,"id": string,"last_page": number,"organization_id": string,"reporting_period": string | null,"source_file_id": string,"status": Database["public"]['Enums']["document_status"],"tax_point_date": string | null,"version": number | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "document_source_file_id_company_id_organization_id_fkey"
      columns: ["source_file_id","company_id","organization_id"]
isOneToOne: false
      referencedRelation: "source_file"
      referencedColumns: ["id","company_id","organization_id"]
    }
                  ]
                },"vat_report_document": {
                  Row: {
                    "company_id": string,"extraction_version_id": string | null,"id": string,"organization_id": string,"payload": Json | null,"status": Database["public"]['Enums']["document_status"]
                  }
                  ComputedFields: never
                  Relationships: [

                  ]
                }
          }
          Functions: {
            "accept_invitation":
{ Args: { "invitation_token": string }; Returns: undefined
                           },
"approve_document":
{ Args: { "reviewed_version": number,"target_document_id": string }; Returns: undefined
                           },
"cancel_invitation":
{ Args: { "invitation_token": string }; Returns: undefined
                           },
"change_membership_role":
{ Args: { "target_membership_id": string,"target_role": Database["public"]['Enums']["membership_role"] }; Returns: undefined
                           },
"correct_document":
{ Args: { "based_on_version": number,"payload": Json,"target_document_id": string }; Returns: number
                           },
"create_company":
{ Args: { "company_city": string,"company_ico": string,"company_name": string,"company_person_type": Database["public"]['Enums']["person_type"],"company_postal_code": string,"company_street": string,"company_vat_id": string,"filing_frequency_effective_from": string,"initial_filing_frequency": Database["public"]['Enums']["filing_frequency"],"target_organization_id": string }; Returns: string
                           },
"create_invitation":
{ Args: { "target_company_id": string,"target_email": string,"target_organization_id": string,"target_role": Database["public"]['Enums']["membership_role"] }; Returns: string
                           },
"current_mfa_policy":
{ Args: Record<PropertyKey, never>; Returns: {
              "enrolled": boolean,"required": boolean,"satisfied": boolean
            }[]
                           },
"finish_mfa_disenrollment":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"finish_mfa_enrollment":
{ Args: Record<PropertyKey, never>; Returns: (string)[]
                           },
"mfa_recovery_codes_remaining":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"record_ai_extraction":
{ Args: { "model": string,"payload": Json,"provider": string,"target_document_id": string,"target_extraction_request_id": string }; Returns: undefined
                           },
"record_split":
{ Args: { "page_ranges": Json,"target_source_file_id": string }; Returns: undefined
                           },
"reject_document":
{ Args: { "target_document_id": string }; Returns: undefined
                           },
"remove_membership":
{ Args: { "target_membership_id": string }; Returns: undefined
                           },
"reprocess_document":
{ Args: { "target_document_id": string }; Returns: undefined
                           },
"retry_split":
{ Args: { "target_source_file_id": string }; Returns: undefined
                           },
"save_vat_report":
{ Args: { "computed_result": Json,"expected_documents": Json,"target_company_id": string,"target_period": string }; Returns: string
                           },
"set_organization_mfa_required":
{ Args: { "required": boolean,"target_organization_id": string }; Returns: undefined
                           },
"update_company":
{ Args: { "company_city": string,"company_ico": string,"company_name": string,"company_person_type": Database["public"]['Enums']["person_type"],"company_postal_code": string,"company_street": string,"company_vat_id": string,"filing_frequency_effective_from": string,"new_filing_frequency": Database["public"]['Enums']["filing_frequency"],"target_company_id": string }; Returns: undefined
                           },
"vat_report_documents":
{ Args: { "target_company_id": string,"target_period": string }; Returns: Json
                           },
"verify_mfa_recovery_code":
{ Args: { "input_code": string }; Returns: boolean
                           }
          }
          Enums: {
            "document_status": "uploaded"|"processing"|"needs_review"|"failed"|"approved"|"rejected","filing_frequency": "monthly"|"quarterly","membership_role": "administrator"|"user","person_type": "legal"|"natural","platform_role": "super_admin","source_file_format": "pdf"|"png"|"jpeg","source_file_status": "uploaded"|"processing"|"split"|"failed"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {

          }
        },"public": {
          Enums: {
            "document_status": ["uploaded", "processing", "needs_review", "failed", "approved", "rejected"],"filing_frequency": ["monthly", "quarterly"],"membership_role": ["administrator", "user"],"person_type": ["legal", "natural"],"platform_role": ["super_admin"],"source_file_format": ["pdf", "png", "jpeg"],"source_file_status": ["uploaded", "processing", "split", "failed"]
          }
        }
} as const
