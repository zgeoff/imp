import { ORPCError } from '@orpc/client';
import { isHttpUrl } from '../cli-config';
import { createImpClient } from '../create-imp-client';
import { defineCommand } from '../define-command';
import { formatJson, formatTable } from '../format-output';
import { checkHostName, readHostConfig, writeHostConfig } from '../host-store';
import type { CliEnv, HostConfig } from '../host-store';
import { PromptCancelledError, readToken } from '../read-token';
import { printError } from '../run-action';
import { UsageError } from '../usage-error';
import { jsonArg } from './common-args';

// 128 + SIGINT, as a shell reports a Ctrl-C
const CANCELLED_CODE = 130;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

interface LoginOptions {
  readonly url: string;
  readonly name: string | null;
  readonly verify: boolean;
  readonly readToken: () => Promise<string>;
  readonly warn: (message: string) => void;
}

// Saves a host and makes it current. Every check (a damaged config, an
// empty token, a refused token, an impd out of reach) comes before the
// write, so a failed login never changes config.json.
async function runLogin(env: CliEnv, options: LoginOptions): Promise<string> {
  if (!isHttpUrl(options.url)) {
    throw new UsageError(`not an http(s) URL: ${options.url}`);
  }

  const url = new URL(options.url);

  const name = checkHostName(options.name ?? url.hostname.split('.')[0] ?? '');

  readHostConfig(env);

  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    options.warn(
      `warning: ${options.url} is plain http; the token crosses the network unencrypted`,
    );
  }

  const token = await options.readToken();

  if (token === '') {
    throw new UsageError('no token given; nothing saved');
  }

  if (options.verify) {
    await verifyToken(options.url, token);
  }

  // read again after the prompt; two logins at the same moment can still
  // lose one host, as the config has no lock
  const config = readHostConfig(env);

  writeHostConfig(env, {
    current: name,
    hosts: { ...config.hosts, [name]: { url: options.url, token } },
  });

  return name;
}

export const loginCommand = defineCommand({
  meta: { name: 'login', description: 'Save an impd and its token, and make it the current host' },
  args: {
    url: {
      type: 'positional',
      description: 'impd URL, e.g. https://imp.example.ts.net',
      required: true,
    },
    name: { type: 'string', description: "host name (default: the URL's first label)" },
    verify: {
      type: 'boolean',
      description: 'check the token with impd first (--no-verify skips it)',
      default: true,
    },
  },
  run: async (context) => {
    try {
      const name = await runLogin(process.env, {
        url: context.args.url,
        name: context.args.name ?? null,
        verify: context.args.verify,
        readToken: () => readToken(),
        warn: (message) => {
          console.error(`imp: ${message}`);
        },
      });

      console.log(`logged in to ${context.args.url} as ${name}, now the current host`);
    } catch (error) {
      if (error instanceof PromptCancelledError) {
        process.exitCode = CANCELLED_CODE;

        return;
      }

      printError(error);
    }
  },
});

const lsCommand = defineCommand({
  meta: { name: 'ls', description: 'List saved hosts; * marks the current one' },
  args: { json: jsonArg },
  run: (context) => {
    listHosts(context.args.json === true);
  },
});

const useCommand = defineCommand({
  meta: { name: 'use', description: 'Make a saved host the current one' },
  args: { name: { type: 'positional', description: 'host name', required: true } },
  run: (context) => {
    runLocal((env) => {
      const config = readHostConfig(env);
      const name = requireHost(config, context.args.name);

      writeHostConfig(env, { ...config, current: name });
    });
  },
});

const rmCommand = defineCommand({
  meta: { name: 'rm', description: 'Forget a saved host and its token' },
  args: { name: { type: 'positional', description: 'host name', required: true } },
  run: (context) => {
    runLocal((env) => {
      const config = readHostConfig(env);
      const name = requireHost(config, context.args.name);

      const hosts = Object.fromEntries(
        Object.entries(config.hosts).filter(([key]) => key !== name),
      );

      writeHostConfig(env, { current: config.current === name ? null : config.current, hosts });
    });
  },
});

export const hostCommand = defineCommand({
  meta: { name: 'host', description: 'Manage saved impd hosts (see also imp login)' },
  subCommands: { ls: lsCommand, use: useCommand, rm: rmCommand },
});

export const hostsCommand = defineCommand({
  meta: { name: 'hosts', description: 'List saved hosts (imp host ls)' },
  args: { json: jsonArg },
  run: (context) => {
    listHosts(context.args.json === true);
  },
});

// The table never shows a token, only whether one is saved: `imp hosts`
// output ends up in terminals, logs and screenshots.
function formatHosts(config: HostConfig, json: boolean): string {
  const hosts = Object.entries(config.hosts).map(([name, host]) => ({
    name,
    url: host.url,
    current: name === config.current,
    hasToken: host.token !== null,
  }));

  if (json) {
    return formatJson(hosts);
  }

  return formatTable(
    ['', 'NAME', 'URL', 'TOKEN'],
    hosts.map((host) => [
      host.current ? '*' : '',
      host.name,
      host.url,
      host.hasToken ? 'saved' : 'none',
    ]),
  );
}

function listHosts(json: boolean): void {
  runLocal((env) => {
    console.log(formatHosts(readHostConfig(env), json));
  });
}

async function verifyToken(url: string, token: string): Promise<void> {
  try {
    await createImpClient({ url, token }).system.info();
  } catch (error) {
    if (error instanceof ORPCError && error.status === 401) {
      throw new Error(`${url} refused the token; nothing saved`, { cause: error });
    }

    const reason = error instanceof Error ? error.message : String(error);

    throw new Error(`cannot check the token with ${url}: ${reason}; nothing saved`, {
      cause: error,
    });
  }
}

function requireHost(config: HostConfig, name: string): string {
  if (config.hosts[name] === undefined) {
    throw new UsageError(`no saved host ${name} (see imp host ls)`);
  }

  return name;
}

function runLocal(action: (env: CliEnv) => void): void {
  try {
    action(process.env);
  } catch (error) {
    printError(error);
  }
}
