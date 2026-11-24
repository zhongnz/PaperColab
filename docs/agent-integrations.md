
# Optional model-independent agent integrations

The server does not need provider keys, an LLM SDK or MCP dependencies. The
optional client is a separate local process. The task capability is restricted
to the two delegated endpoints; the client accepts only numeric loopback
HTTP origins with an explicit port, disables redirects and ambient proxies,
and never forwards task credentials to a model.

## Configure a local task client

Create a delegated task as a project lead. Set PAPERCOLAB_URL (default
http://127.0.0.1:8787), PAPERCOLAB_TASK_ID and PAPERCOLAB_TASK_TOKEN in the
trusted process environment. Do not put real secrets in a committed config,
command history, logs or shared chat. The token expires after 24 hours and
permits one proposal.

```sh
python -m agents context
python -m agents draft --provider local --model YOUR_LOCAL_MODEL --output proposal.json
python -m agents submit proposal.json
```

Inspect the proposal before submission. Drafting never calls the submit
endpoint. The local adapter targets an OpenAI-compatible endpoint on
http://127.0.0.1:11434/v1/chat/completions (override only with a numeric
loopback PAPERCOLAB_LOCAL_MODEL_URL). The local model service must already be
running. It is outside PaperColab's trust boundary; check its own data policy.

For explicit remote use, set OPENAI_API_KEY or ANTHROPIC_API_KEY in the
trusted process environment. Use --provider openai or --provider anthropic,
--model YOUR_MODEL and --allow-remote. The flag explicitly authorises sending
the assigned manuscript cell and selected objects to that provider. Fixed
official API endpoints are used. Not all models support these request
parameters; compatibility, provider-specific usage accounting and pricing are
not yet tested. No live API was called in the regression suite.

## Standard MCP (stdio)

```sh
python -m pip install -r agents/requirements-mcp.txt
python -m agents.mcp_server
```

Configure a compatible local MCP host to start the above command with the
repository as its working directory and task-specific environment variables
supplied securely. One server process is bound to one task. Official MCP
Python SDK 2.3.0 is pinned as an optional top-level dependency; transitive lock
and supply-chain review remain open. The SDK provides protocol lifecycle
and tool discovery; there is no hand-written MCP transport. Exactly two tools:
read_assigned_context and submit_cell_proposal. A submission enters the
human review queue, not the manuscript. No broad project browsing, structural
changes, tool execution or remote MCP endpoint. The old /api/mcp dispatcher
remains a separate nonstandard interface.

MCP hosts can transmit tool results to their own models. PaperColab cannot
enforce their egress, retention or tool policies; only connect trusted hosts
with explicit authorisation for the assigned research context. The local
proposal file also contains manuscript content. Store it securely and delete
it when finished. Never interpret provider output as verified research.
Tests use fake model responses plus an actual stdio subprocess and local
HTTP task service; model-provider compatibility is unverified.
