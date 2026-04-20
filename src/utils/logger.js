
function writeLine(payload) {
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

export const logger = {
  info(message, meta = {}) {
    writeLine({ ts: new Date().toISOString(), level: 'info', message, ...meta });
  },
  warn(message, meta = {}) {
    writeLine({ ts: new Date().toISOString(), level: 'warn', message, ...meta });
  },
  error(message, meta = {}) {
    writeLine({ ts: new Date().toISOString(), level: 'error', message, ...meta });
  },

  toolCall(toolName, args) {
    writeLine({
      ts: new Date().toISOString(),
      level: 'info',
      message: 'mcp.tool.call',
      tool: toolName,
      args,
    });
  },
  
  jiraRequest(method, url, meta = {}) {
    writeLine({
      ts: new Date().toISOString(),
      level: 'info',
      message: 'jira.request',
      method,
      url,
      ...meta,
    });
  },
};
