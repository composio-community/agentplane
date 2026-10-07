/**
 * Ask every agent for its models, the same way the app does.
 *
 *   pnpm --filter @agentplane/server exec tsx scripts/models.ts [agent…]
 */
import { resolveConfig } from "../src/config.ts";
import { AgentCatalog } from "../src/providers/index.ts";

const catalog = new AgentCatalog(resolveConfig({ dev: true, webDistDir: null }));
await catalog.loadRegistry();
const statuses = await catalog.statuses();
const wanted = process.argv.slice(2);
const agents = statuses.filter((status) =>
  wanted.length > 0
    ? wanted.includes(status.provider)
    : status.group === "featured" && status.installed,
);

await Promise.all(
  agents.map(async (agent) => {
    const started = Date.now();
    const result = await catalog.models(agent.provider, true);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const sample = result.models
      .slice(0, 5)
      .map((model) => `${model.isDefault ? "*" : ""}${model.id}`)
      .join(", ");
    console.log(
      `${agent.label.padEnd(20)} ${String(result.models.length).padStart(3)} models  ${seconds}s  ${sample}${result.error ? `  ⚠ ${result.error.slice(0, 140)}` : ""}`,
    );
  }),
);
process.exit(0);
