# Known limitations

[中文](known-limits.md) | **English**

This page has two parts:

- **Evidence gaps:** areas our current validation does not extend to;
- **Feature boundaries:** things deliberately left out, or implemented only in a minimal form.

Each item tries to say when you will run into it and how to work around it.

## Evidence gaps

1. **Requester sign-off has only automated test coverage.** When the requester is on the sign-off list, the owner's approval counts as one vote and the system must still wait for the requester to sign off in person. This rule has not been validated in real multi-user use. If sign-off stays pending, first check whether it is waiting for the requester.
2. **Live validation used only a few models:** DeepSeek, and Kimi called through OpenRouter. Anthropic, OpenAI and Gemini have only adapter-level validation (single-turn conversation and tool-call loops). Evidence that the agent asks questions, the reviewer sends work back and corrections go through comes from the first two. Try a small task before switching vendors.
3. **Only small projects have been validated.** The largest samples were medium-sized open-source libraries (a few thousand lines) and small applications built from scratch. There are no multi-day tasks and no large repositories. Only Node and Python have been validated.
4. **There is no long-term real-team data for multi-user collaboration.** Multi-user flows were validated only through simulated use. How often a real team would be interrupted or misrouted over a week is unknown.

## Feature boundaries

1. **Access and authentication**
   - **Local mode (default):** the web UI listens only on 127.0.0.1. Requests without a token act as the administrator who started the web UI, so other local processes can also call the API as that administrator. The server checks `Host` and origin; this protects against other websites using your browser to send requests, not against local processes.
   - **Team mode:** intended for intranets, not the public internet. For what it protects against and what it does not, see [Team deployment](deploy-team.en.md).
2. **Notifications are one-way:** ntfy, Feishu, DingTalk and WeCom can only push notifications; users cannot answer directly inside them. Return to the web UI or use the CLI to answer.
3. **Context compaction is a safety net, not the normal path:** when a single request passes the "Automatic compaction line" (120k tokens by default), the system first removes old tool outputs, and if that is not enough, has the model write a brief and rebuilds the context from it. The brief loses details; if one step still does not fit after two compactions, the system suggests splitting the step. The context limit is 150k tokens by default, and models with a context window recorded in the catalog are also capped by that window. When binding a model with a small window, lower the limit under "Budget & limits"; the compaction line is then pushed down to 80% of the limit.
4. **There is no retrieval layer:** the agent understands the repository with grep and by reading files. With a large repository, the context runs out first.
5. **There are only two sandbox images:** Node, and Python (with Chromium for screenshots). The agent must install dependencies for other languages inside the sandbox itself (the project must allow the corresponding network domains). Podman and rootless Docker have not been validated.
6. **Page checks have limits:** page screenshots before sign-off capture only the page right after it finishes loading. When the reviewer checks the running app, it can open pages, click, type and select, but drag and drop, hover menus, file uploads and multiple tabs are not supported. It needs the Python sandbox image with Chromium and `si-preview.json` at the repository root. Only models marked vision get screenshots; models you add to the catalog yourself are always treated as not accepting images.
7. **Test protection recognizes only three languages:** the handoff comparison of "were pre-existing tests weakened" recognizes JavaScript, Python and Go test styles; test changes in other languages are not flagged. "Send back directly when tests are weakened" can currently be turned on only from the CLI.
8. **Prices are estimates:** costs use the prices recorded in the model catalog. DeepSeek is recorded at peak prices, so off-peak usage actually costs less. The vendor's bill is authoritative.
9. **Conflict detection covers one item at a time:** if two people's answers to different questions contradict each other semantically (A's answer to Q1 implies X, B's answer to Q2 implies not-X), the system does not detect it.
10. **Task dependencies cannot be changed in the UI once created:** dependencies and ordering can be specified when adding a task, but there is no UI for editing dependencies between existing tasks.
11. **To-do digests are minimal:** similar questions are not merged. Duty handover follows the rotation plus covers (someone covers whole days); holidays affect only "1bd" and do not pause the duty roster. The rotation list cannot be reordered by dragging; remove people and add them again instead.
12. **WSL2 does not stay running on its own:** a WSL2 distribution does not start at Windows login and stops soon after the last session exits. See [WSL2 notes](deploy-linux.en.md#wsl2-notes) for keeping it running.
13. **Language boundaries:** the web UI, CLI, item content and AI text written for people support Chinese and English, with a few things to know:
    - **Content language is deployment-wide:** a team has only one content language (item content, reports and so on); each person can choose only their own interface language. Changing the content language affects only content written afterwards; existing items keep their original language.
    - **When the interface and content languages differ**, some error messages contain content-language fragments (the error's wrapper is in your language; names quoted inside it are in the content language).
    - **Model prompts are still in Chinese**, ending with an instruction to "write text intended for people in English". English output depends on the model following that instruction; live validation was done mainly in Chinese.
    - A few CLI diagnostic reports (replay, the permissions overview, the model catalog check) still output Chinese.
    - The README, the deployment guides and the known limitations have English versions; some other text in the repository is still in Chinese.
