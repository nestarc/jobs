# Administrator release gate — nestarc/jobs

Read-only before-state captured on 2026-09-05 against `https://github.com/nestarc/jobs`:

- Rulesets: `[]`.
- Main branch protection API: HTTP 404, `Branch not protected`.
- Environment `npm`: no protection rules, no deployment branch policy; admins can bypass.
- Authenticated repository administrator: `ksyq12`.
- No settings have been changed by the maintenance implementation.

A release is blocked until the maintainer reviews and applies the following concrete policy and records the resulting ruleset/environment IDs and API responses:

1. Protect main: require pull requests and the current quality/unit/lifecycle/Redis/consumer/coverage/package-smoke checks, block deletion and force pushes. Use the existing maintainer review process; this plan does not require appointing another person.
2. Protect `v*` tags: permit creation only through the release maintainer process, prohibit updates/deletions including force pushes. Release code verifies main ancestry and remote tag identity again.
3. Protect environment `npm`: restrict deployment to `v*` tags, use the existing maintainer approval policy, and document whether admin bypass is permitted. A separate reviewer is not a prerequisite. Validate the npm trusted-publisher repository/workflow/environment binding for `nestarc/jobs`, `.github/workflows/release.yml`, environment `npm`.
4. Enable GitHub private vulnerability reporting and verify that the designated owner receives private reports. CODEOWNERS uses the observed administrator account; changing ownership requires maintainer approval.

Required check names must be copied from a green run of the final workflow, not guessed from YAML matrix labels. The local workflow candidate now tests Node 22/24, Nest 10/11 and exact BullMQ 5.76.2/5.81.4. The npm trusted-publisher configuration cannot be proven from GitHub repository admin access alone.

Official Actions are pinned to the v4 tag commits observed on 2026-09-05: checkout `11d5960a326750d5838078e36cf38b85af677262`, setup-node `49933ea5288caeca8642d1e84afbd3f7d6820020`, download-artifact `d3f86a106a0bac45b974a628896c90dbdf5c8093`, upload-artifact `ea165f8d65b6e75b540449e92b4886f43607fa02`. Dependabot proposes pin updates for review. No third-party release action is needed.

The release workflow grants read-only permissions to verification/artifact checks, OIDC only to npm publish, and contents write only to GitHub Release creation. Consumer gates download the single package-smoke tarball. Existing-version reruns compare candidate SRI, attestation subject, tag and source SHA; differing bytes or lineage hard-fail. npm signature verification is mandatory before GitHub Release creation. The release artifact-policy job also queries GitHub and fails closed unless main is protected, v* tags have active no-bypass update/deletion rules, and npm has a tag-only deployment policy. This read-only gate currently fails on the observed before-state. Local workflow-policy tests cannot substitute for the administrator settings and actual publish evidence above.
