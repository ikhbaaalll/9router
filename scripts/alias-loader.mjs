/**
 * Minimal ESM resolver hook so scripts can import the app's own modules outside
 * of Next.js (which is what normally resolves these aliases).
 *
 * Maps: `@/x` -> <FORK_ROOT>/src/x, `open-sse` and `open-sse/x` -> <FORK_ROOT>/open-sse/x
 * and retries extension-less relative specifiers with `.js` appended.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.env.FORK_ROOT || process.cwd();

export async function resolve(specifier, context, nextResolve) {
  try {
    if (specifier.startsWith("@/")) {
      return await nextResolve(pathToFileURL(path.join(ROOT, "src", specifier.slice(2))).href, context);
    }
    if (specifier === "open-sse" || specifier.startsWith("open-sse/")) {
      const rel = specifier === "open-sse" ? "open-sse/index.js" : specifier;
      return await nextResolve(pathToFileURL(path.join(ROOT, rel)).href, context);
    }
    return await nextResolve(specifier, context);
  } catch (error) {
    // Extension-less specifier: the app relies on the bundler to add `.js`.
    if (!path.extname(specifier) && (specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("open-sse"))) {
      const withExt = specifier + ".js";
      if (withExt.startsWith("@/")) {
        return await nextResolve(pathToFileURL(path.join(ROOT, "src", withExt.slice(2))).href, context);
      }
      if (withExt.startsWith("open-sse")) {
        return await nextResolve(pathToFileURL(path.join(ROOT, withExt)).href, context);
      }
      return await nextResolve(withExt, context);
    }
    throw error;
  }
}
