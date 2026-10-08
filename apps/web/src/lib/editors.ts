import type { MethodResult } from "@agentplane/contracts";
import { create } from "zustand";
import { client } from "./client.ts";

type EditorList = MethodResult<"editor.list">;

let list: Promise<EditorList> | null = null;

/** Editors installed on this computer (cached for `use()`; they rarely change). */
export function editorList(): Promise<EditorList> {
  // An empty list hides the button rather than breaking the header; ask again next time.
  list ??= client.request("editor.list", {}).catch(() => {
    list = null;
    return { editors: [], preferred: null };
  });
  return list;
}

/** The editor picked in this window, ahead of what the list said. */
export const usePickedEditor = create<{ id: string | null }>(() => ({ id: null }));

/** Open the thread's folder, or a file in it (a repo-root path), in an editor. */
export async function openInEditor(
  threadId: string,
  options: { path?: string; line?: number; editor?: string } = {},
): Promise<void> {
  try {
    await client.request("editor.open", { threadId, ...options });
    if (options.editor) usePickedEditor.setState({ id: options.editor });
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
  }
}
