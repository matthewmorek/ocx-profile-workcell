// Preserved pre-migration request contract, not a snapshot of generated V2 config.
export const profileAgents = {
  review: ["primary", "gpt-6-astra", undefined, "high", "low"],
  plan: ["primary", "gpt-6-astra", 0.3, "high", "medium"],
  build: ["primary", "gpt-6-astra", 0.3, "high", "low"],
  debug: ["primary", "gpt-6-astra", 0.3, "high", "medium"],
  coder: ["subagent", "gpt-6-astra", 0.1, "medium", "low"],
  debugger: ["subagent", "gpt-6-astra", 0.1, "high", "low"],
  tester: ["subagent", "gpt-5.6-luna", undefined, "low", "low"],
  explore: ["subagent", "gpt-5.6-luna", 0.2, "medium", "medium"],
  researcher: ["subagent", "gpt-5.6-terra", 0.2, "medium", "medium"],
  scribe: ["subagent", "gpt-5.6-luna", 0.1, "medium", "low"],
  reviewer: ["subagent", "gpt-6-astra", 0.1, "high", "low"],
  committer: ["subagent", "gpt-6-astra", 0.1, "low", "low"],
  metadata: ["subagent", "gpt-5.6-luna", 0, "low", "low"],
} as const;
