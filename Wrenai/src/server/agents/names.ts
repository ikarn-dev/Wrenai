import "server-only";
import { randomInt } from "node:crypto";
import { adjectives, animals, uniqueNamesGenerator } from "unique-names-generator";

export function generateAgentName(taken: ReadonlySet<string>): string {
  let name = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    name = uniqueNamesGenerator({
      dictionaries: [adjectives, animals],
      separator: " ",
      style: "capital",
      length: 2,
      seed: randomInt(0, 2 ** 32),
    });
    if (name.toLowerCase() !== "jarvis" && !taken.has(name)) {
      return name;
    }
  }
  const offset = randomInt(0, 90);
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const candidate = `${name} ${10 + ((offset + attempt) % 90)}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  throw new Error("Agent name space exhausted");
}
