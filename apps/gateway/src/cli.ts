import { buildGateway } from './server.js';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AccountStore } from './account-store.js';
import { AccountService } from './accounts.js';
import { SupportSqliteStore } from './support/store.js';
import type { SupportOptions } from './support/routes.js';

async function secret(name: string): Promise<string | undefined> {
  if (process.env[name]) return process.env[name];
  if (!process.env.CREDENTIALS_DIRECTORY) return undefined;
  try { return (await readFile(join(process.env.CREDENTIALS_DIRECTORY, name), 'utf8')).trim() || undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
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
  let accounts: AccountService | undefined;
  const clerkSecret = await secret('CLERK_SECRET_KEY');
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
  if (clerkSecret && publishableKey) {
    const path = process.env.KOMO_ACCOUNT_DB;
    if (!path) throw new Error('KOMO_ACCOUNT_DB must point to a persistent SQLite file outside release directories');
    await mkdir(dirname(path), { recursive: true });
    const publicOrigin = new URL(process.env.KOMO_PUBLIC_ORIGIN ?? 'https://komopdf.com').origin;
    accounts = new AccountService(new AccountStore(path), { secretKey: clerkSecret, publishableKey, publicOrigin,
      stripeKey: await secret('STRIPE_RESTRICTED_KEY'), stripePriceId: process.env.STRIPE_KOMO_PRICE_ID,
      stripePortalConfigurationId: process.env.STRIPE_KOMO_PORTAL_CONFIG_ID,
      webhookSecret: await secret('STRIPE_WEBHOOK_SECRET'), automaticTax: process.env.STRIPE_AUTOMATIC_TAX !== 'false' });
  }
  let support: SupportOptions | undefined;
  if (process.env.KOMO_SUPPORT_DB) {
    const supportCredential = await secret('ASSISTANT_LLM_API_KEY');
    const supportApiKey = supportCredential?.startsWith('{') ? (JSON.parse(supportCredential) as { api_key: string }).api_key : supportCredential || apiKey;
    await mkdir(dirname(process.env.KOMO_SUPPORT_DB), { recursive: true });
    support = { store: new SupportSqliteStore(process.env.KOMO_SUPPORT_DB), adminIds: (process.env.KOMO_SUPPORT_ADMIN_IDS || '').split(',').map(value => value.trim()).filter(Boolean),
      environment: { product: 'komopdf', appUrl: process.env.KOMO_PUBLIC_ORIGIN || 'https://komopdf.com',
        guide: 'komopdf is a free, local-first PDF editor for web, Windows and Mac. Open a PDF, use Edit to select and edit text/images, Insert for new elements, Comment for annotations, Pages to organize/import/extract/rotate pages, and File to save/export/print. Documents are processed locally. On the web use Download PDF; on desktop use Save. Undo/redo use Ctrl/Cmd Z and Ctrl/Cmd Shift Z. Desktop offers local OCR and Word export. The separate komo document assistant helps with PDF questions and edits. Connect KolmoPDF with your own API key to read/translate complete documents; its usage is billed to the KolmoPDF account separately. Basic non-AI editing tools are free. KOMO accounts receive 1,000 free credits; KOMO Plus costs USD4.99/month for active membership. Use Account for current balance and subscription management. For editor issues ask for operating system, product version, operation and steps. Direct account-specific issues to Contact support. Never ask for passwords, API keys or card details. This chat is customer support, not the PDF editing assistant. Routes: /help/ /account/ /pricing/ /download/.',
        baseUrl: process.env.ASSISTANT_LLM_BASE_URL, model: process.env.ASSISTANT_LLM_MODEL, apiKey: supportApiKey,
        smtpHost: process.env.SUPPORT_SMTP_HOST, smtpPort: process.env.SUPPORT_SMTP_PORT, smtpUser: process.env.SUPPORT_SMTP_USER, smtpPassword: await secret('SUPPORT_SMTP_PASSWORD'),
        from: process.env.SUPPORT_FROM_EMAIL, inbox: process.env.SUPPORT_TO_EMAIL || 'hello@komoai.llc' } };
  }
  const app = buildGateway({ config, apiKey, ...(accounts ? { accounts } : {}), ...(support ? { support } : {}) });
  app.addHook('onClose', async () => { accounts?.store.close(); support?.store.close(); });
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
