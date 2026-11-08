# Third-party notices

SuperIntern is released under the MIT License (see `LICENSE`). Some parts are ported from third-party projects and stay under those projects' licenses. Each one is listed below.

## Aider

- Upstream: https://github.com/Aider-AI/aider
- License: Apache License 2.0. The full text is in `LICENSES/Apache-2.0.txt`.
- Copyright: Copyright Paul Gauthier and the Aider contributors.
- Upstream NOTICE file: none.
- Ported into: `src/core/repomap.mjs`. That file is marked `SPDX-License-Identifier: MIT AND Apache-2.0`.
  - The ranking algorithm and edge-weight rules come from `aider/repomap.py` (`get_ranked_tags`): personalized PageRank over the reference graph, the per-identifier multipliers, and the binary search that fits the map into a token budget.
  - The idea of a fixed list of "important files" comes from `aider/special.py`.
- Modifications:
  - Rewritten as a dependency-free ES module.
  - tree-sitter tag extraction is replaced with per-language regular expressions. When Universal Ctags is installed on the host, it is used instead.
  - References are approximated by counting identifiers.
  - The important-file list is trimmed.
  - Each definition is rendered as a single signature line, without tree context.
  - Tags are cached per git blob id.
