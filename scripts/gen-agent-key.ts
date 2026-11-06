import { exportJWK, generateKeyPair } from "jose";

// Prints a new Ed25519 private JWK for SHOPPER_AGENT_PRIVATE_JWK. Not written anywhere: copy it into .env yourself.
async function main() {
  const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  console.log(JSON.stringify(await exportJWK(privateKey)));
}
main();
