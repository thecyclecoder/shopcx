export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      ai_channel_config: {
        Row: {
          ai_turn_limit: number
          auto_resolve: boolean
          channel: string
          confidence_threshold: number
          created_at: string
          enabled: boolean
          id: string
          instructions: string
          max_response_length: number | null
          personality_id: string | null
          sandbox: boolean
          updated_at: string
          workspace_id: string
        }
        Insert: {
          ai_turn_limit?: number
          auto_resolve?: boolean
          channel: string
          confidence_threshold?: number
          created_at?: string
          enabled?: boolean
          id?: string
          instructions?: string
          max_response_length?: number | null
          personality_id?: string | null
          sandbox?: boolean
          updated_at?: string
          workspace_id: string
        }
        Update: {
          ai_turn_limit?: number
          auto_resolve?: boolean
          channel?: string
          confidence_threshold?: number
          created_at?: string
          enabled?: boolean
          id?: string
          instructions?: string
          max_response_length?: number | null
          personality_id?: string | null
          sandbox?: boolean
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_channel_config_personality_id_fkey"
            columns: ["personality_id"]
            isOneToOne: false
            referencedRelation: "ai_personalities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_channel_config_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_personalities: {
        Row: {
          created_at: string
          description: string | null
          emoji_usage: string
          greeting: string | null
          id: string
          language: string
          name: string
          sign_off: string | null
          style_instructions: string
          tone: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          emoji_usage?: string
          greeting?: string | null
          id?: string
          language?: string
          name: string
          sign_off?: string | null
          style_instructions?: string
          tone?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          emoji_usage?: string
          greeting?: string | null
          id?: string
          language?: string
          name?: string
          sign_off?: string | null
          style_instructions?: string
          tone?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_personalities_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_workflows: {
        Row: {
          allowed_actions: Json
          config: Json
          created_at: string
          description: string | null
          enabled: boolean
          id: string
          match_categories: string[] | null
          match_patterns: string[] | null
          name: string
          post_response_workflow_id: string | null
          preferred_kb_ids: string[] | null
          preferred_macro_id: string | null
          priority: number
          response_source: string
          trigger_intent: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          allowed_actions?: Json
          config?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          match_categories?: string[] | null
          match_patterns?: string[] | null
          name: string
          post_response_workflow_id?: string | null
          preferred_kb_ids?: string[] | null
          preferred_macro_id?: string | null
          priority?: number
          response_source?: string
          trigger_intent: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          allowed_actions?: Json
          config?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          match_categories?: string[] | null
          match_patterns?: string[] | null
          name?: string
          post_response_workflow_id?: string | null
          preferred_kb_ids?: string[] | null
          preferred_macro_id?: string | null
          priority?: number
          response_source?: string
          trigger_intent?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_workflows_post_response_workflow_id_fkey"
            columns: ["post_response_workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_workflows_preferred_macro_id_fkey"
            columns: ["preferred_macro_id"]
            isOneToOne: false
            referencedRelation: "macros"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_workflows_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      chargeback_events: {
        Row: {
          amount_cents: number | null
          auto_action_at: string | null
          auto_action_taken: string | null
          created_at: string
          currency: string | null
          customer_id: string | null
          dispute_type: string
          evidence_due_by: string | null
          evidence_sent_on: string | null
          finalized_on: string | null
          fraud_case_id: string | null
          id: string
          initiated_at: string
          network_reason_code: string | null
          raw_payload: Json
          reason: string | null
          shopify_dispute_id: string
          shopify_order_id: string | null
          status: string
          ticket_id: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          amount_cents?: number | null
          auto_action_at?: string | null
          auto_action_taken?: string | null
          created_at?: string
          currency?: string | null
          customer_id?: string | null
          dispute_type: string
          evidence_due_by?: string | null
          evidence_sent_on?: string | null
          finalized_on?: string | null
          fraud_case_id?: string | null
          id?: string
          initiated_at?: string
          network_reason_code?: string | null
          raw_payload?: Json
          reason?: string | null
          shopify_dispute_id: string
          shopify_order_id?: string | null
          status?: string
          ticket_id?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          amount_cents?: number | null
          auto_action_at?: string | null
          auto_action_taken?: string | null
          created_at?: string
          currency?: string | null
          customer_id?: string | null
          dispute_type?: string
          evidence_due_by?: string | null
          evidence_sent_on?: string | null
          finalized_on?: string | null
          fraud_case_id?: string | null
          id?: string
          initiated_at?: string
          network_reason_code?: string | null
          raw_payload?: Json
          reason?: string | null
          shopify_dispute_id?: string
          shopify_order_id?: string | null
          status?: string
          ticket_id?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chargeback_events_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chargeback_events_fraud_case_id_fkey"
            columns: ["fraud_case_id"]
            isOneToOne: false
            referencedRelation: "fraud_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chargeback_events_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "tickets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chargeback_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      chargeback_subscription_actions: {
        Row: {
          action: string
          cancellation_reason: string | null
          chargeback_event_id: string
          customer_id: string
          executed_at: string
          executed_by: string
          id: string
          subscription_id: string | null
          workspace_id: string
        }
        Insert: {
          action: string
          cancellation_reason?: string | null
          chargeback_event_id: string
          customer_id: string
          executed_at?: string
          executed_by?: string
          id?: string
          subscription_id?: string | null
          workspace_id: string
        }
        Update: {
          action?: string
          cancellation_reason?: string | null
          chargeback_event_id?: string
          customer_id?: string
          executed_at?: string
          executed_by?: string
          id?: string
          subscription_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chargeback_subscription_actions_chargeback_event_id_fkey"
            columns: ["chargeback_event_id"]
            isOneToOne: false
            referencedRelation: "chargeback_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chargeback_subscription_actions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chargeback_subscription_actions_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chargeback_subscription_actions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_events: {
        Row: {
          created_at: string
          customer_id: string | null
          event_type: string
          id: string
          properties: Json | null
          source: string
          summary: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          customer_id?: string | null
          event_type: string
          id?: string
          properties?: Json | null
          source: string
          summary?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          customer_id?: string | null
          event_type?: string
          id?: string
          properties?: Json | null
          source?: string
          summary?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_events_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_links: {
        Row: {
          created_at: string
          customer_id: string
          group_id: string
          id: string
          is_primary: boolean
          workspace_id: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          group_id: string
          id?: string
          is_primary?: boolean
          workspace_id: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          group_id?: string
          id?: string
          is_primary?: boolean
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_links_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_links_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          addresses: Json | null
          created_at: string
          default_address: Json | null
          email: string
          email_marketing_status: string | null
          first_name: string | null
          first_order_at: string | null
          id: string
          last_name: string | null
          last_order_at: string | null
          locale: string | null
          ltv_cents: number | null
          note: string | null
          phone: string | null
          retention_score: number | null
          shopify_created_at: string | null
          shopify_customer_id: string | null
          shopify_state: string | null
          sms_marketing_status: string | null
          stripe_customer_id: string | null
          subscription_status: string | null
          subscription_tenure_days: number | null
          tags: string[] | null
          total_orders: number | null
          updated_at: string
          valid_email: boolean | null
          workspace_id: string
        }
        Insert: {
          addresses?: Json | null
          created_at?: string
          default_address?: Json | null
          email: string
          email_marketing_status?: string | null
          first_name?: string | null
          first_order_at?: string | null
          id?: string
          last_name?: string | null
          last_order_at?: string | null
          locale?: string | null
          ltv_cents?: number | null
          note?: string | null
          phone?: string | null
          retention_score?: number | null
          shopify_created_at?: string | null
          shopify_customer_id?: string | null
          shopify_state?: string | null
          sms_marketing_status?: string | null
          stripe_customer_id?: string | null
          subscription_status?: string | null
          subscription_tenure_days?: number | null
          tags?: string[] | null
          total_orders?: number | null
          updated_at?: string
          valid_email?: boolean | null
          workspace_id: string
        }
        Update: {
          addresses?: Json | null
          created_at?: string
          default_address?: Json | null
          email?: string
          email_marketing_status?: string | null
          first_name?: string | null
          first_order_at?: string | null
          id?: string
          last_name?: string | null
          last_order_at?: string | null
          locale?: string | null
          ltv_cents?: number | null
          note?: string | null
          phone?: string | null
          retention_score?: number | null
          shopify_created_at?: string | null
          shopify_customer_id?: string | null
          shopify_state?: string | null
          sms_marketing_status?: string | null
          stripe_customer_id?: string | null
          subscription_status?: string | null
          subscription_tenure_days?: number | null
          tags?: string[] | null
          total_orders?: number | null
          updated_at?: string
          valid_email?: boolean | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      dashboard_notifications: {
        Row: {
          body: string | null
          created_at: string
          dismissed: boolean
          id: string
          link: string | null
          metadata: Json | null
          read: boolean
          title: string
          type: string
          user_id: string | null
          workspace_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          dismissed?: boolean
          id?: string
          link?: string | null
          metadata?: Json | null
          read?: boolean
          title: string
          type: string
          user_id?: string | null
          workspace_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          dismissed?: boolean
          id?: string
          link?: string | null
          metadata?: Json | null
          read?: boolean
          title?: string
          type?: string
          user_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dashboard_notifications_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      fraud_case_history: {
        Row: {
          action: string
          case_id: string
          created_at: string
          id: string
          new_value: string | null
          notes: string | null
          old_value: string | null
          user_id: string | null
          workspace_id: string
        }
        Insert: {
          action: string
          case_id: string
          created_at?: string
          id?: string
          new_value?: string | null
          notes?: string | null
          old_value?: string | null
          user_id?: string | null
          workspace_id: string
        }
        Update: {
          action?: string
          case_id?: string
          created_at?: string
          id?: string
          new_value?: string | null
          notes?: string | null
          old_value?: string | null
          user_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fraud_case_history_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "fraud_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fraud_case_history_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      fraud_cases: {
        Row: {
          assigned_to: string | null
          created_at: string
          customer_ids: string[] | null
          dismissal_reason: string | null
          evidence: Json
          first_detected_at: string
          id: string
          last_seen_at: string
          order_ids: string[] | null
          resolution: string | null
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          rule_id: string
          rule_type: string
          severity: string
          status: string
          summary: string | null
          title: string
          workspace_id: string
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string
          customer_ids?: string[] | null
          dismissal_reason?: string | null
          evidence?: Json
          first_detected_at?: string
          id?: string
          last_seen_at?: string
          order_ids?: string[] | null
          resolution?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          rule_id: string
          rule_type: string
          severity?: string
          status?: string
          summary?: string | null
          title: string
          workspace_id: string
        }
        Update: {
          assigned_to?: string | null
          created_at?: string
          customer_ids?: string[] | null
          dismissal_reason?: string | null
          evidence?: Json
          first_detected_at?: string
          id?: string
          last_seen_at?: string
          order_ids?: string[] | null
          resolution?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          rule_id?: string
          rule_type?: string
          severity?: string
          status?: string
          summary?: string | null
          title?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fraud_cases_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fraud_cases_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fraud_cases_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "fraud_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fraud_cases_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      fraud_rule_matches: {
        Row: {
          case_id: string
          created_at: string
          customer_id: string | null
          id: string
          match_type: string
          match_value: string
          order_amount_cents: number | null
          order_date: string | null
          order_id: string | null
          workspace_id: string
        }
        Insert: {
          case_id: string
          created_at?: string
          customer_id?: string | null
          id?: string
          match_type: string
          match_value: string
          order_amount_cents?: number | null
          order_date?: string | null
          order_id?: string | null
          workspace_id: string
        }
        Update: {
          case_id?: string
          created_at?: string
          customer_id?: string | null
          id?: string
          match_type?: string
          match_value?: string
          order_amount_cents?: number | null
          order_date?: string | null
          order_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fraud_rule_matches_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "fraud_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fraud_rule_matches_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fraud_rule_matches_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      fraud_rules: {
        Row: {
          config: Json
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          is_seeded: boolean
          name: string
          rule_type: string
          severity: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          config?: Json
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          is_seeded?: boolean
          name: string
          rule_type: string
          severity?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          config?: Json
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          is_seeded?: boolean
          name?: string
          rule_type?: string
          severity?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fraud_rules_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      import_jobs: {
        Row: {
          completed_at: string | null
          completed_chunks: number | null
          created_at: string
          error: string | null
          failed_chunk_index: number | null
          failed_records: number | null
          file_path: string
          finalize_completed: number | null
          finalize_total: number | null
          id: string
          processed_records: number | null
          started_at: string | null
          status: string
          total_chunks: number | null
          total_records: number | null
          type: string
          workspace_id: string
        }
        Insert: {
          completed_at?: string | null
          completed_chunks?: number | null
          created_at?: string
          error?: string | null
          failed_chunk_index?: number | null
          failed_records?: number | null
          file_path: string
          finalize_completed?: number | null
          finalize_total?: number | null
          id?: string
          processed_records?: number | null
          started_at?: string | null
          status?: string
          total_chunks?: number | null
          total_records?: number | null
          type: string
          workspace_id: string
        }
        Update: {
          completed_at?: string | null
          completed_chunks?: number | null
          created_at?: string
          error?: string | null
          failed_chunk_index?: number | null
          failed_records?: number | null
          file_path?: string
          finalize_completed?: number | null
          finalize_total?: number | null
          id?: string
          processed_records?: number | null
          started_at?: string | null
          status?: string
          total_chunks?: number | null
          total_records?: number | null
          type?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_jobs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      journey_definitions: {
        Row: {
          config: Json
          created_at: string
          id: string
          is_active: boolean
          journey_type: string
          name: string
          slug: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          config?: Json
          created_at?: string
          id?: string
          is_active?: boolean
          journey_type: string
          name: string
          slug: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          config?: Json
          created_at?: string
          id?: string
          is_active?: boolean
          journey_type?: string
          name?: string
          slug?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "journey_definitions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      journey_sessions: {
        Row: {
          completed_at: string | null
          config_snapshot: Json
          created_at: string
          current_step: number
          customer_id: string
          id: string
          journey_id: string
          outcome: string | null
          outcome_action_taken: boolean
          responses: Json
          started_at: string | null
          status: string
          subscription_id: string | null
          ticket_id: string | null
          token: string
          token_expires_at: string
          workspace_id: string
        }
        Insert: {
          completed_at?: string | null
          config_snapshot?: Json
          created_at?: string
          current_step?: number
          customer_id: string
          id?: string
          journey_id: string
          outcome?: string | null
          outcome_action_taken?: boolean
          responses?: Json
          started_at?: string | null
          status?: string
          subscription_id?: string | null
          ticket_id?: string | null
          token: string
          token_expires_at: string
          workspace_id: string
        }
        Update: {
          completed_at?: string | null
          config_snapshot?: Json
          created_at?: string
          current_step?: number
          customer_id?: string
          id?: string
          journey_id?: string
          outcome?: string | null
          outcome_action_taken?: boolean
          responses?: Json
          started_at?: string | null
          status?: string
          subscription_id?: string | null
          ticket_id?: string | null
          token?: string
          token_expires_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "journey_sessions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journey_sessions_journey_id_fkey"
            columns: ["journey_id"]
            isOneToOne: false
            referencedRelation: "journey_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journey_sessions_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journey_sessions_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "tickets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journey_sessions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      journey_step_events: {
        Row: {
          created_at: string
          id: string
          response_label: string
          response_value: string
          session_id: string
          step_index: number
          step_key: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          response_label: string
          response_value: string
          session_id: string
          step_index: number
          step_key: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          response_label?: string
          response_value?: string
          session_id?: string
          step_index?: number
          step_key?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "journey_step_events_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "journey_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journey_step_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      kb_chunks: {
        Row: {
          chunk_index: number
          chunk_text: string
          created_at: string
          embedding: string | null
          id: string
          kb_id: string
          workspace_id: string
        }
        Insert: {
          chunk_index: number
          chunk_text: string
          created_at?: string
          embedding?: string | null
          id?: string
          kb_id: string
          workspace_id: string
        }
        Update: {
          chunk_index?: number
          chunk_text?: string
          created_at?: string
          embedding?: string | null
          id?: string
          kb_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "kb_chunks_kb_id_fkey"
            columns: ["kb_id"]
            isOneToOne: false
            referencedRelation: "knowledge_base"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kb_chunks_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_base: {
        Row: {
          active: boolean
          category: string
          content: string
          content_html: string | null
          created_at: string
          excerpt: string | null
          helpful_no: number
          helpful_yes: number
          id: string
          product_id: string | null
          product_name: string | null
          product_shopify_id: string | null
          published: boolean | null
          slug: string | null
          source: string
          title: string
          updated_at: string
          view_count: number
          workspace_id: string
        }
        Insert: {
          active?: boolean
          category: string
          content: string
          content_html?: string | null
          created_at?: string
          excerpt?: string | null
          helpful_no?: number
          helpful_yes?: number
          id?: string
          product_id?: string | null
          product_name?: string | null
          product_shopify_id?: string | null
          published?: boolean | null
          slug?: string | null
          source?: string
          title: string
          updated_at?: string
          view_count?: number
          workspace_id: string
        }
        Update: {
          active?: boolean
          category?: string
          content?: string
          content_html?: string | null
          created_at?: string
          excerpt?: string | null
          helpful_no?: number
          helpful_yes?: number
          id?: string
          product_id?: string | null
          product_name?: string | null
          product_shopify_id?: string | null
          published?: boolean | null
          slug?: string | null
          source?: string
          title?: string
          updated_at?: string
          view_count?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_base_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_base_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_gaps: {
        Row: {
          created_at: string
          created_kb_id: string | null
          id: string
          sample_ticket_ids: string[] | null
          status: string
          suggested_category: string | null
          suggested_content: string | null
          suggested_title: string | null
          ticket_count: number
          topic: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_kb_id?: string | null
          id?: string
          sample_ticket_ids?: string[] | null
          status?: string
          suggested_category?: string | null
          suggested_content?: string | null
          suggested_title?: string | null
          ticket_count?: number
          topic: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_kb_id?: string | null
          id?: string
          sample_ticket_ids?: string[] | null
          status?: string
          suggested_category?: string | null
          suggested_content?: string | null
          suggested_title?: string | null
          ticket_count?: number
          topic?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_gaps_created_kb_id_fkey"
            columns: ["created_kb_id"]
            isOneToOne: false
            referencedRelation: "knowledge_base"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_gaps_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      macro_usage_log: {
        Row: {
          ai_confidence: number | null
          created_at: string
          id: string
          macro_id: string
          message_id: string | null
          outcome: string
          source: string
          ticket_id: string | null
          user_id: string | null
          workspace_id: string
        }
        Insert: {
          ai_confidence?: number | null
          created_at?: string
          id?: string
          macro_id: string
          message_id?: string | null
          outcome: string
          source: string
          ticket_id?: string | null
          user_id?: string | null
          workspace_id: string
        }
        Update: {
          ai_confidence?: number | null
          created_at?: string
          id?: string
          macro_id?: string
          message_id?: string | null
          outcome?: string
          source?: string
          ticket_id?: string | null
          user_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "macro_usage_log_macro_id_fkey"
            columns: ["macro_id"]
            isOneToOne: false
            referencedRelation: "macros"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "macro_usage_log_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "ticket_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "macro_usage_log_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "tickets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "macro_usage_log_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      macros: {
        Row: {
          actions: Json | null
          active: boolean
          ai_accept_count: number
          ai_edit_count: number
          ai_reject_count: number
          ai_suggest_count: number
          body_html: string | null
          body_text: string
          category: string | null
          created_at: string
          embedding: string | null
          embedding_text: string | null
          gorgias_id: number | null
          id: string
          last_suggested_at: string | null
          name: string
          product_id: string | null
          tags: string[] | null
          updated_at: string
          usage_count: number
          variables: string[] | null
          workspace_id: string
        }
        Insert: {
          actions?: Json | null
          active?: boolean
          ai_accept_count?: number
          ai_edit_count?: number
          ai_reject_count?: number
          ai_suggest_count?: number
          body_html?: string | null
          body_text: string
          category?: string | null
          created_at?: string
          embedding?: string | null
          embedding_text?: string | null
          gorgias_id?: number | null
          id?: string
          last_suggested_at?: string | null
          name: string
          product_id?: string | null
          tags?: string[] | null
          updated_at?: string
          usage_count?: number
          variables?: string[] | null
          workspace_id: string
        }
        Update: {
          actions?: Json | null
          active?: boolean
          ai_accept_count?: number
          ai_edit_count?: number
          ai_reject_count?: number
          ai_suggest_count?: number
          body_html?: string | null
          body_text?: string
          category?: string | null
          created_at?: string
          embedding?: string | null
          embedding_text?: string | null
          gorgias_id?: number | null
          id?: string
          last_suggested_at?: string | null
          name?: string
          product_id?: string | null
          tags?: string[] | null
          updated_at?: string
          usage_count?: number
          variables?: string[] | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "macros_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "macros_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          app_id: number | null
          created_at: string
          currency: string | null
          customer_id: string | null
          email: string | null
          financial_status: string | null
          fulfillment_status: string | null
          fulfillments: Json | null
          id: string
          line_items: Json | null
          normalized_shipping_address: string | null
          order_number: string | null
          order_type: string | null
          shipping_address: Json | null
          shopify_customer_id: string | null
          shopify_order_id: string
          source_name: string | null
          subscription_id: string | null
          tags: string | null
          total_cents: number | null
          workspace_id: string
        }
        Insert: {
          app_id?: number | null
          created_at?: string
          currency?: string | null
          customer_id?: string | null
          email?: string | null
          financial_status?: string | null
          fulfillment_status?: string | null
          fulfillments?: Json | null
          id?: string
          line_items?: Json | null
          normalized_shipping_address?: string | null
          order_number?: string | null
          order_type?: string | null
          shipping_address?: Json | null
          shopify_customer_id?: string | null
          shopify_order_id: string
          source_name?: string | null
          subscription_id?: string | null
          tags?: string | null
          total_cents?: number | null
          workspace_id: string
        }
        Update: {
          app_id?: number | null
          created_at?: string
          currency?: string | null
          customer_id?: string | null
          email?: string | null
          financial_status?: string | null
          fulfillment_status?: string | null
          fulfillments?: Json | null
          id?: string
          line_items?: Json | null
          normalized_shipping_address?: string | null
          order_number?: string | null
          order_type?: string | null
          shipping_address?: Json | null
          shopify_customer_id?: string | null
          shopify_order_id?: string
          source_name?: string | null
          subscription_id?: string | null
          tags?: string | null
          total_cents?: number | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      pattern_feedback: {
        Row: {
          agent_reason: string | null
          ai_analysis: Json | null
          created_at: string
          created_by: string | null
          id: string
          pattern_id: string | null
          status: string | null
          tag_removed: string
          ticket_id: string
          workspace_id: string
        }
        Insert: {
          agent_reason?: string | null
          ai_analysis?: Json | null
          created_at?: string
          created_by?: string | null
          id?: string
          pattern_id?: string | null
          status?: string | null
          tag_removed: string
          ticket_id: string
          workspace_id: string
        }
        Update: {
          agent_reason?: string | null
          ai_analysis?: Json | null
          created_at?: string
          created_by?: string | null
          id?: string
          pattern_id?: string | null
          status?: string | null
          tag_removed?: string
          ticket_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pattern_feedback_pattern_id_fkey"
            columns: ["pattern_id"]
            isOneToOne: false
            referencedRelation: "smart_patterns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pattern_feedback_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "tickets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pattern_feedback_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          created_at: string
          handle: string | null
          id: string
          image_url: string | null
          product_type: string | null
          shopify_product_id: string
          status: string | null
          tags: string[] | null
          title: string
          updated_at: string
          variants: Json | null
          vendor: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          handle?: string | null
          id?: string
          image_url?: string | null
          product_type?: string | null
          shopify_product_id: string
          status?: string | null
          tags?: string[] | null
          title: string
          updated_at?: string
          variants?: Json | null
          vendor?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          handle?: string | null
          id?: string
          image_url?: string | null
          product_type?: string | null
          shopify_product_id?: string
          status?: string | null
          tags?: string[] | null
          title?: string
          updated_at?: string
          variants?: Json | null
          vendor?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      rules: {
        Row: {
          actions: Json
          conditions: Json
          created_at: string
          description: string | null
          enabled: boolean | null
          id: string
          name: string
          priority: number | null
          stop_processing: boolean | null
          trigger_events: string[]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          actions?: Json
          conditions?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean | null
          id?: string
          name: string
          priority?: number | null
          stop_processing?: boolean | null
          trigger_events: string[]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          actions?: Json
          conditions?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean | null
          id?: string
          name?: string
          priority?: number | null
          stop_processing?: boolean | null
          trigger_events?: string[]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rules_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      smart_patterns: {
        Row: {
          active: boolean | null
          auto_action: string | null
          auto_tag: string | null
          category: string
          created_at: string
          description: string | null
          embedding: string | null
          embedding_text: string | null
          id: string
          match_target: string | null
          name: string
          phrases: Json
          priority: number | null
          source: string | null
          workspace_id: string | null
        }
        Insert: {
          active?: boolean | null
          auto_action?: string | null
          auto_tag?: string | null
          category: string
          created_at?: string
          description?: string | null
          embedding?: string | null
          embedding_text?: string | null
          id?: string
          match_target?: string | null
          name: string
          phrases?: Json
          priority?: number | null
          source?: string | null
          workspace_id?: string | null
        }
        Update: {
          active?: boolean | null
          auto_action?: string | null
          auto_tag?: string | null
          category?: string
          created_at?: string
          description?: string | null
          embedding?: string | null
          embedding_text?: string | null
          id?: string
          match_target?: string | null
          name?: string
          phrases?: Json
          priority?: number | null
          source?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "smart_patterns_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          billing_interval: string | null
          billing_interval_count: number | null
          consecutive_skips: number | null
          created_at: string
          customer_id: string | null
          delivery_price_cents: number | null
          id: string
          items: Json | null
          last_payment_status: string | null
          next_billing_date: string | null
          shopify_contract_id: string
          shopify_customer_id: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          billing_interval?: string | null
          billing_interval_count?: number | null
          consecutive_skips?: number | null
          created_at?: string
          customer_id?: string | null
          delivery_price_cents?: number | null
          id?: string
          items?: Json | null
          last_payment_status?: string | null
          next_billing_date?: string | null
          shopify_contract_id: string
          shopify_customer_id?: string | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          billing_interval?: string | null
          billing_interval_count?: number | null
          consecutive_skips?: number | null
          created_at?: string
          customer_id?: string | null
          delivery_price_cents?: number | null
          id?: string
          items?: Json | null
          last_payment_status?: string | null
          next_billing_date?: string | null
          shopify_contract_id?: string
          shopify_customer_id?: string | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      support_emails: {
        Row: {
          created_at: string
          email: string
          id: string
          is_default: boolean
          label: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          is_default?: boolean
          label?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          is_default?: boolean
          label?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_emails_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          current_month: number | null
          error: string | null
          id: string
          last_completed_month: number | null
          last_cursor: string | null
          phase: string | null
          started_at: string | null
          status: string
          synced_customers: number | null
          synced_orders: number | null
          total_customers: number | null
          total_months: number | null
          total_orders: number | null
          type: string
          workspace_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          current_month?: number | null
          error?: string | null
          id?: string
          last_completed_month?: number | null
          last_cursor?: string | null
          phase?: string | null
          started_at?: string | null
          status?: string
          synced_customers?: number | null
          synced_orders?: number | null
          total_customers?: number | null
          total_months?: number | null
          total_orders?: number | null
          type: string
          workspace_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          current_month?: number | null
          error?: string | null
          id?: string
          last_completed_month?: number | null
          last_cursor?: string | null
          phase?: string | null
          started_at?: string | null
          status?: string
          synced_customers?: number | null
          synced_orders?: number | null
          total_customers?: number | null
          total_months?: number | null
          total_orders?: number | null
          type?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_jobs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ticket_messages: {
        Row: {
          ai_draft: boolean
          ai_personalized: boolean | null
          author_id: string | null
          author_type: string
          body: string
          created_at: string
          direction: string
          email_message_id: string | null
          id: string
          macro_id: string | null
          ticket_id: string
          visibility: string
        }
        Insert: {
          ai_draft?: boolean
          ai_personalized?: boolean | null
          author_id?: string | null
          author_type: string
          body: string
          created_at?: string
          direction: string
          email_message_id?: string | null
          id?: string
          macro_id?: string | null
          ticket_id: string
          visibility?: string
        }
        Update: {
          ai_draft?: boolean
          ai_personalized?: boolean | null
          author_id?: string | null
          author_type?: string
          body?: string
          created_at?: string
          direction?: string
          email_message_id?: string | null
          id?: string
          macro_id?: string | null
          ticket_id?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_messages_macro_id_fkey"
            columns: ["macro_id"]
            isOneToOne: false
            referencedRelation: "macros"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_messages_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      ticket_views: {
        Row: {
          created_at: string
          created_by: string | null
          filters: Json
          id: string
          name: string
          parent_id: string | null
          sort_order: number | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          filters?: Json
          id?: string
          name: string
          parent_id?: string | null
          sort_order?: number | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          filters?: Json
          id?: string
          name?: string
          parent_id?: string | null
          sort_order?: number | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_views_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "ticket_views"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_views_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      tickets: {
        Row: {
          agent_intervened: boolean
          ai_confidence: number | null
          ai_draft: string | null
          ai_drafted_at: string | null
          ai_handled: boolean
          ai_source_id: string | null
          ai_source_type: string | null
          ai_suggested_macro_id: string | null
          ai_suggested_macro_name: string | null
          ai_tier: string | null
          ai_turn_count: number
          ai_turn_limit: number
          ai_workflow_id: string | null
          assigned_to: string | null
          auto_reply_at: string | null
          channel: string
          churn_risk_resolved: boolean | null
          created_at: string
          csat_score: number | null
          customer_id: string | null
          email_message_id: string | null
          escalated_at: string | null
          escalated_to: string | null
          escalation_reason: string | null
          first_response_at: string | null
          handled_by: string | null
          id: string
          last_ai_turn_at: string | null
          last_customer_reply_at: string | null
          pending_auto_reply: string | null
          received_at_email: string | null
          resolved_at: string | null
          status: string
          subject: string | null
          tags: string[] | null
          topic_drift_detected: boolean
          updated_at: string
          workspace_id: string
        }
        Insert: {
          agent_intervened?: boolean
          ai_confidence?: number | null
          ai_draft?: string | null
          ai_drafted_at?: string | null
          ai_handled?: boolean
          ai_source_id?: string | null
          ai_source_type?: string | null
          ai_suggested_macro_id?: string | null
          ai_suggested_macro_name?: string | null
          ai_tier?: string | null
          ai_turn_count?: number
          ai_turn_limit?: number
          ai_workflow_id?: string | null
          assigned_to?: string | null
          auto_reply_at?: string | null
          channel?: string
          churn_risk_resolved?: boolean | null
          created_at?: string
          csat_score?: number | null
          customer_id?: string | null
          email_message_id?: string | null
          escalated_at?: string | null
          escalated_to?: string | null
          escalation_reason?: string | null
          first_response_at?: string | null
          handled_by?: string | null
          id?: string
          last_ai_turn_at?: string | null
          last_customer_reply_at?: string | null
          pending_auto_reply?: string | null
          received_at_email?: string | null
          resolved_at?: string | null
          status?: string
          subject?: string | null
          tags?: string[] | null
          topic_drift_detected?: boolean
          updated_at?: string
          workspace_id: string
        }
        Update: {
          agent_intervened?: boolean
          ai_confidence?: number | null
          ai_draft?: string | null
          ai_drafted_at?: string | null
          ai_handled?: boolean
          ai_source_id?: string | null
          ai_source_type?: string | null
          ai_suggested_macro_id?: string | null
          ai_suggested_macro_name?: string | null
          ai_tier?: string | null
          ai_turn_count?: number
          ai_turn_limit?: number
          ai_workflow_id?: string | null
          assigned_to?: string | null
          auto_reply_at?: string | null
          channel?: string
          churn_risk_resolved?: boolean | null
          created_at?: string
          csat_score?: number | null
          customer_id?: string | null
          email_message_id?: string | null
          escalated_at?: string | null
          escalated_to?: string | null
          escalation_reason?: string | null
          first_response_at?: string | null
          handled_by?: string | null
          id?: string
          last_ai_turn_at?: string | null
          last_customer_reply_at?: string | null
          pending_auto_reply?: string | null
          received_at_email?: string | null
          resolved_at?: string | null
          status?: string
          subject?: string | null
          tags?: string[] | null
          topic_drift_detected?: boolean
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tickets_ai_suggested_macro_id_fkey"
            columns: ["ai_suggested_macro_id"]
            isOneToOne: false
            referencedRelation: "macros"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tickets_ai_workflow_id_fkey"
            columns: ["ai_workflow_id"]
            isOneToOne: false
            referencedRelation: "ai_workflows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tickets_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tickets_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workflows: {
        Row: {
          config: Json
          created_at: string
          enabled: boolean | null
          id: string
          name: string
          template: string
          trigger_tag: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          config?: Json
          created_at?: string
          enabled?: boolean | null
          id?: string
          name: string
          template: string
          trigger_tag: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          config?: Json
          created_at?: string
          enabled?: boolean | null
          id?: string
          name?: string
          template?: string
          trigger_tag?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflows_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_invites: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          role: Database["public"]["Enums"]["workspace_role"]
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          role?: Database["public"]["Enums"]["workspace_role"]
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invites_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["workspace_role"]
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_pattern_overrides: {
        Row: {
          enabled: boolean
          id: string
          pattern_id: string
          workspace_id: string
        }
        Insert: {
          enabled?: boolean
          id?: string
          pattern_id: string
          workspace_id: string
        }
        Update: {
          enabled?: boolean
          id?: string
          pattern_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_pattern_overrides_pattern_id_fkey"
            columns: ["pattern_id"]
            isOneToOne: false
            referencedRelation: "smart_patterns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_pattern_overrides_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          appstle_api_key_encrypted: string | null
          appstle_webhook_secret_encrypted: string | null
          auto_close_reply: string | null
          chargeback_auto_cancel: boolean
          chargeback_auto_cancel_reasons: string[]
          chargeback_auto_ticket: boolean
          chargeback_evidence_reminder: boolean
          chargeback_evidence_reminder_days: number
          chargeback_notify: boolean
          created_at: string
          fraud_suppressed_addresses: string[] | null
          help_center_url: string | null
          help_custom_domain: string | null
          help_logo_url: string | null
          help_primary_color: string | null
          help_slug: string | null
          id: string
          meta_page_id: string | null
          name: string
          order_source_mapping: Json | null
          plan: Database["public"]["Enums"]["workspace_plan"]
          replacement_threshold_cents: number
          resend_api_key_encrypted: string | null
          resend_domain: string | null
          response_delays: Json | null
          sandbox_mode: boolean
          shopify_access_token_encrypted: string | null
          shopify_client_id_encrypted: string | null
          shopify_client_secret_encrypted: string | null
          shopify_domain: string | null
          shopify_myshopify_domain: string | null
          shopify_oauth_state: string | null
          shopify_scopes: string | null
          stripe_account_id: string | null
          support_email: string | null
        }
        Insert: {
          appstle_api_key_encrypted?: string | null
          appstle_webhook_secret_encrypted?: string | null
          auto_close_reply?: string | null
          chargeback_auto_cancel?: boolean
          chargeback_auto_cancel_reasons?: string[]
          chargeback_auto_ticket?: boolean
          chargeback_evidence_reminder?: boolean
          chargeback_evidence_reminder_days?: number
          chargeback_notify?: boolean
          created_at?: string
          fraud_suppressed_addresses?: string[] | null
          help_center_url?: string | null
          help_custom_domain?: string | null
          help_logo_url?: string | null
          help_primary_color?: string | null
          help_slug?: string | null
          id?: string
          meta_page_id?: string | null
          name: string
          order_source_mapping?: Json | null
          plan?: Database["public"]["Enums"]["workspace_plan"]
          replacement_threshold_cents?: number
          resend_api_key_encrypted?: string | null
          resend_domain?: string | null
          response_delays?: Json | null
          sandbox_mode?: boolean
          shopify_access_token_encrypted?: string | null
          shopify_client_id_encrypted?: string | null
          shopify_client_secret_encrypted?: string | null
          shopify_domain?: string | null
          shopify_myshopify_domain?: string | null
          shopify_oauth_state?: string | null
          shopify_scopes?: string | null
          stripe_account_id?: string | null
          support_email?: string | null
        }
        Update: {
          appstle_api_key_encrypted?: string | null
          appstle_webhook_secret_encrypted?: string | null
          auto_close_reply?: string | null
          chargeback_auto_cancel?: boolean
          chargeback_auto_cancel_reasons?: string[]
          chargeback_auto_ticket?: boolean
          chargeback_evidence_reminder?: boolean
          chargeback_evidence_reminder_days?: number
          chargeback_notify?: boolean
          created_at?: string
          fraud_suppressed_addresses?: string[] | null
          help_center_url?: string | null
          help_custom_domain?: string | null
          help_logo_url?: string | null
          help_primary_color?: string | null
          help_slug?: string | null
          id?: string
          meta_page_id?: string | null
          name?: string
          order_source_mapping?: Json | null
          plan?: Database["public"]["Enums"]["workspace_plan"]
          replacement_threshold_cents?: number
          resend_api_key_encrypted?: string | null
          resend_domain?: string | null
          response_delays?: Json | null
          sandbox_mode?: boolean
          shopify_access_token_encrypted?: string | null
          shopify_client_id_encrypted?: string | null
          shopify_client_secret_encrypted?: string | null
          shopify_domain?: string | null
          shopify_myshopify_domain?: string | null
          shopify_oauth_state?: string | null
          shopify_scopes?: string | null
          stripe_account_id?: string | null
          support_email?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      append_suppressed_address: {
        Args: { p_address: string; p_workspace_id: string }
        Returns: undefined
      }
      atomic_increment_import_job: {
        Args: {
          p_completed_chunks?: number
          p_finalize_completed?: number
          p_job_id: string
          p_processed_records?: number
        }
        Returns: {
          completed_chunks: number
          finalize_completed: number
          finalize_total: number
          total_chunks: number
        }[]
      }
      chargeback_stats: {
        Args: { p_workspace_id: string }
        Returns: {
          auto_cancelled_count: number
          evidence_due_soon: number
          lost_count: number
          total_amount_cents: number
          total_count: number
          under_review_count: number
          won_count: number
        }[]
      }
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      fraud_case_stats: {
        Args: { p_workspace_id: string }
        Returns: {
          confirmed_30d: number
          dismissed_30d: number
          open_count: number
          value_at_risk_cents: number
        }[]
      }
      fraud_detect_high_velocity: {
        Args: {
          p_lookback_cutoff: string
          p_min_orders: number
          p_min_quantity: number
          p_window_cutoff: string
          p_workspace_id: string
        }
        Returns: {
          customer_id: string
          order_ids: string[]
          qualifying_order_count: number
          window_end: string
          window_start: string
        }[]
      }
      fraud_detect_shared_addresses: {
        Args: {
          p_cutoff: string
          p_min_customers: number
          p_min_orders: number
          p_workspace_id: string
        }
        Returns: {
          customer_count: number
          customer_ids: string[]
          display_address: string
          full_names: string[]
          last_names: string[]
          normalized_shipping_address: string
          order_count: number
        }[]
      }
      increment_consecutive_skips: {
        Args: { p_sub_id: string }
        Returns: number
      }
      increment_macro_usage: { Args: { macro_id: string }; Returns: undefined }
      link_orders_to_customers: { Args: { ws_id: string }; Returns: number }
      link_orders_to_subscriptions: { Args: { ws_id: string }; Returns: number }
      macro_usage_stats: {
        Args: { days?: number; ws_id: string }
        Returns: {
          macro_id: string
          macro_name: string
          use_count: number
        }[]
      }
      match_kb_chunks: {
        Args: {
          match_count?: number
          match_threshold?: number
          query_embedding: string
          ws_id: string
        }
        Returns: {
          chunk_index: number
          chunk_text: string
          id: string
          kb_id: string
          similarity: number
        }[]
      }
      match_macros: {
        Args: {
          match_count?: number
          match_threshold?: number
          query_embedding: string
          ws_id: string
        }
        Returns: {
          body_html: string
          body_text: string
          category: string
          id: string
          name: string
          similarity: number
        }[]
      }
      match_pattern_embeddings: {
        Args: {
          match_count?: number
          match_threshold?: number
          query_embedding: string
          ws_id: string
        }
        Returns: {
          auto_action: string
          auto_tag: string
          category: string
          id: string
          name: string
          similarity: number
        }[]
      }
      record_macro_suggestion_outcome: {
        Args: { p_macro_id: string; p_outcome: string }
        Returns: undefined
      }
      reset_sync_data: { Args: never; Returns: undefined }
      seed_fraud_rules: { Args: { p_workspace_id: string }; Returns: undefined }
      update_customer_order_dates: {
        Args: { ws_id: string }
        Returns: undefined
      }
      update_customer_subscription_statuses: {
        Args: { ws_id: string }
        Returns: number
      }
    }
    Enums: {
      workspace_plan: "free" | "starter" | "pro" | "enterprise"
      workspace_role:
        | "owner"
        | "admin"
        | "agent"
        | "social"
        | "marketing"
        | "read_only"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      workspace_plan: ["free", "starter", "pro", "enterprise"],
      workspace_role: [
        "owner",
        "admin",
        "agent",
        "social",
        "marketing",
        "read_only",
      ],
    },
  },
} as const
