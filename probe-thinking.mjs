// probe capabilities + thinking levels for the provider/model pairs this router uses
import { getCapabilitiesForModel } from "./open-sse/providers/capabilities.js";
import { getThinkingLevels } from "./open-sse/providers/thinkingLevels.js";
import { PROVIDERS } from "./open-sse/providers/index.js";

const pairs = [
  ["codex", "gpt-5.6-luna"],
  ["codex", "gpt-5.6-sol"],
  ["codex", "gpt-5.6-terra"],
  ["codex", "gpt-6-astra"],
  ["opencode-go", "deepseek-v4-flash"],
  ["opencode-go", "deepseek-v4-pro"],
  ["opencode-go", "deepseek-flash"],
  ["opencode-go", "glm-5.2"],
  ["opencode-go", "glm-5.3-flash"],
  ["opencode-go", "gpt-5.6-luna"],
  ["opencode-go", "grok-4.6"],
  ["opencode-go", "muse-spark-1.2-contributor"],
  ["commandcode", "meta/muse-spark-1.2-contributor"],
  ["commandcode", "deepseek/deepseek-v4-flash"],
  ["clinepass", "cline-pass/deepseek-v4-flash"],
  ["clinepass", "cline-pass/glm-5.2"],
  ["agentrouter", "gpt-5.6-sol"],
  ["cloudflare-ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
];

for (const [p, m] of pairs) {
  const caps = getCapabilitiesForModel(p, m);
  const lv = getThinkingLevels(p, m);
  console.log(
    `${p}/${m} | fmt=${caps.thinkingFormat} reasoning=${caps.reasoning} canDisable=${caps.thinkingCanDisable} range=${JSON.stringify(caps.thinkingRange)} levels=${JSON.stringify(lv)}`
  );
}

console.log("\n=== registry thinkingFormat + thinkingConfig per provider (used ones) ===");
for (const id of ["codex", "opencode-go", "commandcode", "clinepass", "cline", "agentrouter", "openrouter", "nvidia", "cloudflare-ai", "deepseek", "blackbox", "grok-cli", "openai", "tokenrouter"]) {
  const e = PROVIDERS[id];
  if (!e) { console.log(`${id}: NOT IN REGISTRY`); continue; }
  console.log(`${id}: thinkingFormat=${e.thinkingFormat} thinkingConfig=${JSON.stringify(e.thinkingConfig)} transport.format=${e.transport?.format}`);
}
