import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Directory completions for a partially typed path, so a project can be added
 * from a plain browser, where there is no native folder picker that yields a
 * real path.
 */
export async function suggestDirs(prefix: string): Promise<string[]> {
  const home = homedir();
  const expanded = prefix.replace(/^~(?=$|\/)/, home) || `${home}/`;
  if (!expanded.startsWith("/")) return [];
  const parent = expanded.endsWith("/") ? expanded : dirname(expanded);
  const partial = expanded.endsWith("/") ? "" : basename(expanded).toLowerCase();
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          entry.name.toLowerCase().startsWith(partial),
      )
      .map((entry) => join(parent, entry.name))
      .sort()
      .slice(0, 20)
      .map((path) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path));
  } catch {
    return [];
  }
}
