You are working on a project that stores cold objects in s3, warm objects on disk, and hot objects in memory. It serves APIs for library consumers to use.

## Package management
- Use bun for package management (bun install)
- Use npm run test to test
- Use npm run lint to lint
- Use npm run check to typecheck

Please test and typecheck always whenever you think you are done.

## Code style
- Use tabs for indentation, spaces allowed for diagrams in comments
- Use single quotes and add trailing commas
- Use template literals for user-facing strings and error messages

## Commenting
Add JSDoc comments to all new exported functions, methods, classes, fields, and enums
JSDoc should include proper annotations:
- use @param for parameters (no dashes after param names)
- use @returns for return values
- use @throws for exceptions when applicable
- keep descriptions concise but informative

## Misc
the .research/ directory serves as a workspace for temporary experiments, analysis, and planning materials. create it if necessary (it's gitignored). this directory may contain cloned repositories or other reference materials that can help inform implementation decisions

**don't make assumptions or speculate about code, plans, or requirements without exploring first; pause and ask for clarification when you're still unsure after looking into it**