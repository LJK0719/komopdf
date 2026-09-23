import { buildGateway } from './server.js';
import { DEFAULT_CONFIG_PATH, loadGatewayConfig, readCredential } from './config.js';

type CliOptions = { host: string; port: number; configPath: string; credentialFile?: string };

function usage(): string {
  return 'Usage: pnpm --filter @pdf-editor/gateway start [--host 127.0.0.1] [--port 8787] [--config PATH] [--credential-file PATH]';
}

function parseArgs(args: string[]): CliOptions {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === '--help' || name === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (!name || !['--host', '--port', '--config', '--credential-file'].includes(name)) throw new Error(`Unknown argument: ${name ?? ''}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for argument ${name}`);
    values[name] = value;
    index += 1;
  }
  const host = values['--host'] ?? '127.0.0.1';
  if (!(host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host))) {
    throw new Error('--host only allows loopback addresses');
  }
  const port = Number(values['--port'] ?? '8787');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('--port must be an integer between 1 and 65535');
  return {
    host,
    port,
    configPath: values['--config'] ?? DEFAULT_CONFIG_PATH,
    ...(values['--credential-file'] ? { credentialFile: values['--credential-file'] } : {}),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadGatewayConfig(options.configPath);
  const apiKey = await readCredential(config, options.credentialFile);
  const app = buildGateway({ config, apiKey });
  const close = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  await app.listen({ host: options.host, port: options.port });
  process.stdout.write(`${JSON.stringify({ event: 'gateway_started', host: options.host, port: options.port, model: config.provider.model })}\n`);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : 'Launch failed';
  process.stderr.write(`Gateway failed to start: ${message}\n`);
  process.exitCode = 1;
});
