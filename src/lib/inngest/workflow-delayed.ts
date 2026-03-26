import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { executeWorkflow } from "@/lib/workflow-executor";

// Execute workflow with configurable channel-based response delay
export const workflowDelayed = inngest.createFunction(
  {
    id: "workflow-delayed-execute",
    retries: 2,
    concurrency: [{ limit: 10, key: "event.data.workspace_id" }],
    triggers: [{ event: "workflow/execute" }],
  },
  async ({ event, step }) => {
    const { workspace_id, ticket_id, trigger_tag, channel } = event.data as {
      workspace_id: string;
      ticket_id: string;
      trigger_tag: string;
      channel: string;
    };

    // Get the configured delay for this channel
    const delaySeconds = await step.run("get-delay", async () => {
      const admin = createAdminClient();
      const { data: ws } = await admin
        .from("workspaces")
        .select("response_delays")
        .eq("id", workspace_id)
        .single();

      const delays = (ws?.response_delays || { email: 60, chat: 5, sms: 10, meta_dm: 10 }) as Record<string, number>;
      return delays[channel] || 60;
    });

    // Wait the configured delay
    if (delaySeconds > 0) {
      await step.sleep("response-delay", `${delaySeconds}s`);
    }

    // Execute the workflow
    await step.run("execute-workflow", async () => {
      await executeWorkflow(workspace_id, ticket_id, trigger_tag);
    });

    return { delayed: delaySeconds, channel };
  }
);
