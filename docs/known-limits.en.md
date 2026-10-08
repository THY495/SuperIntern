# Known limitations

[中文](known-limits.md) | **English**

This page separates gaps in the available validation evidence from features that are deliberately absent or implemented only in a basic form. Each item describes when the limitation matters and a workaround where one is available.

## Evidence gaps

1. **Requester sign-off has only automated test coverage.** When the requester is on the sign-off list, the owner's approval counts as one vote and the system must still wait for the requester. This rule has not been validated in real multi-user use. If sign-off stays pending, check whether it is waiting for the requester.
2. **Most live validation used DeepSeek.** Anthropic, OpenAI and Gemini have only adapter-level validation: single-turn conversation and tool-call loops. Evidence that the agent asks questions, the reviewer sends work back and corrections complete comes from DeepSeek runs. Try a small task before switching vendors.
3. **Only small projects have been validated.** The largest samples were medium-sized open-source libraries of a few thousand lines and small applications built from scratch. There are no multi-day tasks or large-repository samples. Only Node and Python have been validated.
4. **There is no long-term real-team data.** Multi-user flows were tested through simulated use. The interruption rate and routing error rate over a week of real team use are unknown.

## Feature boundaries

1. **Access and authentication:** local mode listens only on 127.0.0.1. Requests without a token act as the administrator who started the web UI, so other local processes can call the API as that administrator. Host and origin checks protect against other websites using your browser to send requests, rather than local processes. Team mode is intended for intranets; see [Team deployment](deploy-team.en.md) for its protection boundaries.
2. **Notifications are one-way:** ntfy, Feishu, DingTalk and WeCom can send notifications, but users cannot answer directly inside them. Return to the web UI or CLI to answer.
3. **Context is not compressed:** each request has a context limit, 150k tokens by default. Models with a context window recorded in the catalog are also capped by that window. When binding a model with a small window, lower the context limit under Budget and limits.
4. **There is no retrieval layer:** the agent understands the repository by searching and reading files. Large repositories can exhaust the context budget first.
5. **There are only two sandbox image types:** Node, and Python with Chromium for screenshots. The agent must install dependencies for other languages inside the sandbox, requiring the relevant network domains to be allowed for the project. Podman and rootless Docker have not been validated.
6. **Page screenshots are basic:** they capture the page after initial loading, without clicking buttons or filling in forms.
7. **Prices are estimates:** costs use the prices recorded in the model catalog. DeepSeek uses peak prices, so off-peak usage costs less. The vendor's bill is authoritative.
8. **Conflict detection covers one item at a time:** semantically contradictory answers to separate questions are not detected, such as one person's answer to Q1 implying X and another person's answer to Q2 implying not-X.
9. **Existing task dependencies cannot be edited in the UI:** dependencies and ordering can be specified when adding a task, but there is no UI for changing or removing dependencies between existing tasks.
10. **To-do digests are basic:** similar questions are not grouped. Duty handover supports weekly rotation only, without holidays or temporary shift changes.
11. **WSL2 does not stay running on its own in the validated setup:** the distribution does not start at Windows login and stops shortly after the last session exits. See [WSL2 notes](deploy-linux.en.md#wsl2-notes) for keeping it running.
12. **Language boundaries:** the web UI, CLI, item content and AI text for people support English and Chinese, with these limits:
    - **Content language is deployment-wide:** a team has one content language for items and reports. Each person can choose their interface language. Changing content language affects newly written content; existing items retain their original language.
    - **Mixed-language error details:** if interface and content languages differ, error messages may contain content-language fragments, such as quoted names, inside an interface-language message.
    - **Model prompts remain Chinese:** a final instruction asks for text intended for people to be in English. English output depends on the model following it; most live validation used Chinese.
    - Some CLI diagnostic reports, including replay, permission summaries and catalog checks, still output Chinese.
    - The README and deployment / limitations guides have English versions. Some other repository text remains Chinese.
