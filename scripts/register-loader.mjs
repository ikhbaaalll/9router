// Registers the alias resolver hook for plain `node` runs (see alias-loader.mjs).
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(path.join(here, "alias-loader.mjs")).href);
