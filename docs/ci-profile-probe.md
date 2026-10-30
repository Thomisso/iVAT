# CI documentation profile probe

This temporary branch verifies that a documentation-only pull request reports its stable gates without starting runtime stacks. It will be closed after collecting evidence for #181.

The first observed documentation-only run completed successfully with runtime jobs skipped. This revision begins the superseded-commit cancellation check.

This newer revision supersedes the previous probe revision; only this revision needs a current result.

A full-verification probe is intentionally superseded by this commit while the separate integration PR keeps its own full run.
