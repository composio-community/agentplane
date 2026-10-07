import { describeRule, type ItemOf, type PermissionRule, ruleMatches } from "@agentplane/contracts";
import type { SettingsStore } from "./settings.ts";
import { newId } from "./util.ts";

/** Saved permission rules, per project, applied to every agent. */
export class RuleBook {
  constructor(private readonly settings: SettingsStore) {}

  list(): PermissionRule[] {
    return this.settings.get().rules;
  }

  /** The matching rule's description, if a saved rule covers this request. */
  match(
    projectId: string,
    approval:
      | ItemOf<"approval">
      | Omit<ItemOf<"approval">, "id" | "threadId" | "turnId" | "order" | "createdAt">,
  ): string | null {
    const rule = this.list().find(
      (candidate) => candidate.projectId === projectId && ruleMatches(candidate, approval),
    );
    return rule ? describeRule(rule) : null;
  }

  add(projectId: string, draft: Pick<PermissionRule, "kind" | "pattern">): PermissionRule {
    const existing = this.list().find(
      (rule) =>
        rule.projectId === projectId && rule.kind === draft.kind && rule.pattern === draft.pattern,
    );
    if (existing) return existing;
    const rule: PermissionRule = { id: newId(), projectId, ...draft, createdAt: Date.now() };
    this.settings.update((settings) => ({ ...settings, rules: [...settings.rules, rule] }));
    return rule;
  }

  remove(id: string): void {
    this.settings.update((settings) => ({
      ...settings,
      rules: settings.rules.filter((rule) => rule.id !== id),
    }));
  }
}
