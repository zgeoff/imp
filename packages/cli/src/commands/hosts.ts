import { ORPCError } from '@impz/client';
import { isHttpUrl } from '../cli-config';
import type { CommandIO } from '../command-io';
import { createImpClient } from '../create-imp-client';
import { defineCommand, defineGroup } from '../define-command';
import { formatJson, formatTable } from '../format-output';
import { checkHostName, readHostConfig, writeHostConfig } from '../host-store';
import type { HostConfig } from '../host-store';
import { buildTokenTerminal, readToken } from '../read-token';
import { UsageError } from '../usage-error';
import { jsonArg } from './common-args';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

interface LoginOptions {
  readonly url: string;
  readonly name: string | null;
  readonly verify: boolean;
  readonly readToken: () => Promise<string>;
}

// Saves a host and makes it current. Every check (a damaged config, an
// empty token, a refused token, an impd out of reach) comes before the
// write, so a failed login never changes config.json.
async function runLogin(io: CommandIO, options: LoginOptions): Promise<string> {
  if (!isHttpUrl(options.url)) {
    throw new UsageError(`not an http(s) URL: ${options.url}`);
  }

  const url = new URL(options.url);

  const name = checkHostName(options.name ?? url.hostname.split('.')[0] ?? '');

  readHostConfig(io.env, io.printError);

  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    io.printError(
      `impz: warning: ${options.url} is plain http; the token crosses the network unencrypted`,
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
  const config = readHostConfig(io.env, io.printError);

  writeHostConfig(
    io.env,
    { current: name, hosts: { ...config.hosts, [name]: { url: options.url, token } } },
    io.printError,
  );

  return name;
}

export const loginCommand = defineCommand({
  name: 'login',
  description: 'Save an impd and its token, and make it the current host',
  args: {
    url: {
      type: 'positional',
      description: 'impd URL, e.g. https://imp.example.ts.net',
      required: true,
    },
    name: { type: 'string', description: "host name (default: the URL's first label)" },
    verify: {
      type: 'boolean',
      negatable: true,
      description: 'check the token with impd first (--no-verify skips it)',
      default: true,
    },
  },
  run: async (ctx) => {
    const io = ctx.extensions.impz.io;

    const name = await runLogin(io, {
      url: ctx.values.url,
      name: ctx.values.name ?? null,
      verify: ctx.values.verify,
      readToken: () => readToken('token: ', buildTokenTerminal(io)),
    });

    io.print(`logged in to ${ctx.values.url} as ${name}, now the current host`);
  },
});

const lsCommand = defineCommand({
  name: 'ls',
  description: 'List saved hosts; * marks the current one',
  args: { json: jsonArg },
  run: (ctx) => {
    ctx.extensions.impz.io.print(
      formatHosts(
        readHostConfig(ctx.extensions.impz.io.env, ctx.extensions.impz.io.printError),
        ctx.values.json === true,
      ),
    );
  },
});

const useCommand = defineCommand({
  name: 'use',
  description: 'Make a saved host the current one',
  args: { name: { type: 'positional', description: 'host name', required: true } },
  run: (ctx) => {
    const io = ctx.extensions.impz.io;
    const config = readHostConfig(io.env, io.printError);
    const name = requireHost(config, ctx.values.name);

    writeHostConfig(io.env, { ...config, current: name }, io.printError);
  },
});

const rmCommand = defineCommand({
  name: 'rm',
  description: 'Forget a saved host and its token',
  args: { name: { type: 'positional', description: 'host name', required: true } },
  run: (ctx) => {
    const io = ctx.extensions.impz.io;
    const config = readHostConfig(io.env, io.printError);
    const name = requireHost(config, ctx.values.name);
    const hosts = Object.fromEntries(Object.entries(config.hosts).filter(([key]) => key !== name));

    writeHostConfig(
      io.env,
      { current: config.current === name ? null : config.current, hosts },
      io.printError,
    );
  },
});

export const hostCommand = defineGroup({
  name: 'host',
  description: 'Manage saved impd hosts (see also impz login)',
  subCommands: { ls: lsCommand, use: useCommand, rm: rmCommand },
});

export const hostsCommand = defineCommand({
  name: 'hosts',
  description: 'List saved hosts (impz host ls)',
  args: { json: jsonArg },
  run: (ctx) => {
    ctx.extensions.impz.io.print(
      formatHosts(
        readHostConfig(ctx.extensions.impz.io.env, ctx.extensions.impz.io.printError),
        ctx.values.json === true,
      ),
    );
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
    throw new UsageError(`no saved host ${name} (see impz host ls)`);
  }

  return name;
}
