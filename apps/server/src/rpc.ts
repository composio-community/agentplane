import {
  DESKTOP_ONLY_METHODS,
  type MethodName,
  type MethodParams,
  type MethodResult,
  Methods,
} from "@agentplane/contracts";
import type { ComposioService } from "./composio.ts";
import { type Orchestrator, UserError } from "./orchestrator.ts";
import type { ProviderKeyStore } from "./provider-keys.ts";
import type { AgentCatalog } from "./providers/index.ts";
import type { RemoteAccess } from "./remote.ts";
import type { RuleBook } from "./rules.ts";
import { suggestDirs } from "./suggest.ts";
import { availableShells, type Peer, type Terminals } from "./terminals.ts";

/** Who's asking: the desktop app on this Mac, or a paired phone; and the window, for streams. */
export type CallContext = { remote: boolean; peer?: Peer };

type Handlers = {
  [M in MethodName]: (
    params: MethodParams<M>,
    context: CallContext,
  ) => Promise<MethodResult<M>> | MethodResult<M>;
};

export function createHandlers(
  orchestrator: Orchestrator,
  catalog: AgentCatalog,
  composio: ComposioService,
  rules: RuleBook,
  remote: RemoteAccess,
  terminals: Terminals,
  keys: ProviderKeyStore,
): Handlers {
  const peerOf = (context: CallContext): Peer => {
    if (!context.peer) throw new UserError("Terminals need a live connection.");
    return context.peer;
  };
  return {
    "shell.get": () => orchestrator.shell(),
    "thread.get": ({ threadId }) => orchestrator.threadSnapshot(threadId),
    "providers.status": ({ refresh }) => catalog.statuses(refresh ?? false),
    "agents.signIn": async ({ provider }) => {
      const { opened, command } = await catalog.signIn(provider);
      if (!opened) throw new UserError(`Run this in a terminal to sign in: ${command}`);
      return {};
    },
    "thread.retry": ({ threadId }) => {
      orchestrator.retry(threadId);
      return {};
    },
    "agents.models": ({ provider, refresh }) => catalog.models(provider, refresh ?? false),
    "fs.suggestDirs": ({ prefix }) => suggestDirs(prefix),
    "project.create": ({ path }) => orchestrator.createProject(path),
    "project.delete": async ({ projectId }) => {
      await orchestrator.deleteProject(projectId);
      return {};
    },
    "thread.create": (params) => orchestrator.createThread(params),
    "thread.delete": async ({ threadId }) => {
      await orchestrator.deleteThread(threadId);
      return {};
    },
    "thread.rename": ({ threadId, title }) => {
      orchestrator.renameThread(threadId, title);
      return {};
    },
    "thread.sendMessage": ({ threadId, text }) => {
      // Acknowledges once the turn is committed; the work streams back as events.
      orchestrator.sendMessage(threadId, text);
      return {};
    },
    "thread.prewarm": ({ threadId }) => {
      orchestrator.prewarm(threadId);
      return {};
    },
    "thread.interrupt": async ({ threadId }) => {
      await orchestrator.interrupt(threadId);
      return {};
    },
    "thread.setProvider": async ({ threadId, provider, model }) => {
      await orchestrator.setProvider(threadId, provider, model);
      return {};
    },
    "thread.setModel": async ({ threadId, model }) => {
      await orchestrator.setModel(threadId, model);
      return {};
    },
    "thread.setRuntimeMode": async (params) => {
      await orchestrator.setRuntimeMode(params);
      return {};
    },
    "remote.status": (_params, context) => remote.status(context.remote),
    "remote.configure": (params) => remote.configure(params),
    "remote.pairingLink": () => remote.pairingLink(),
    "remote.revoke": ({ id }) => {
      remote.revoke(id);
      return {};
    },
    "composio.status": () => composio.status(),
    "composio.configure": (params) => composio.configure(params),
    "composio.connect": ({ toolkit }) => composio.connect(toolkit),
    "composio.toolkits": () => composio.toolkits(),
    "composio.connection": ({ toolkit }) => composio.connection(toolkit),
    "composio.triggerTypes": ({ toolkit }) => composio.triggerTypes(toolkit),
    "automations.list": () => composio.listAutomations(),
    "automations.create": (params) => composio.createAutomation(params),
    "automations.setEnabled": ({ id, enabled }) => composio.setEnabled(id, enabled),
    "automations.delete": async ({ id }) => {
      await composio.deleteAutomation(id);
      return {};
    },
    "automations.test": ({ id }) => composio.test(id),
    "approval.respond": async ({ threadId, itemId, decision }) => {
      await orchestrator.respondApproval(threadId, itemId, decision);
      return {};
    },
    "approval.always": ({ threadId, itemId }) => orchestrator.approveAlways(threadId, itemId),
    "keys.status": () => keys.status(),
    "keys.configure": (params) => keys.configure(params),
    "rules.list": () => rules.list(),
    "rules.delete": ({ id }) => {
      rules.remove(id);
      return {};
    },
    "setup.respond": async ({ threadId, itemId, decision }) => {
      await orchestrator.respondSetup(threadId, itemId, decision);
      return {};
    },
    "question.respond": async ({ threadId, itemId, answers }) => {
      await orchestrator.respondQuestion(threadId, itemId, answers);
      return {};
    },
    "terminal.list": ({ threadId }) => terminals.list(threadId),
    "terminal.shells": () => availableShells(),
    "terminal.open": ({ threadId, cols, rows, shell }, context) =>
      terminals.open(threadId, cols, rows, peerOf(context), shell),
    "terminal.attach": ({ terminalId }, context) => terminals.attach(terminalId, peerOf(context)),
    "terminal.write": ({ terminalId, data }) => {
      terminals.write(terminalId, data);
      return {};
    },
    "terminal.resize": ({ terminalId, cols, rows }) => {
      terminals.resize(terminalId, cols, rows);
      return {};
    },
    "terminal.close": ({ terminalId }) => {
      terminals.close(terminalId);
      return {};
    },
  };
}

export async function dispatch(
  handlers: Handlers,
  method: string,
  rawParams: unknown,
  context: CallContext,
): Promise<unknown> {
  if (!Object.hasOwn(Methods, method)) throw new Error(`Unknown method: ${method}`);
  const name = method as MethodName;
  if (context.remote && DESKTOP_ONLY_METHODS.has(name)) {
    throw new UserError("That's only available on the computer running Agentplane.");
  }
  const params = Methods[name].params.parse(rawParams ?? {});
  // A phone can work in a thread, but full access (no approvals at all) is
  // only turned on at the computer.
  if (
    context.remote &&
    (name === "thread.create" || name === "thread.setRuntimeMode") &&
    (params as { runtimeMode?: string }).runtimeMode === "full-access"
  ) {
    throw new UserError("Full access can only be turned on at the computer.");
  }
  const handler = handlers[name] as (params: unknown, context: CallContext) => unknown;
  return await handler(params, context);
}
