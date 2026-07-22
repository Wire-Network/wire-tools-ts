import type {
  RunEvidenceVerificationIssue,
  RunEvidenceVerificationIssueCode
} from "../runEvidenceVerifierTypes.js"

/** Mutable issue/check accumulator owned by one verifier invocation. */
export class RunEvidenceVerificationContext {
  private readonly issueEntries: RunEvidenceVerificationIssue[] = []
  private readonly checked = new Set<string>()

  /** Collect one evidence defect for deterministic final ordering. */
  issue(
    code: RunEvidenceVerificationIssueCode,
    path: string,
    detail: string
  ): void {
    this.issueEntries.push({ code, path, detail })
  }

  /** Record one successfully descriptor-read run-relative file. */
  checkedFile(path: string): void {
    this.checked.add(path)
  }

  /** Return issues sorted independently of filesystem enumeration order. */
  issues(): readonly RunEvidenceVerificationIssue[] {
    return this.issueEntries.slice().sort(compareIssues)
  }

  /** Return checked files in portable lexical order. */
  checkedFiles(): readonly string[] {
    return [...this.checked].sort()
  }
}

function compareIssues(
  left: RunEvidenceVerificationIssue,
  right: RunEvidenceVerificationIssue
): number {
  return (
    compareText(left.path, right.path) ||
    compareText(left.code, right.code) ||
    compareText(left.detail, right.detail)
  )
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
