import { z } from "zod";

// Canonical TEE IDs only. The similarly named deepseek/deepseek-* route is external and not model-attested.
export const APPROVED_MODELS = [
  "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "Qwen/Qwen3.8-27B",
  "z-ai/glm-5.3-flash",
] as const;

export const inferenceModelSchema = z.enum(APPROVED_MODELS);
