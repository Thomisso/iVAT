
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
            "ai_configuration": {
                  Row: {
                    "created_at": string,"created_by": string | null,"credential_last_four": string,"credential_secret_id": string,"extract_model": string,"id": string,"is_default": boolean,"label": string,"provider": string,"split_model": string,"updated_at": string,"updated_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"credential_last_four": string,"credential_secret_id": string,"extract_model": string,"id"?: string,"is_default"?: boolean,"label": string,"provider": string,"split_model": string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"credential_last_four"?: string,"credential_secret_id"?: string,"extract_model"?: string,"id"?: string,"is_default"?: boolean,"label"?: string,"provider"?: string,"split_model"?: string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "ai_configuration_provider_fkey"
      columns: ["provider"]
isOneToOne: false
      referencedRelation: "platform_ai_provider"
      referencedColumns: ["provider"]
    }
                  ]
                },"ai_model_price": {
                  Row: {
                    "configuration_id": string,"input_price_per_million_usd": number,"model": string,"output_price_per_million_usd": number,"updated_at": string,"updated_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "configuration_id": string,"input_price_per_million_usd": number,"model": string,"output_price_per_million_usd": number,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "configuration_id"?: string,"input_price_per_million_usd"?: number,"model"?: string,"output_price_per_million_usd"?: number,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "ai_model_price_configuration_id_fkey"
      columns: ["configuration_id"]
isOneToOne: false
      referencedRelation: "ai_configuration"
      referencedColumns: ["id"]
    }
                  ]
                },"ai_processing_issue": {
                  Row: {
                    "classification": Database["public"]['Enums']["ai_processing_issue_classification"],"company_id": string,"configuration_id": string | null,"first_detected_at": string,"organization_id": string,"provider": string | null,"state": Database["public"]['Enums']["ai_processing_issue_state"],"target_id": string,"target_kind": Database["public"]['Enums']["ai_processing_target_kind"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "classification": Database["public"]['Enums']["ai_processing_issue_classification"],"company_id": string,"configuration_id"?: string | null,"first_detected_at"?: string,"organization_id": string,"provider"?: string | null,"state": Database["public"]['Enums']["ai_processing_issue_state"],"target_id": string,"target_kind": Database["public"]['Enums']["ai_processing_target_kind"],"updated_at"?: string
                  }
                  Update: {
                    "classification"?: Database["public"]['Enums']["ai_processing_issue_classification"],"company_id"?: string,"configuration_id"?: string | null,"first_detected_at"?: string,"organization_id"?: string,"provider"?: string | null,"state"?: Database["public"]['Enums']["ai_processing_issue_state"],"target_id"?: string,"target_kind"?: Database["public"]['Enums']["ai_processing_target_kind"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "ai_processing_issue_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ai_processing_issue_configuration_id_fkey"
      columns: ["configuration_id"]
isOneToOne: false
      referencedRelation: "ai_configuration"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ai_processing_issue_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organization"
      referencedColumns: ["id"]
    }
                  ]
                },"ai_processing_reservation": {
                  Row: {
                    "company_id": string,"created_at": string,"document_id": string,"extraction_request_id": string,"id": string,"organization_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"created_at"?: string,"document_id": string,"extraction_request_id": string,"id": string,"organization_id": string
                  }
                  Update: {
                    "company_id"?: string,"created_at"?: string,"document_id"?: string,"extraction_request_id"?: string,"id"?: string,"organization_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "ai_processing_reservation_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ai_processing_reservation_document_id_fkey"
      columns: ["document_id"]
isOneToOne: false
      referencedRelation: "document"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ai_processing_reservation_document_id_fkey"
      columns: ["document_id"]
isOneToOne: false
      referencedRelation: "document_duplicate_warning"
      referencedColumns: ["document_id"]
    },{
      foreignKeyName: "ai_processing_reservation_document_id_fkey"
      columns: ["document_id"]
isOneToOne: false
      referencedRelation: "document_overview"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ai_processing_reservation_document_id_fkey"
      columns: ["document_id"]
isOneToOne: false
      referencedRelation: "vat_report_document"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ai_processing_reservation_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organization"
      referencedColumns: ["id"]
    }
                  ]
                },"ai_usage_event": {
                  Row: {
                    "ai_configuration_id": string | null,"company_id": string,"cost_usd": number | null,"created_at": string,"id": number,"input_tokens": number,"job_name": string,"job_target_id": string,"model": string,"operation": string,"organization_id": string,"output_tokens": number,"provider": string,"requests": number
                  }
                  ComputedFields: never
                  Insert: {
                    "ai_configuration_id"?: string | null,"company_id": string,"cost_usd"?: number | null,"created_at"?: string,"id"?: never,"input_tokens": number,"job_name": string,"job_target_id": string,"model": string,"operation": string,"organization_id": string,"output_tokens": number,"provider": string,"requests"?: number
                  }
                  Update: {
                    "ai_configuration_id"?: string | null,"company_id"?: string,"cost_usd"?: number | null,"created_at"?: string,"id"?: never,"input_tokens"?: number,"job_name"?: string,"job_target_id"?: string,"model"?: string,"operation"?: string,"organization_id"?: string,"output_tokens"?: number,"provider"?: string,"requests"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "ai_usage_event_ai_configuration_id_fkey"
      columns: ["ai_configuration_id"]
isOneToOne: false
      referencedRelation: "ai_configuration"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ai_usage_event_company_id_organization_id_fkey"
      columns: ["company_id","organization_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "ai_usage_event_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organization"
      referencedColumns: ["id"]
    }
                  ]
                },"audit_event": {
                  Row: {
                    "action": string,"actor_user_id": string | null,"company_id": string | null,"id": number,"occurred_at": string,"organization_id": string | null,"payload": NonNullable<Json>,"target_id": string | null,"target_type": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_user_id"?: string | null,"company_id"?: string | null,"id"?: never,"occurred_at"?: string,"organization_id"?: string | null,"payload"?: NonNullable<Json>,"target_id"?: string | null,"target_type": string
                  }
                  Update: {
                    "action"?: string,"actor_user_id"?: string | null,"company_id"?: string | null,"id"?: never,"occurred_at"?: string,"organization_id"?: string | null,"payload"?: NonNullable<Json>,"target_id"?: string | null,"target_type"?: string
                  }
                  Relationships: [

                  ]
                },"company": {
                  Row: {
                    "ai_processing_allowance": number | null,"ai_processing_enabled": boolean,"ai_provider": string | null,"ai_region": string | null,"city": string,"created_at": string,"created_by": string | null,"data_revision": number,"deleted_at": string | null,"deleted_by": string | null,"first_name": string | null,"house_number": string | null,"ico": string,"id": string,"last_name": string | null,"name": string,"organization_id": string,"orientation_number": string | null,"person_type": Database["public"]['Enums']["person_type"],"postal_code": string,"street": string,"street_name": string | null,"vat_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "ai_processing_allowance"?: number | null,"ai_processing_enabled"?: boolean,"ai_provider"?: string | null,"ai_region"?: string | null,"city": string,"created_at"?: string,"created_by"?: string | null,"data_revision"?: number,"deleted_at"?: string | null,"deleted_by"?: string | null,"first_name"?: string | null,"house_number"?: string | null,"ico": string,"id"?: string,"last_name"?: string | null,"name": string,"organization_id": string,"orientation_number"?: string | null,"person_type"?: Database["public"]['Enums']["person_type"],"postal_code": string,"street": string,"street_name"?: string | null,"vat_id": string
                  }
                  Update: {
                    "ai_processing_allowance"?: number | null,"ai_processing_enabled"?: boolean,"ai_provider"?: string | null,"ai_region"?: string | null,"city"?: string,"created_at"?: string,"created_by"?: string | null,"data_revision"?: number,"deleted_at"?: string | null,"deleted_by"?: string | null,"first_name"?: string | null,"house_number"?: string | null,"ico"?: string,"id"?: string,"last_name"?: string | null,"name"?: string,"organization_id"?: string,"orientation_number"?: string | null,"person_type"?: Database["public"]['Enums']["person_type"],"postal_code"?: string,"street"?: string,"street_name"?: string | null,"vat_id"?: string
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
                },"company_ai_configuration": {
                  Row: {
                    "assigned_at": string,"assigned_by": string | null,"company_id": string,"configuration_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assigned_at"?: string,"assigned_by"?: string | null,"company_id": string,"configuration_id": string
                  }
                  Update: {
                    "assigned_at"?: string,"assigned_by"?: string | null,"company_id"?: string,"configuration_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "company_ai_configuration_company_id_fkey"
      columns: ["company_id"]
isOneToOne: true
      referencedRelation: "company"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "company_ai_configuration_configuration_id_fkey"
      columns: ["configuration_id"]
isOneToOne: false
      referencedRelation: "ai_configuration"
      referencedColumns: ["id"]
    }
                  ]
                },"company_data_export": {
                  Row: {
                    "byte_size": number | null,"company_id": string,"completed_at": string | null,"created_at": string,"created_by": string,"data_revision": number,"failed_at": string | null,"file_name": string,"id": string,"organization_id": string,"sha256": string | null,"snapshot": NonNullable<Json>,"status": string,"used_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "byte_size"?: number | null,"company_id": string,"completed_at"?: string | null,"created_at"?: string,"created_by": string,"data_revision"?: number,"failed_at"?: string | null,"file_name": string,"id": string,"organization_id": string,"sha256"?: string | null,"snapshot": NonNullable<Json>,"status"?: string,"used_at"?: string | null
                  }
                  Update: {
                    "byte_size"?: number | null,"company_id"?: string,"completed_at"?: string | null,"created_at"?: string,"created_by"?: string,"data_revision"?: number,"failed_at"?: string | null,"file_name"?: string,"id"?: string,"organization_id"?: string,"sha256"?: string | null,"snapshot"?: NonNullable<Json>,"status"?: string,"used_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "company_data_export_company_id_organization_id_fkey"
      columns: ["company_id","organization_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"company_filing_defaults": {
                  Row: {
                    "company_id": string,"economic_activity": string | null,"email": string | null,"epo_address_confirmed_at": string | null,"epo_city": string | null,"epo_house_number": string | null,"epo_orientation_number": string | null,"epo_postal_code": string | null,"epo_street_name": string | null,"organization_id": string,"phone": string | null,"signatory_capacity": string | null,"signatory_first_name": string | null,"signatory_last_name": string | null,"tax_office": string | null,"territorial_office": string | null,"updated_at": string,"updated_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"economic_activity"?: string | null,"email"?: string | null,"epo_address_confirmed_at"?: string | null,"epo_city"?: string | null,"epo_house_number"?: string | null,"epo_orientation_number"?: string | null,"epo_postal_code"?: string | null,"epo_street_name"?: string | null,"organization_id": string,"phone"?: string | null,"signatory_capacity"?: string | null,"signatory_first_name"?: string | null,"signatory_last_name"?: string | null,"tax_office"?: string | null,"territorial_office"?: string | null,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "company_id"?: string,"economic_activity"?: string | null,"email"?: string | null,"epo_address_confirmed_at"?: string | null,"epo_city"?: string | null,"epo_house_number"?: string | null,"epo_orientation_number"?: string | null,"epo_postal_code"?: string | null,"epo_street_name"?: string | null,"organization_id"?: string,"phone"?: string | null,"signatory_capacity"?: string | null,"signatory_first_name"?: string | null,"signatory_last_name"?: string | null,"tax_office"?: string | null,"territorial_office"?: string | null,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "company_filing_defaults_company_id_organization_id_fkey"
      columns: ["company_id","organization_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"company_setup_step_state": {
                  Row: {
                    "changed_at": string,"changed_by": string | null,"company_id": string,"organization_id": string,"state": Database["public"]['Enums']["company_setup_state"],"step": Database["public"]['Enums']["company_setup_step"]
                  }
                  ComputedFields: never
                  Insert: {
                    "changed_at"?: string,"changed_by"?: string | null,"company_id": string,"organization_id": string,"state": Database["public"]['Enums']["company_setup_state"],"step": Database["public"]['Enums']["company_setup_step"]
                  }
                  Update: {
                    "changed_at"?: string,"changed_by"?: string | null,"company_id"?: string,"organization_id"?: string,"state"?: Database["public"]['Enums']["company_setup_state"],"step"?: Database["public"]['Enums']["company_setup_step"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "company_setup_step_state_company_id_organization_id_fkey"
      columns: ["company_id","organization_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"document": {
                  Row: {
                    "claimed_reporting_period": string | null,"company_id": string,"created_at": string,"extraction_request_id": string,"first_page": number,"first_row": number | null,"has_document_image": boolean,"id": string,"last_page": number,"last_row": number | null,"organization_id": string,"source_file_id": string,"source_sheet": string | null,"status": Database["public"]['Enums']["document_status"],"superseded_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "claimed_reporting_period"?: string | null,"company_id": string,"created_at"?: string,"extraction_request_id"?: string,"first_page": number,"first_row"?: number | null,"has_document_image"?: boolean,"id"?: string,"last_page": number,"last_row"?: number | null,"organization_id": string,"source_file_id": string,"source_sheet"?: string | null,"status"?: Database["public"]['Enums']["document_status"],"superseded_at"?: string | null
                  }
                  Update: {
                    "claimed_reporting_period"?: string | null,"company_id"?: string,"created_at"?: string,"extraction_request_id"?: string,"first_page"?: number,"first_row"?: number | null,"has_document_image"?: boolean,"id"?: string,"last_page"?: number,"last_row"?: number | null,"organization_id"?: string,"source_file_id"?: string,"source_sheet"?: string | null,"status"?: Database["public"]['Enums']["document_status"],"superseded_at"?: string | null
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
                    "author_user_id": string | null,"company_id": string,"created_at": string,"document_id": string,"extraction_request_id": string | null,"findings": NonNullable<Json>,"id": string,"model": string | null,"organization_id": string,"payload": NonNullable<Json>,"provider": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "author_user_id"?: string | null,"company_id": string,"created_at"?: string,"document_id": string,"extraction_request_id"?: string | null,"findings"?: NonNullable<Json>,"id"?: string,"model"?: string | null,"organization_id": string,"payload": NonNullable<Json>,"provider"?: string | null,"version": number
                  }
                  Update: {
                    "author_user_id"?: string | null,"company_id"?: string,"created_at"?: string,"document_id"?: string,"extraction_request_id"?: string | null,"findings"?: NonNullable<Json>,"id"?: string,"model"?: string | null,"organization_id"?: string,"payload"?: NonNullable<Json>,"provider"?: string | null,"version"?: number
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
      referencedRelation: "document_duplicate_warning"
      referencedColumns: ["document_id","company_id","organization_id"]
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
                    "accepted_at": string | null,"accepted_by": string | null,"company_id": string | null,"created_at": string,"created_by": string,"email": string,"expires_at": string,"id": string,"invitee_existed": boolean,"organization_id": string,"role": Database["public"]['Enums']["membership_role"],"token_hash": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"company_id"?: string | null,"created_at"?: string,"created_by"?: string,"email": string,"expires_at"?: string,"id"?: string,"invitee_existed"?: boolean,"organization_id": string,"role": Database["public"]['Enums']["membership_role"],"token_hash": string
                  }
                  Update: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"company_id"?: string | null,"created_at"?: string,"created_by"?: string,"email"?: string,"expires_at"?: string,"id"?: string,"invitee_existed"?: boolean,"organization_id"?: string,"role"?: Database["public"]['Enums']["membership_role"],"token_hash"?: string
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
                },"notification": {
                  Row: {
                    "company_id": string,"created_at": string,"dismissed_at": string | null,"id": string,"kind": string,"organization_id": string,"payload": NonNullable<Json>,"read_at": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"created_at"?: string,"dismissed_at"?: string | null,"id"?: string,"kind": string,"organization_id": string,"payload": NonNullable<Json>,"read_at"?: string | null,"user_id": string
                  }
                  Update: {
                    "company_id"?: string,"created_at"?: string,"dismissed_at"?: string | null,"id"?: string,"kind"?: string,"organization_id"?: string,"payload"?: NonNullable<Json>,"read_at"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notification_company_id_organization_id_fkey"
      columns: ["company_id","organization_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"organization": {
                  Row: {
                    "blocked_at": string | null,"blocked_by": string | null,"created_at": string,"id": string,"mfa_required": boolean,"name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "blocked_at"?: string | null,"blocked_by"?: string | null,"created_at"?: string,"id"?: string,"mfa_required"?: boolean,"name": string
                  }
                  Update: {
                    "blocked_at"?: string | null,"blocked_by"?: string | null,"created_at"?: string,"id"?: string,"mfa_required"?: boolean,"name"?: string
                  }
                  Relationships: [

                  ]
                },"period_lock": {
                  Row: {
                    "company_id": string,"locked_at": string,"locked_by": string,"organization_id": string,"period": string,"vat_report_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"locked_at"?: string,"locked_by": string,"organization_id": string,"period": string,"vat_report_id": string
                  }
                  Update: {
                    "company_id"?: string,"locked_at"?: string,"locked_by"?: string,"organization_id"?: string,"period"?: string,"vat_report_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "period_lock_company_id_organization_id_fkey"
      columns: ["company_id","organization_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "period_lock_vat_report_id_fkey"
      columns: ["vat_report_id"]
isOneToOne: false
      referencedRelation: "vat_report"
      referencedColumns: ["id"]
    }
                  ]
                },"platform_ai_provider": {
                  Row: {
                    "provider": string
                  }
                  ComputedFields: never
                  Insert: {
                    "provider": string
                  }
                  Update: {
                    "provider"?: string
                  }
                  Relationships: [

                  ]
                },"platform_settings": {
                  Row: {
                    "max_source_file_bytes": number,"max_source_file_pages": number,"max_upload_batch_files": number,"singleton": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "max_source_file_bytes": number,"max_source_file_pages": number,"max_upload_batch_files": number,"singleton"?: boolean
                  }
                  Update: {
                    "max_source_file_bytes"?: number,"max_source_file_pages"?: number,"max_upload_batch_files"?: number,"singleton"?: boolean
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
                },"reporting_year": {
                  Row: {
                    "company_id": string,"created_at": string,"first_month": number,"frequency": Database["public"]['Enums']["filing_frequency"],"organization_id": string,"year": number
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"created_at"?: string,"first_month"?: number,"frequency": Database["public"]['Enums']["filing_frequency"],"organization_id": string,"year": number
                  }
                  Update: {
                    "company_id"?: string,"created_at"?: string,"first_month"?: number,"frequency"?: Database["public"]['Enums']["filing_frequency"],"organization_id"?: string,"year"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "reporting_year_company_id_organization_id_fkey"
      columns: ["company_id","organization_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"source_file": {
                  Row: {
                    "byte_size": number,"company_id": string,"file_name": string,"format": Database["public"]['Enums']["source_file_format"],"id": string,"normalized_byte_size": number | null,"normalized_format": Database["public"]['Enums']["source_file_format"] | null,"normalized_sha256": string | null,"organization_id": string,"page_count": number,"preselected_direction": string | null,"sha256": string,"status": Database["public"]['Enums']["source_file_status"],"upload_batch_id": string | null,"uploaded_at": string,"uploaded_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "byte_size": number,"company_id": string,"file_name": string,"format": Database["public"]['Enums']["source_file_format"],"id": string,"normalized_byte_size"?: number | null,"normalized_format"?: Database["public"]['Enums']["source_file_format"] | null,"normalized_sha256"?: string | null,"organization_id": string,"page_count": number,"preselected_direction"?: string | null,"sha256": string,"status"?: Database["public"]['Enums']["source_file_status"],"upload_batch_id"?: string | null,"uploaded_at"?: string,"uploaded_by"?: string | null
                  }
                  Update: {
                    "byte_size"?: number,"company_id"?: string,"file_name"?: string,"format"?: Database["public"]['Enums']["source_file_format"],"id"?: string,"normalized_byte_size"?: number | null,"normalized_format"?: Database["public"]['Enums']["source_file_format"] | null,"normalized_sha256"?: string | null,"organization_id"?: string,"page_count"?: number,"preselected_direction"?: string | null,"sha256"?: string,"status"?: Database["public"]['Enums']["source_file_status"],"upload_batch_id"?: string | null,"uploaded_at"?: string,"uploaded_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "source_file_company_id_organization_id_fkey"
      columns: ["company_id","organization_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "source_file_upload_batch_id_company_id_organization_id_fkey"
      columns: ["upload_batch_id","company_id","organization_id"]
isOneToOne: false
      referencedRelation: "upload_batch"
      referencedColumns: ["id","company_id","organization_id"]
    }
                  ]
                },"upload_batch": {
                  Row: {
                    "company_id": string,"created_at": string,"created_by": string,"file_count": number,"id": string,"organization_id": string,"processing_finished_at": string | null,"selected_files": Json | null,"upload_finished_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"created_at"?: string,"created_by"?: string,"file_count": number,"id"?: string,"organization_id": string,"processing_finished_at"?: string | null,"selected_files"?: Json | null,"upload_finished_at"?: string | null
                  }
                  Update: {
                    "company_id"?: string,"created_at"?: string,"created_by"?: string,"file_count"?: number,"id"?: string,"organization_id"?: string,"processing_finished_at"?: string | null,"selected_files"?: Json | null,"upload_finished_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "upload_batch_company_id_organization_id_fkey"
      columns: ["company_id","organization_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"vat_report": {
                  Row: {
                    "blocker_count": number,"company_id": string,"documents": NonNullable<Json>,"generated_at": string,"generated_by": string,"id": string,"organization_id": string,"period": string,"rejected_document_count": number,"result": NonNullable<Json>,"warning_count": number
                  }
                  ComputedFields: never
                  Insert: {
                    "blocker_count"?: number,"company_id": string,"documents": NonNullable<Json>,"generated_at"?: string,"generated_by": string,"id"?: string,"organization_id": string,"period": string,"rejected_document_count"?: number,"result": NonNullable<Json>,"warning_count"?: number
                  }
                  Update: {
                    "blocker_count"?: number,"company_id"?: string,"documents"?: NonNullable<Json>,"generated_at"?: string,"generated_by"?: string,"id"?: string,"organization_id"?: string,"period"?: string,"rejected_document_count"?: number,"result"?: NonNullable<Json>,"warning_count"?: number
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
                },"vat_report_artifact": {
                  Row: {
                    "byte_size": number | null,"company_id": string,"created_at": string,"created_by": string,"file_name": string,"format": string,"id": string,"kind": string,"media_type": string,"organization_id": string,"period": string,"report_generated_at": string,"resolved_details": NonNullable<Json>,"schema_version": string,"serializer_version": string,"sha256": string | null,"vat_report_id": string,"xml_bytes": string
                  }
                  ComputedFields: never
                  Insert: {
                    "byte_size"?: never,"company_id": string,"created_at"?: string,"created_by": string,"file_name": string,"format": string,"id"?: string,"kind": string,"media_type": string,"organization_id": string,"period": string,"report_generated_at": string,"resolved_details": NonNullable<Json>,"schema_version": string,"serializer_version": string,"sha256"?: never,"vat_report_id": string,"xml_bytes": string
                  }
                  Update: {
                    "byte_size"?: never,"company_id"?: string,"created_at"?: string,"created_by"?: string,"file_name"?: string,"format"?: string,"id"?: string,"kind"?: string,"media_type"?: string,"organization_id"?: string,"period"?: string,"report_generated_at"?: string,"resolved_details"?: NonNullable<Json>,"schema_version"?: string,"serializer_version"?: string,"sha256"?: never,"vat_report_id"?: string,"xml_bytes"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "vat_report_artifact_company_id_organization_id_fkey"
      columns: ["company_id","organization_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "vat_report_artifact_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organization"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "vat_report_artifact_vat_report_id_fkey"
      columns: ["vat_report_id"]
isOneToOne: false
      referencedRelation: "vat_report"
      referencedColumns: ["id"]
    }
                  ]
                },"vat_report_transition": {
                  Row: {
                    "action": string,"actor_user_id": string,"company_id": string,"id": number,"occurred_at": string,"organization_id": string,"period": string,"unlock_reason": string | null,"vat_report_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_user_id": string,"company_id": string,"id"?: never,"occurred_at"?: string,"organization_id": string,"period": string,"unlock_reason"?: string | null,"vat_report_id": string
                  }
                  Update: {
                    "action"?: string,"actor_user_id"?: string,"company_id"?: string,"id"?: never,"occurred_at"?: string,"organization_id"?: string,"period"?: string,"unlock_reason"?: string | null,"vat_report_id"?: string
                  }
                  Relationships: [

                  ]
                }
          }
          Views: {
            "document_duplicate_warning": {
                  Row: {
                    "company_id": string,"document_id": string,"kind": string | null,"matched_document_id": string | null,"organization_id": string
                  }
                  ComputedFields: never
                  Relationships: [

                  ]
                },"document_overview": {
                  Row: {
                    "claimed_reporting_period": string | null,"company_id": string,"counterparty_ico": string | null,"counterparty_name": string | null,"counterparty_search": string | null,"counterparty_vat_id": string | null,"created_at": string,"currency": string | null,"direction": string | null,"document_number": string | null,"finding_count": number | null,"first_page": number,"gross_amount": string | null,"id": string,"import_date": string | null,"last_page": number,"organization_id": string,"reporting_period": string | null,"source_file_id": string,"status": Database["public"]['Enums']["document_status"],"tax_point_date": string | null,"version": number | null
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
                },"upload_batch_summary": {
                  Row: {
                    "actual_file_count": number | null,"company_id": string,"created_at": string,"document_failure_count": number | null,"extracting_count": number | null,"file_count": number,"id": string,"processing_finished_at": string | null,"review_count": number | null,"reviewed_count": number | null,"source_failure_count": number | null,"splitting_count": number | null,"transport_count": number | null,"transport_failure_count": number | null,"upload_finished_at": string | null,"waiting_count": number | null
                  }
                  ComputedFields: never
                  Relationships: [

                  ]
                },"vat_report_document": {
                  Row: {
                    "claimed_reporting_period": string | null,"company_id": string,"extraction_version_id": string | null,"id": string,"organization_id": string,"payload": Json | null,"status": Database["public"]['Enums']["document_status"]
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
"assign_company_ai_configuration":
{ Args: { "target_company_id": string,"target_configuration_id": string }; Returns: undefined
                           },
"audit_actors":
{ Args: { "target_organization_id": string }; Returns: {
              "email": string,"user_id": string
            }[]
                           },
"audit_companies":
{ Args: { "target_organization_id": string }; Returns: {
              "id": string,"name": string
            }[]
                           },
"begin_upload_batch":
{ Args: { "requested_batch_id"?: string,"selected_file_count": number,"selected_files"?: Json,"target_company_id": string }; Returns: string
                           },
"cancel_invitation":
{ Args: { "invitation_token": string }; Returns: undefined
                           },
"change_company_reporting_year_frequency":
{ Args: { "new_frequency": Database["public"]['Enums']["filing_frequency"],"target_company_id": string,"target_year": number }; Returns: undefined
                           },
"change_membership_role":
{ Args: { "target_membership_id": string,"target_role": Database["public"]['Enums']["membership_role"] }; Returns: undefined
                           },
"clear_default_ai_configuration":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"company_ai_processing_allowance":
{ Args: { "target_company_id": string }; Returns: {
              "allowance": number,"used": number,"waiting_documents": number
            }[]
                           },
"company_data_export_for_completion":
{ Args: { "target_export_id": string }; Returns: Json
                           },
"company_data_export_status":
{ Args: { "target_company_id": string,"target_export_id": string }; Returns: string
                           },
"company_export_snapshot":
{ Args: { "target_company_id": string }; Returns: Json
                           },
"complete_company_data_export":
{ Args: { "target_byte_size": number,"target_export_id": string,"target_sha256": string }; Returns: undefined
                           },
"correct_document":
{ Args: { "based_on_version": number,"findings": Json,"payload": Json,"target_document_id": string }; Returns: number
                           },
"create_ai_configuration":
{ Args: { "configuration_label": string,"provider_credential": string,"target_extract_model": string,"target_provider": string,"target_split_model": string }; Returns: string
                           },
"create_company_data_export":
{ Args: { "target_company_id": string }; Returns: Json
                           },
"create_company_identity":
{ Args: { "company_city": string,"company_first_name": string,"company_house_number": string,"company_ico": string,"company_last_name": string,"company_name": string,"company_orientation_number": string,"company_person_type": Database["public"]['Enums']["person_type"],"company_postal_code": string,"company_street_name": string,"company_vat_id": string,"target_organization_id": string }; Returns: string
                           },
"create_draft_vat_report_artifact":
{ Args: { "target_company_id": string,"target_file_name": string,"target_format": string,"target_report_generated_at": string,"target_resolved_details": Json,"target_schema_version": string,"target_serializer_version": string,"target_vat_report_id": string,"target_xml_base64": string }; Returns: string
                           },
"create_final_vat_report_artifact":
{ Args: { "target_company_id": string,"target_file_name": string,"target_format": string,"target_report_generated_at": string,"target_resolved_details": Json,"target_schema_version": string,"target_serializer_version": string,"target_vat_report_id": string,"target_xml_base64": string }; Returns: string
                           },
"create_invitation":
{ Args: { "target_company_id": string,"target_email": string,"target_organization_id": string,"target_role": Database["public"]['Enums']["membership_role"] }; Returns: string
                           },
"current_company_role":
{ Args: { "target_company_id": string }; Returns: Database["public"]['Enums']["membership_role"]
                           },
"current_mfa_policy":
{ Args: Record<PropertyKey, never>; Returns: {
              "enrolled": boolean,"required": boolean,"satisfied": boolean
            }[]
                           },
"current_user_can_administrate_platform":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"current_user_can_use_application":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"delete_company_reporting_year":
{ Args: { "target_company_id": string,"target_year": number }; Returns: undefined
                           },
"delete_upload_batch":
{ Args: { "target_batch_id": string }; Returns: (string)[]
                           },
"dismiss_company_upload_notifications":
{ Args: { "target_company_id": string }; Returns: undefined
                           },
"dismiss_upload_notification":
{ Args: { "target_notification_id": string }; Returns: undefined
                           },
"fail_company_data_export":
{ Args: { "target_export_id": string }; Returns: undefined
                           },
"finalize_vat_report":
{ Args: { "finalization_confirmed": boolean,"target_company_id": string,"target_period": string }; Returns: undefined
                           },
"finish_mfa_disenrollment":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"finish_mfa_enrollment":
{ Args: Record<PropertyKey, never>; Returns: (string)[]
                           },
"finish_upload_batch":
{ Args: { "target_batch_id": string }; Returns: undefined
                           },
"forget_removed_source_file_objects":
{ Args: { "target_company_id": string }; Returns: undefined
                           },
"generate_company_reporting_years":
{ Args: { "from_year": number,"new_frequency": Database["public"]['Enums']["filing_frequency"],"target_company_id": string,"to_year": number }; Returns: Json
                           },
"invitation_onboarding":
{ Args: { "invitation_token": string }; Returns: {
              "invitee_email": string,"invitee_existed": boolean,"onboarding_status": string,"target_company_id": string
            }[]
                           },
"list_ai_configuration_providers":
{ Args: Record<PropertyKey, never>; Returns: (string)[]
                           },
"list_ai_configurations":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"list_ai_model_prices":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"list_company_access":
{ Args: { "target_company_id": string }; Returns: Json
                           },
"list_failed_processing_jobs":
{ Args: Record<PropertyKey, never>; Returns: {
              "error": string,"failed_at": string,"id": string,"name": string,"target_id": string
            }[]
                           },
"list_organization_administrations":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"list_platform_ai_processing_allowances":
{ Args: Record<PropertyKey, never>; Returns: {
              "allowance": number,"company_id": string,"company_name": string,"configuration_id": string,"configuration_label": string,"organization_id": string,"organization_name": string,"provider": string,"used": number,"waiting_documents": number
            }[]
                           },
"list_platform_ai_processing_issues":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"list_platform_ai_usage":
{ Args: { "group_by": string,"period_from": string,"period_to": string,"target_company_id"?: string,"target_configuration_id"?: string,"target_model"?: string,"target_operation"?: string,"target_organization_id"?: string }; Returns: {
              "cost_usd": number,"group_key": string,"group_label": string,"input_tokens": number,"output_tokens": number,"requests": number,"unknown_cost_events": number
            }[]
                           },
"list_platform_ai_usage_models":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"list_platform_operational_context":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"list_platform_organization_companies":
{ Args: Record<PropertyKey, never>; Returns: {
              "company_ico": string,"company_id": string,"company_name": string,"organization_blocked": boolean,"organization_id": string,"organization_name": string
            }[]
                           },
"list_platform_organization_companies_complete":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"mark_company_upload_notifications_read":
{ Args: { "target_company_id": string }; Returns: undefined
                           },
"mark_upload_batch_notification_read":
{ Args: { "target_batch_id": string }; Returns: boolean
                           },
"mark_upload_notification_read":
{ Args: { "target_notification_id": string }; Returns: undefined
                           },
"merge_documents":
{ Args: { "left_document_id": string,"right_document_id": string }; Returns: (string)[]
                           },
"mfa_recovery_codes_remaining":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"move_document_page":
{ Args: { "page": number,"source_document_id": string,"target_document_id": string }; Returns: (string)[]
                           },
"platform_company_history":
{ Args: { "target_company_id": string }; Returns: Json
                           },
"platform_upload_limits":
{ Args: Record<PropertyKey, never>; Returns: {
              "max_source_file_bytes": number,"max_source_file_pages": number,"max_upload_batch_files": number
            }[]
                           },
"read_vat_report_artifact":
{ Args: { "target_artifact_id": string,"target_company_id": string }; Returns: Json
                           },
"record_ai_extraction":
{ Args: { "findings": Json,"model": string,"payload": Json,"provider": string,"target_document_id": string,"target_extraction_request_id": string,"target_reservation_id": string }; Returns: undefined
                           },
"record_ai_processing_issue":
{ Args: { "target_classification": Database["public"]['Enums']["ai_processing_issue_classification"],"target_configuration_id"?: string,"target_id": string,"target_kind": Database["public"]['Enums']["ai_processing_target_kind"],"target_provider"?: string,"target_state": Database["public"]['Enums']["ai_processing_issue_state"] }; Returns: undefined
                           },
"record_ai_usage":
{ Args: { "target_company_id": string,"target_configuration_id": string,"target_input_tokens": number,"target_job_id": string,"target_job_name": string,"target_model": string,"target_operation": string,"target_organization_id": string,"target_output_tokens": number,"target_provider": string,"target_provider_cost_usd"?: number }; Returns: undefined
                           },
"record_split":
{ Args: { "source_ranges": Json,"target_source_file_id": string }; Returns: undefined
                           },
"reject_document":
{ Args: { "target_document_id": string }; Returns: undefined
                           },
"release_ai_processing_reservation":
{ Args: { "target_reservation_id": string }; Returns: undefined
                           },
"remove_membership":
{ Args: { "target_membership_id": string }; Returns: undefined
                           },
"reprocess_document":
{ Args: { "target_document_id": string }; Returns: undefined
                           },
"reserve_ai_processing":
{ Args: { "target_document_id": string,"target_extraction_request_id": string,"target_reservation_id": string }; Returns: string
                           },
"resolve_assigned_ai_configuration":
{ Args: { "target_company_id": string }; Returns: {
              "api_key": string,"configuration_id": string,"extract_model": string,"is_explicit": boolean,"provider": string,"split_model": string
            }[]
                           },
"restore_ai_processing_allowance_wait":
{ Args: { "target_company_id": string,"target_document_ids": (string)[] }; Returns: undefined
                           },
"restore_platform_ai_processing_wait":
{ Args: { "target_work": Json }; Returns: undefined
                           },
"resume_platform_ai_processing":
{ Args: { "target_company_id"?: string,"target_configuration_id"?: string }; Returns: {
              "classification": Database["public"]['Enums']["ai_processing_issue_classification"],"configuration_id": string,"first_detected_at": string,"provider": string,"target_id": string,"target_kind": Database["public"]['Enums']["ai_processing_target_kind"]
            }[]
                           },
"retry_failed_processing_job":
{ Args: { "target_failed_job_id": string }; Returns: undefined
                           },
"retry_split":
{ Args: { "target_source_file_id": string }; Returns: undefined
                           },
"return_document_to_review":
{ Args: { "target_document_id": string }; Returns: undefined
                           },
"save_vat_report":
{ Args: { "computed_result": Json,"expected_documents": Json,"target_company_id": string,"target_period": string }; Returns: string
                           },
"set_ai_model_prices":
{ Args: { "prices": Json,"target_configuration_id": string }; Returns: undefined
                           },
"set_company_ai_processing_allowance":
{ Args: { "target_allowance": number,"target_company_id": string }; Returns: {
              "document_id": string
            }[]
                           },
"set_company_filing_defaults":
{ Args: { "epo_address_confirmed": boolean,"new_economic_activity"?: string,"new_email": string,"new_epo_city": string,"new_epo_house_number": string,"new_epo_orientation_number": string,"new_epo_postal_code": string,"new_epo_street_name": string,"new_phone": string,"new_signatory_capacity": string,"new_signatory_first_name": string,"new_signatory_last_name": string,"new_tax_office": string,"new_territorial_office"?: string,"target_company_id": string }; Returns: undefined
                           },
"set_company_first_reporting_month":
{ Args: { "new_first_month": number,"target_company_id": string,"target_year": number }; Returns: undefined
                           },
"set_company_reporting_year":
{ Args: { "new_frequency": Database["public"]['Enums']["filing_frequency"],"target_company_id": string,"target_year": number }; Returns: undefined
                           },
"set_default_ai_configuration":
{ Args: { "target_configuration_id": string }; Returns: undefined
                           },
"set_organization_mfa_required":
{ Args: { "required": boolean,"target_organization_id": string }; Returns: undefined
                           },
"set_platform_organization_blocked":
{ Args: { "organization_blocked": boolean,"target_organization_id": string }; Returns: undefined
                           },
"set_platform_upload_limits":
{ Args: { "target_max_source_file_bytes": number,"target_max_source_file_pages": number,"target_max_upload_batch_files": number }; Returns: undefined
                           },
"soft_delete_company":
{ Args: { "target_company_id": string,"target_export_id": string }; Returns: Json
                           },
"split_document":
{ Args: { "split_after_page": number,"target_document_id": string }; Returns: (string)[]
                           },
"unlock_reporting_period":
{ Args: { "target_company_id": string,"target_period": string,"unlock_confirmed": boolean,"unlock_reason": string }; Returns: undefined
                           },
"update_ai_configuration":
{ Args: { "configuration_label": string,"provider_credential"?: string,"target_configuration_id": string,"target_extract_model": string,"target_provider": string,"target_split_model": string }; Returns: undefined
                           },
"update_company_identity":
{ Args: { "company_city": string,"company_first_name": string,"company_house_number": string,"company_ico": string,"company_last_name": string,"company_name": string,"company_orientation_number": string,"company_person_type": Database["public"]['Enums']["person_type"],"company_postal_code": string,"company_street_name": string,"company_vat_id": string,"target_company_id": string }; Returns: undefined
                           },
"update_document_reporting":
{ Args: { "new_claimed_reporting_period": string,"target_document_id": string }; Returns: undefined
                           },
"upload_batch_deletion_refusal":
{ Args: { "target_batch_id": string }; Returns: string
                           },
"upload_batches_in_reporting_period":
{ Args: { "target_company_id": string,"target_period"?: string }; Returns: {
              "company_id": string,
"created_at": string,
"created_by": string,
"file_count": number,
"id": string,
"organization_id": string,
"processing_finished_at": string | null,
"selected_files": Json | null,
"upload_finished_at": string | null
            }[]
                          SetofOptions: {
        from: "*"
        to: "upload_batch"
        isOneToOne: false
        isSetofReturn: true
      } },
"vat_report_artifact_history":
{ Args: { "target_company_id": string,"target_period": string }; Returns: Json
                           },
"vat_report_documents":
{ Args: { "target_company_id": string,"target_period": string }; Returns: Json
                           },
"vat_report_transition_history":
{ Args: { "target_company_id": string,"target_period": string }; Returns: {
              "action": string,"actor_email": string,"actor_user_id": string,"id": number,"occurred_at": string,"unlock_reason": string,"vat_report_id": string
            }[]
                           },
"verify_mfa_recovery_code":
{ Args: { "input_code": string }; Returns: boolean
                           }
          }
          Enums: {
            "ai_processing_issue_classification": "configuration_missing"|"configuration_unusable"|"invalid_credentials"|"provider_credits_exhausted"|"provider_unavailable"|"provider_response_invalid"|"processing_failed","ai_processing_issue_state": "waiting_for_platform"|"terminal","ai_processing_target_kind": "source_file"|"document","company_setup_state": "completed"|"skipped","company_setup_step": "identity"|"filing_frequency"|"filing_defaults"|"ai_processing","document_status": "uploaded"|"waiting_for_allowance"|"waiting_for_platform"|"processing"|"needs_review"|"failed"|"approved"|"rejected","filing_frequency": "monthly"|"quarterly","membership_role": "administrator"|"user","person_type": "legal"|"natural","platform_role": "super_admin","source_file_format": "pdf"|"png"|"jpeg"|"xlsx"|"xls"|"heic"|"heif","source_file_status": "uploaded"|"waiting_for_platform"|"processing"|"split"|"failed"
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
            "ai_processing_issue_classification": ["configuration_missing", "configuration_unusable", "invalid_credentials", "provider_credits_exhausted", "provider_unavailable", "provider_response_invalid", "processing_failed"],"ai_processing_issue_state": ["waiting_for_platform", "terminal"],"ai_processing_target_kind": ["source_file", "document"],"company_setup_state": ["completed", "skipped"],"company_setup_step": ["identity", "filing_frequency", "filing_defaults", "ai_processing"],"document_status": ["uploaded", "waiting_for_allowance", "waiting_for_platform", "processing", "needs_review", "failed", "approved", "rejected"],"filing_frequency": ["monthly", "quarterly"],"membership_role": ["administrator", "user"],"person_type": ["legal", "natural"],"platform_role": ["super_admin"],"source_file_format": ["pdf", "png", "jpeg", "xlsx", "xls", "heic", "heif"],"source_file_status": ["uploaded", "waiting_for_platform", "processing", "split", "failed"]
          }
        }
} as const
