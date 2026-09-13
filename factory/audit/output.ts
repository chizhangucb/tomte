import { asArray, asOptionalString, asRecord, asString, standardSchema } from "../lib/coerce";
import type { CriterionJudgement } from "../lib/verdict";
import type { PlaceholderFinding } from "./report";

export interface AuditOutput {
  readonly summary: string;
  readonly verdict: "pass" | "fail";
  readonly criteria: CriterionJudgement[];
  readonly placeholders: PlaceholderFinding[];
}

const asBoolean = (value: unknown, label: string): boolean => {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be true or false`);
};

const parseCriterion = (value: unknown): CriterionJudgement => {
  const record = asRecord(value, "criterion");
  return {
    index:
      typeof record.index === "number" && Number.isInteger(record.index) ? record.index : undefined,
    criterion: asOptionalString(record.criterion),
    met: asBoolean(record.met, "criterion met"),
    evidence: asString(record.evidence, "criterion evidence"),
  };
};

const parsePlaceholder = (value: unknown): PlaceholderFinding => {
  const record = asRecord(value, "placeholder");
  return {
    path: asString(record.path ?? record.file, "placeholder path"),
    line: typeof record.line === "number" && record.line > 0 ? Math.floor(record.line) : undefined,
    description: asString(record.description ?? record.body, "placeholder description"),
  };
};

export const auditOutputSchema = standardSchema<AuditOutput>((value) => {
  const record = asRecord(value, "audit output");
  const word = typeof record.verdict === "string" ? record.verdict.trim().toLowerCase() : "";
  if (word !== "pass" && word !== "fail") throw new Error('verdict must be "pass" or "fail"');
  return {
    summary: asString(record.summary, "summary"),
    verdict: word,
    criteria: asArray(record.criteria ?? [], "criteria").map(parseCriterion),
    placeholders: asArray(record.placeholders ?? [], "placeholders").map(parsePlaceholder),
  };
});
