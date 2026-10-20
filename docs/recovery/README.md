# Interrupted one-tap work recovered on 2026-10-20

The original working tree survived. Ten changed/new source, test and migration
files were preserved without reconstruction in local commit
`7c0e130` on `recovery/lumi-one-tap-20261020`, based on `d695bc5`.
The complete git-format patch is `one-tap-20261020.patch` in this directory.
It is an inert recovery artifact; no application imports it and no migration
runner reads it. It contains unfinished work, not a production-ready release.

The original checkout remains at
`/workspace/scratch/3730901aea1e/content-factory-renderer`.
The transport migration uses the separate `lumi-direct-telegram` worktree.
The unrelated Supabase CLI temporary file was left intact in the original tree.
No stash was present. No reset, clean or discarded file was used.

Recovered scope: versioned proposal maximum, invalidation of grants bound to
the previous maximum, general plan approval, automatic quotes and contextual
one-tap UI, focused synthetic tests. The proposed SQL was tested offline during
the interrupted intervention, but was NEVER applied to staging. The complete
one-tap changes were neither published as executable code nor deployed.

Resume by inspecting this patch against current HEAD and applying it in an
isolated checkout with `git apply --3way`, resolving the small overlapping auth,
runtime and feedback changes. Do not apply blindly. Finish only affected tests.
The first unfinished task is validating the recovered plan/consent and preflight
rejection continuation, then publishing it separately. This transport migration
does not authorize applying the USD 0.375 change to Q42. Its durable proposal
still has maximum USD 0.3275; prior consent never covers a larger maximum.
