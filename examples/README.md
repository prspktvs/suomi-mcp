# Client configuration examples

The hosted server is the default option. Use these local configurations when
you want the server process to run on your machine.

Claude Desktop: merge claude_desktop_config.json into the client's MCP server
configuration.

Claude Code:

~~~sh
claude mcp add suomi-mcp -- npx -y @prspktvs/suomi-mcp
~~~

Cursor: use cursor.mcp.json.

VS Code: copy the mcp.servers object from vscode.mcp.json into workspace
settings.

For an optional catalog key or provider setting, add the relevant environment
variables to the server entry. Configuration details are in
packages/local/README.md.
