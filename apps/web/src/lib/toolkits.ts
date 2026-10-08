import type { TriggerToolkit } from "@agentplane/contracts";
import { client } from "./client.ts";

let list: Promise<TriggerToolkit[]> | null = null;

/** Every Composio app (with how many triggers each has), asked once per page load. */
export function composioToolkits(): Promise<TriggerToolkit[]> {
  list ??= client.request("composio.toolkits", {}).catch((error: unknown) => {
    list = null;
    throw error;
  });
  return list;
}

let lenient: Promise<TriggerToolkit[]> | null = null;

/** The same list, or none when it can't be fetched (for pickers that can do without). */
export function composioToolkitsOrNone(): Promise<TriggerToolkit[]> {
  lenient ??= composioToolkits().catch(() => {
    lenient = null;
    return [];
  });
  return lenient;
}
