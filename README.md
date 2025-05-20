<p align=center>
  Universal Transport SDK for EasyLayer Apps.
</p>
<br>
<p align=center>
  <a href="https://www.npmjs.com/package/@easylayer/transport-sdk"><img alt="npm version" src="https://img.shields.io/npm/v/@easylayer/transport-sdk.svg?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/@easylayer/transport-sdk"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@easylayer/transport-sdk.svg?style=flat-square"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/github/license/easylayer/transport-sdk?style=flat-square"></a>
</p>

---

<p align="center">
  <a href="https://easylayer.io">Website</a> | <a href="https://easylayer.io/docs">Docs</a> | <a href="https://github.com/easylayer/website/discussions">Discussions</a>
</p>

---

# EasyLayer Transport SDK

A lightweight, universal SDK for integrating any client (Node.js, browser, or service) with EasyLayer-based applications. 
Provides a unified interface for sending requests and subscribing to events over different transport protocols (HTTP, IPC). 
- Sending typed requests to your easylayer app
- Subscribing to custom events
- Switching transports without changing your business logic

## Table of Contents

- [Developer Setup](#developer-setup)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Issue Reporting](#issue-reporting)
- [License](#license)

---

## Developer Setup

1. **Clone the repository:**
```bash
git clone https://github.com/easylayer/transport-sdk.git
cd transport-sdk
```

2. **Install dependencies:**
```bash
yarn install
```

3. **Build the SDK:**
```bash
yarn build
```

4. **Run tests:**
```bash
yarn test:unit
```

5. **Lint and format:**
```bash
yarn lint
# or
yarn lint:fix
```

---

## Documentation

All released documentation versions are available in the [`docs/`](./docs/) folder.

---

## Contributing

We welcome contributions! To get started:
- Fork this repository and create a new branch for your feature or bugfix.
- Make your changes and ensure all tests and lints pass locally.
- Submit a pull request (PR) to the `development` branch.
- - All PRs must use the provided pull request template.
- - Branch names and commit messages must follow the [Conventional Changelog](https://www.conventionalcommits.org/) style. Allowed types: `feat`, `fix`, `infra`, `refactor`, `chore`, `BREAKING` (see `.czrc` for details). Please use descriptive messages for each commit.
- - All PRs are automatically checked by our GitHub Actions workflow (build, lint, unit tests).

## Issue Reporting

If you encounter a bug or have a feature request related to the `core` repository, please [open an issue](https://github.com/easylayer/transport-sdk/issues/new/choose) and provide as much detail as possible. For issues related to other EasyLayer projects, please use the appropriate repository.

## License

This project is licensed under the [MIT License](./LICENSE).