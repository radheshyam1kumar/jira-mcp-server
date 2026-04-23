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
  debug(message, meta = {}) {
    if (process.env.LOG_LEVEL === 'debug') {
      writeLine({ ts: new Date().toISOString(), level: 'debug', message, ...meta });
    }
  },
};
