import path from "node:path";
import { fileURLToPath } from "node:url";

export function workerSecretState(text, name) {
  if (typeof name !== "string" || !name.trim()) throw new Error("A Worker secret name is required");
  let values;
  try { values = JSON.parse(text); } catch { throw new Error("Worker secret metadata is not valid JSON; refusing key provisioning"); }
  if (!Array.isArray(values) || values.some(value => !value || typeof value !== "object" ||
    typeof value.name !== "string" || !value.name.trim())) {
    throw new Error("Worker secret metadata is not a complete list; refusing key provisioning");
  }
  const names = values.map(value => value.name);
  if (new Set(names).size !== names.length) throw new Error("Duplicate Worker secret metadata; refusing key provisioning");
  return names.includes(name) ? "present" : "absent";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = "", bytes = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new Error("Worker secret metadata exceeds the safe limit; refusing key provisioning");
      input += decoder.decode(chunk, { stream: true });
    }
    input += decoder.decode();
    console.log(workerSecretState(input, process.argv[2]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
