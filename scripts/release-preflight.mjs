import { readFileSync, writeFileSync } from "node:fs";
import { assertReleaseApproval, bindReleaseDatabase, assertSecretMetadata } from "./release-contract.mjs";
const mode = process.argv[2];
if (mode === "approve") assertReleaseApproval(process.env);
else if (mode === "bind") writeFileSync("wrangler.toml", bindReleaseDatabase(readFileSync("wrangler.toml", "utf8"), process.env.CLOUDFLARE_D1_DATABASE_ID));
else if (mode === "secrets") assertSecretMetadata(JSON.parse(readFileSync("secret-names.json", "utf8")));
else throw new Error("Expected approve/bind/secrets preflight mode");
console.log(`Release ${mode} preflight passed (does not prove remote capacity or credential decryptability)`);
