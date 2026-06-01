# Contributing

DynFlow is a TypeScript monorepo for agent workflow orchestration. Contributions
are welcome when they keep the runtime predictable, tested, and easy to review.

## Development Setup

```bash
npm install
npm run build
npm test
```

For local development:

```bash
npm run dev:server
npm run dev:web
```

The backend listens on `3001` by default and the Vite app listens on `5173`.

## Contribution Guidelines

- Keep changes focused and reviewable.
- Add or update tests for behavior changes.
- Prefer existing project patterns over new abstractions.
- Do not commit secrets, local databases, logs, or generated build output.
- Run `npm run build` and `npm test` before opening a pull request.

## Pull Request Checklist

- The change has a clear user or maintainer benefit.
- Relevant tests were added or updated.
- Public APIs and workflow behavior are documented when changed.
- The PR description includes verification evidence.

## Reporting Bugs

Please include:

- DynFlow version or commit SHA.
- Operating system and Node.js version.
- Steps to reproduce.
- Expected and actual behavior.
- Logs or stack traces when available.
