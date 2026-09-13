/**
 * Vendored from sandcastle 0.12.0, `.sandcastle/agent-workflows/shared/review-output.ts`.
 * One forced difference (#47): the review schema gains `verdict` and one
 * `criteria` entry per acceptance criterion, because the factory's reviewer
 * emits a pass or fail with evidence rather than his `improved`/`clean`
 * (story 5, ADR 0003). His implement-PR schema is untouched.
 */
import {
  asArray,
  asOptionalString,
  asRecord,
  asString,
  standardSchema,
} from "../../lib/coerce";
import type { CriterionJudgement } from "../../lib/verdict";

export interface InlineComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

export interface ThreadReply {
  readonly commentId: string;
  readonly body: string;
}

export interface ReviewOutput {
  readonly summary: string;
  /** The reviewer's overall word; `resolveVerdict` has the final say. */
  readonly verdict: "pass" | "fail";
  /** One entry per acceptance criterion, ticked or not, with evidence. */
  readonly criteria: CriterionJudgement[];
  readonly inlineComments: InlineComment[];
  readonly replies: ThreadReply[];
}

export interface ImplementPrOutput {
  readonly threadReplies: ThreadReply[];
  readonly newInlineComments: InlineComment[];
  readonly topLevelComments: { readonly body: string }[];
}

const parseLine = (value: unknown, record: Record<string, unknown>): number => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  const lineRange = asOptionalString(record.lineRange);
  const firstLine = lineRange?.match(/\d+/)?.[0];
  if (firstLine) {
    return Number(firstLine);
  }
  throw new Error(
    "line must be a positive integer or lineRange must start with a line number",
  );
};

const parseInlineComment = (value: unknown): InlineComment => {
  const record = asRecord(value, "inline comment");
  return {
    path: asString(record.path ?? record.file, "inline comment path"),
    line: parseLine(record.line, record),
    body: asString(record.body ?? record.comment, "inline comment body"),
  };
};

const parseReply = (value: unknown): ThreadReply => {
  const record = asRecord(value, "reply");
  return {
    commentId: asString(record.commentId, "reply commentId"),
    body: asString(record.body ?? record.comment, "reply body"),
  };
};

const asBoolean = (value: unknown, label: string): boolean => {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be true or false`);
};

const asVerdict = (value: unknown): "pass" | "fail" => {
  const word = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (word === "pass" || word === "fail") return word;
  throw new Error('verdict must be "pass" or "fail"');
};

const parseCriterion = (value: unknown): CriterionJudgement => {
  const record = asRecord(value, "criterion");
  const index =
    typeof record.index === "number" && Number.isInteger(record.index)
      ? record.index
      : undefined;
  return {
    index,
    criterion: asOptionalString(record.criterion),
    met: asBoolean(record.met, "criterion met"),
    evidence: asString(record.evidence, "criterion evidence"),
  };
};

export const reviewOutputSchema = standardSchema<ReviewOutput>((value) => {
  const record = asRecord(value, "review output");
  return {
    summary: asString(record.summary, "summary"),
    verdict: asVerdict(record.verdict),
    criteria: asArray(record.criteria ?? [], "criteria").map(parseCriterion),
    inlineComments: asArray(record.inlineComments ?? [], "inlineComments").map(
      parseInlineComment,
    ),
    replies: asArray(record.replies ?? [], "replies").map(parseReply),
  };
});

export const implementPrOutputSchema = standardSchema<ImplementPrOutput>(
  (value) => {
    const record = asRecord(value, "implement PR output");
    return {
      threadReplies: asArray(record.threadReplies ?? [], "threadReplies").map(
        parseReply,
      ),
      newInlineComments: asArray(
        record.newInlineComments ?? [],
        "newInlineComments",
      ).map(parseInlineComment),
      topLevelComments: asArray(
        record.topLevelComments ?? [],
        "topLevelComments",
      ).map((comment) => ({
        body: asString(asRecord(comment, "top-level comment").body, "body"),
      })),
    };
  },
);

export const filterInlineComments = (
  comments: readonly InlineComment[],
  diffLines: Map<string, Set<number>>,
): InlineComment[] =>
  comments.filter((comment) => {
    const fileLines = diffLines.get(comment.path);
    if (!fileLines) {
      console.warn(
        `Dropping inline comment for ${comment.path}:${comment.line}; file is not in the diff.`,
      );
      return false;
    }
    if (!fileLines.has(comment.line)) {
      console.warn(
        `Dropping inline comment for ${comment.path}:${comment.line}; line is not in the diff hunks.`,
      );
      return false;
    }
    return true;
  });

export const filterReplies = (
  replies: readonly ThreadReply[],
  validReplyIds: Set<string>,
): ThreadReply[] =>
  replies.filter((reply) => {
    if (!validReplyIds.has(reply.commentId)) {
      console.warn(
        `Dropping reply for commentId=${reply.commentId}; it was not in fetched unresolved threads.`,
      );
      return false;
    }
    return true;
  });
